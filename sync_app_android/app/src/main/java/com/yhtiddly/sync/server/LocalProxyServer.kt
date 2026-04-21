package com.yhtiddly.sync.server

import android.util.Log
import fi.iki.elonen.NanoHTTPD
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import java.io.File
import java.util.concurrent.TimeUnit

/**
 * Local HTTP proxy server sitting between the WebView and the remote TiddlyWeb
 * server. Solves two problems at once:
 *
 *  1. **Same-origin sync.** The WebView loads `http://127.0.0.1:<port>/`, so
 *     TiddlyWiki's sync adapter issues relative requests (`/recipes/...`,
 *     `/bags/.../tiddlers/...`) against the same origin. No CORS, no
 *     `file://` origin weirdness, edit button works.
 *
 *  2. **Persistent HTML cache.** The root `/` response (the big 20 MB wiki
 *     HTML) is cached to disk. On subsequent launches the server serves the
 *     cached bytes immediately and refreshes the cache in the background.
 *
 * All other paths are proxied verbatim to the configured upstream, with an
 * injected Authorization header if credentials are configured.
 */
class LocalProxyServer(
    port: Int,
    private val remoteUrl: String,
    private val cacheFile: File,
    private val authHeader: String? = null
) : NanoHTTPD(port) {

    companion object {
        private const val TAG = "LocalProxyServer"
        private const val MIN_CACHE_SIZE = 1_000_000L // 1 MB

        // Hop-by-hop / content-negotiation headers we must not forward as-is.
        private val SKIP_REQ_HEADERS = setOf(
            "host", "connection", "content-length", "accept-encoding", "authorization"
        )
        private val SKIP_RESP_HEADERS = setOf(
            "content-length", "content-encoding", "transfer-encoding",
            "connection", "keep-alive", "content-type"
        )
        private val METHODS_WITH_BODY = setOf("POST", "PUT", "PATCH", "DELETE")
    }

    private val httpClient = OkHttpClient.Builder()
        .connectTimeout(30, TimeUnit.SECONDS)
        .readTimeout(120, TimeUnit.SECONDS)
        .build()

    private val rootFetchClient = OkHttpClient.Builder()
        .connectTimeout(30, TimeUnit.SECONDS)
        .readTimeout(600, TimeUnit.SECONDS) // 20 MB HTML can take a while
        .build()

    override fun serve(session: IHTTPSession): Response {
        val uri = session.uri
        val method = session.method.name
        return try {
            if ((uri == "/" || uri.isEmpty()) && method == "GET") {
                serveRoot(session)
            } else {
                proxy(session)
            }
        } catch (e: Exception) {
            Log.e(TAG, "Handler error: $method $uri", e)
            newFixedLengthResponse(
                Response.Status.INTERNAL_ERROR, "text/plain",
                "Proxy error: ${e.message}"
            )
        }
    }

    /**
     * Root handler: serve cached HTML if we have it, otherwise fetch from
     * upstream, cache, and serve. When serving from cache we kick off a
     * background refresh so the next launch sees fresh content.
     */
    private fun serveRoot(session: IHTTPSession): Response {
        if (cacheFile.exists() && cacheFile.length() > MIN_CACHE_SIZE) {
            Log.i(TAG, "Root: cache hit (${cacheFile.length() / 1024 / 1024} MB)")
            refreshCacheAsync()
            return newFixedLengthResponse(
                Response.Status.OK,
                "text/html; charset=utf-8",
                cacheFile.inputStream(),
                cacheFile.length()
            )
        }

        Log.i(TAG, "Root: cache miss, fetching $remoteUrl")
        val req = buildUpstreamRequest(remoteUrl, "GET", null, null, session.headers)
        val resp = rootFetchClient.newCall(req).execute()
        val bytes = resp.body?.bytes() ?: ByteArray(0)
        Log.i(TAG, "Root: fetched ${bytes.size / 1024} KB status=${resp.code}")

        if (resp.isSuccessful && bytes.size > MIN_CACHE_SIZE) {
            writeCacheAsync(bytes)
        }

        return newFixedLengthResponse(
            statusOf(resp.code),
            resp.header("content-type") ?: "text/html; charset=utf-8",
            bytes.inputStream(),
            bytes.size.toLong()
        )
    }

    /** Generic passthrough for API calls (GET/POST/PUT/DELETE/OPTIONS/etc). */
    private fun proxy(session: IHTTPSession): Response {
        val uri = session.uri
        val method = session.method.name
        val query = session.queryParameterString
            ?.takeIf { it.isNotEmpty() }
            ?.let { "?$it" } ?: ""
        val remoteUri = remoteUrl.trimEnd('/') + uri + query

        // Read exactly Content-Length bytes. Never call readBytes() — it blocks
        // until EOF, which only happens when the client closes the socket, so
        // POST/PUT hang forever.
        val contentLength = session.headers["content-length"]?.toIntOrNull() ?: 0
        val body = if (contentLength > 0) {
            val buf = ByteArray(contentLength)
            var off = 0
            while (off < contentLength) {
                val n = session.inputStream.read(buf, off, contentLength - off)
                if (n <= 0) break
                off += n
            }
            buf
        } else ByteArray(0)

        val contentType = session.headers["content-type"] ?: "application/octet-stream"
        val req = buildUpstreamRequest(remoteUri, method, body, contentType, session.headers)

        Log.d(TAG, "Proxy $method $uri -> $remoteUri (body=${body.size}B)")
        val resp = httpClient.newCall(req).execute()
        val respBytes = resp.body?.bytes() ?: ByteArray(0)
        val respCT = resp.header("content-type") ?: "application/octet-stream"
        Log.d(TAG, "Proxy response: ${resp.code} ct=$respCT len=${respBytes.size}")

        val out = newFixedLengthResponse(
            statusOf(resp.code),
            respCT,
            respBytes.inputStream(),
            respBytes.size.toLong()
        )
        for ((k, v) in resp.headers) {
            if (k.lowercase() !in SKIP_RESP_HEADERS) {
                out.addHeader(k, v)
            }
        }
        return out
    }

    private fun buildUpstreamRequest(
        url: String,
        method: String,
        body: ByteArray?,
        contentType: String?,
        incomingHeaders: Map<String, String>?
    ): Request {
        val b = Request.Builder().url(url)
        incomingHeaders?.forEach { (k, v) ->
            if (k.lowercase() !in SKIP_REQ_HEADERS) {
                b.header(k, v)
            }
        }
        // Inject upstream auth. The WebView sees a local HTTP server with no
        // auth challenge, we add Basic auth here when talking upstream.
        authHeader?.let { b.header("Authorization", it) }

        val reqBody = when {
            method in METHODS_WITH_BODY ->
                (body ?: ByteArray(0))
                    .toRequestBody((contentType ?: "application/octet-stream").toMediaType())
            else -> null
        }
        b.method(method, reqBody)
        return b.build()
    }

    private fun writeCacheAsync(bytes: ByteArray) {
        Thread {
            try {
                val parent = cacheFile.parentFile
                val tmp = File(parent, "${cacheFile.name}.tmp")
                tmp.writeBytes(bytes)
                if (cacheFile.exists()) cacheFile.delete()
                if (!tmp.renameTo(cacheFile)) {
                    cacheFile.writeBytes(bytes)
                    tmp.delete()
                }
                Log.i(TAG, "Cache written: ${cacheFile.length() / 1024 / 1024} MB")
            } catch (e: Exception) {
                Log.e(TAG, "Cache write failed", e)
            }
        }.start()
    }

    private fun refreshCacheAsync() {
        Thread {
            try {
                val req = buildUpstreamRequest(remoteUrl, "GET", null, null, null)
                val resp = rootFetchClient.newCall(req).execute()
                if (!resp.isSuccessful) {
                    Log.w(TAG, "Background refresh HTTP ${resp.code}")
                    return@Thread
                }
                val bytes = resp.body?.bytes() ?: return@Thread
                if (bytes.size > MIN_CACHE_SIZE) writeCacheAsync(bytes)
            } catch (e: Exception) {
                Log.w(TAG, "Background refresh failed: ${e.message}")
            }
        }.start()
    }

    /** NanoHTTPD only has presets for common codes; wrap any code in IStatus. */
    private fun statusOf(code: Int): Response.IStatus = object : Response.IStatus {
        override fun getRequestStatus(): Int = code
        override fun getDescription(): String = "$code"
    }
}

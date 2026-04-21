package com.yhtiddly.sync.server

import android.util.Log
import com.google.gson.Gson
import com.google.gson.JsonObject
import com.google.gson.JsonParser
import com.yhtiddly.sync.config.AppConfig
import com.yhtiddly.sync.data.AppDatabase
import com.yhtiddly.sync.data.HttpCacheEntity
import com.yhtiddly.sync.data.TiddlerEntity
import fi.iki.elonen.NanoHTTPD
import fi.iki.elonen.NanoHTTPD.Response.Status
import kotlinx.coroutines.runBlocking
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.MediaType.Companion.toMediaTypeOrNull
import java.io.File
import java.net.URLEncoder
import java.net.URLDecoder
import java.util.concurrent.TimeUnit

private const val TAG = "LocalServer"

private val LOADING_HTML = """<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta http-equiv="refresh" content="3;url=/">
<title>TW同步 - 加载中</title>
<style>
body{margin:0;display:flex;align-items:center;justify-content:center;
height:100vh;font-family:sans-serif;background:#1a6b5c;color:#fff;}
.box{text-align:center;padding:2em;}
h2{font-size:1.5em;margin-bottom:.5em;}
p{opacity:.8;margin:.3em 0;}
.spinner{width:40px;height:40px;border:4px solid rgba(255,255,255,.3);
border-top-color:#fff;border-radius:50%;animation:spin 1s linear infinite;margin:1.5em auto;}
@keyframes spin{to{transform:rotate(360deg)}}
</style></head>
<body><div class="box">
<div class="spinner"></div>
<h2>TW同步</h2>
<p>正在从服务器加载 TiddlyWiki…</p>
<p style="font-size:.85em;opacity:.6">首次加载需要一点时间，页面将自动刷新</p>
</div></body></html>""".trimIndent()

class LocalServer(port: Int, private val db: AppDatabase, private val cacheDir: java.io.File) : NanoHTTPD(port) {

    private val gson = Gson()
    private val isFetchingHtml = java.util.concurrent.atomic.AtomicBoolean(false)

    private val httpClient = OkHttpClient.Builder()
        .connectTimeout(30, TimeUnit.SECONDS)
        .readTimeout(120, TimeUnit.SECONDS)
        .writeTimeout(60, TimeUnit.SECONDS)
        .build()

    override fun serve(session: IHTTPSession): Response {
        val uri = session.uri ?: "/"
        val method = session.method ?: Method.GET

        return try {
            route(session, uri, method)
        } catch (e: Exception) {
            Log.e(TAG, "Error serving $method $uri", e)
            newFixedLengthResponse(Status.INTERNAL_ERROR, "text/plain", "Internal error: ${e.message}")
        }
    }

    private fun route(session: IHTTPSession, uri: String, method: Method): Response {
        // GET /status
        if (method == Method.GET && uri == "/status") {
            return serveStatus()
        }

        // GET /recipes/default/tiddlers.json
        if (method == Method.GET && uri == "/recipes/default/tiddlers.json") {
            return serveTiddlersFat()
        }

        // GET /recipes/default/tiddlers/:title
        val tiddlerGetMatch = Regex("^/recipes/default/tiddlers/(.+)$").matchEntire(uri)
        if (method == Method.GET && tiddlerGetMatch != null) {
            val title = decodeTitle(tiddlerGetMatch.groupValues[1])
            return serveSingleTiddler(title)
        }

        // PUT /recipes/default/tiddlers/:title
        val tiddlerPutMatch = Regex("^/recipes/default/tiddlers/(.+)$").matchEntire(uri)
        if (method == Method.PUT && tiddlerPutMatch != null) {
            val title = decodeTitle(tiddlerPutMatch.groupValues[1])
            return saveTiddler(session, title)
        }

        // DELETE /bags/default/tiddlers/:title
        val tiddlerDeleteMatch = Regex("^/bags/default/tiddlers/(.+)$").matchEntire(uri)
        if (method == Method.DELETE && tiddlerDeleteMatch != null) {
            val title = decodeTitle(tiddlerDeleteMatch.groupValues[1])
            return deleteTiddler(title)
        }

        // GET / -> serve cached HTML
        if (method == Method.GET && (uri == "/" || uri == "")) {
            return serveMainHtml(session, uri)
        }

        // Everything else -> proxy
        return proxyToRemote(session, uri, method)
    }

    // ---- Status ----

    private fun serveStatus(): Response {
        val cfg = AppConfig.get()
        val status = mapOf(
            "username" to (cfg.username.ifBlank { "" }),
            "anonymous" to cfg.username.isBlank(),
            "read_only" to false,
            "logout_is_available" to false,
            "space" to mapOf("recipe" to "default"),
            "tiddlywiki_version" to "5.3.8"
        )
        return jsonResponse(gson.toJson(status))
    }

    // ---- All tiddlers (fat — with text) ----

    private fun serveTiddlersFat(): Response {
        val tiddlers = runBlocking { db.tiddlerDao().getAll() }
        val result = tiddlers.map { entity -> entityToFieldsMap(entity) }
        val json = gson.toJson(result)
        return jsonResponse(json)
    }

    // ---- Single tiddler ----

    private fun serveSingleTiddler(title: String): Response {
        val entity = runBlocking { db.tiddlerDao().get(title) }
            ?: return newFixedLengthResponse(Status.NOT_FOUND, "text/plain", "Not found")
        val fields = entityToFieldsMap(entity)
        val json = gson.toJson(fields)
        val etag = buildEtag(title, entity.revision)
        val response = jsonResponse(json)
        response.addHeader("Etag", etag)
        return response
    }

    // ---- Save tiddler ----

    private fun saveTiddler(session: IHTTPSession, title: String): Response {
        val body = readBody(session)
        if (body.isBlank()) {
            return newFixedLengthResponse(Status.BAD_REQUEST, "text/plain", "Empty body")
        }

        val fieldsMap: MutableMap<String, Any?>
        try {
            val jsonElement = JsonParser.parseString(body)
            val obj = jsonElement.asJsonObject

            // Handle {fields:{...}} wrapper vs flat object
            val flatObj = if (obj.has("fields") && !obj.has("title")) {
                obj.getAsJsonObject("fields")
            } else {
                obj
            }

            fieldsMap = mutableMapOf()
            for ((k, v) in flatObj.entrySet()) {
                fieldsMap[k] = when {
                    v.isJsonPrimitive -> v.asString
                    v.isJsonArray -> {
                        val arr = v.asJsonArray
                        arr.map { it.asString }
                    }
                    v.isJsonNull -> null
                    else -> v.toString()
                }
            }
        } catch (e: Exception) {
            return newFixedLengthResponse(Status.BAD_REQUEST, "text/plain", "Invalid JSON: ${e.message}")
        }

        if (!fieldsMap.containsKey("title") || fieldsMap["title"] == null) {
            fieldsMap["title"] = title
        }

        if (!fieldsMap.containsKey("modified") || (fieldsMap["modified"] as? String).isNullOrBlank()) {
            fieldsMap["modified"] = java.time.Instant.now().toString()
        }

        val tiddlerTitle = fieldsMap["title"] as? String ?: title
        val tiddlerText = fieldsMap["text"] as? String ?: ""
        val tiddlerModified = fieldsMap["modified"] as? String ?: ""

        // Build headerJson (all fields except text)
        val headerMap = fieldsMap.filter { it.key != "text" }
        val headerJson = gson.toJson(headerMap)

        val revision = System.currentTimeMillis().toString()

        val existing = runBlocking { db.tiddlerDao().get(tiddlerTitle) }
        val entity = TiddlerEntity(
            title = tiddlerTitle,
            headerJson = headerJson,
            text = tiddlerText,
            revision = existing?.revision ?: "0",
            modified = tiddlerModified,
            dirty = 1,
            tombstone = 0,
            lastSynced = existing?.lastSynced ?: 0L
        )

        runBlocking { db.tiddlerDao().upsert(entity) }

        val etag = buildEtag(tiddlerTitle, revision)
        val response = newFixedLengthResponse(Status.NO_CONTENT, "text/plain", "")
        response.addHeader("Etag", etag)
        return response
    }

    // ---- Delete tiddler ----

    private fun deleteTiddler(title: String): Response {
        val modified = java.time.Instant.now().toString()
        runBlocking {
            val existing = db.tiddlerDao().get(title)
            if (existing != null) {
                db.tiddlerDao().markTombstone(title, modified)
            }
        }
        return newFixedLengthResponse(Status.NO_CONTENT, "text/plain", "")
    }

    // ---- Main HTML (serve cached or fetch + inject patch) ----

    // ---- File-backed body helpers ----

    private fun bodyFile(url: String): java.io.File {
        val safe = url.replace(Regex("[^a-zA-Z0-9._-]"), "_").take(80)
        return java.io.File(cacheDir, "hc_$safe.bin")
    }

    private fun writeBody(url: String, bytes: ByteArray): String {
        cacheDir.mkdirs()
        val f = bodyFile(url)
        f.writeBytes(bytes)
        return f.absolutePath
    }

    private fun readBody(path: String): ByteArray? =
        try { java.io.File(path).readBytes() } catch (e: Exception) { null }

    // ---- Main HTML serving ----

    private fun serveMainHtml(session: IHTTPSession, uri: String): Response {
        val cacheKey = "/"
        val cached = runBlocking { db.httpCacheDao().get(cacheKey) }
        val now = System.currentTimeMillis()
        val REVALIDATE_AFTER = 10 * 60 * 1000L

        if (cached != null) {
            val bodyBytes = readBody(cached.bodyPath)
            if (bodyBytes != null) {
                // Schedule background revalidation if stale (fire-and-forget)
                if (now - cached.updatedAt > REVALIDATE_AFTER) {
                    Thread {
                        try { revalidateHtmlCache(cacheKey, cached.etag, cached.lastModified) }
                        catch (e: Exception) { Log.w(TAG, "Background revalidation failed", e) }
                    }.start()
                }
                val html = bodyBytes.toString(Charsets.UTF_8)
                val patched = injectPatch(html)
                val bytes = patched.toByteArray(Charsets.UTF_8)
                return newFixedLengthResponse(Status.OK, "text/html; charset=utf-8", bytes.inputStream(), bytes.size.toLong())
            }
        }

        // Not cached: kick off background fetch, return loading page immediately
        if (isFetchingHtml.compareAndSet(false, true)) {
            Log.i(TAG, "HTML not cached — fetching from remote in background")
            Thread {
                try { fetchAndCacheHtml(cacheKey) }
                catch (e: Exception) { Log.e(TAG, "Background HTML fetch failed", e) }
                finally { isFetchingHtml.set(false) }
            }.start()
        }
        val bytes = LOADING_HTML.toByteArray(Charsets.UTF_8)
        return newFixedLengthResponse(Status.OK, "text/html; charset=utf-8",
            bytes.inputStream(), bytes.size.toLong())
    }

    private fun revalidateHtmlCache(cacheKey: String, etag: String?, lastModified: String?) {
        val cfg = AppConfig.get()
        if (cfg.remoteUrl.isBlank()) return

        val reqBuilder = Request.Builder().url(cfg.remoteUrl + "/")
        AppConfig.authHeader()?.let { reqBuilder.header("Authorization", it) }
        if (!etag.isNullOrBlank()) reqBuilder.header("If-None-Match", etag)
        if (!lastModified.isNullOrBlank()) reqBuilder.header("If-Modified-Since", lastModified)

        val response = httpClient.newCall(reqBuilder.build()).execute()
        response.use { resp ->
            if (resp.code == 304) {
                // Bump updatedAt only
                val existing = runBlocking { db.httpCacheDao().get(cacheKey) }
                if (existing != null) {
                    runBlocking {
                        db.httpCacheDao().put(existing.copy(updatedAt = System.currentTimeMillis()))
                    }
                }
            } else if (resp.code == 200) {
                val body = resp.body?.bytes() ?: return
                val headersJson = buildHeadersJson(resp.headers)
                val newEtag = resp.header("Etag")
                val newLastMod = resp.header("Last-Modified")
                val path = writeBody(cacheKey, body)
                runBlocking {
                    db.httpCacheDao().put(
                        HttpCacheEntity(
                            url = cacheKey,
                            status = 200,
                            headers = headersJson,
                            bodyPath = path,
                            etag = newEtag,
                            lastModified = newLastMod,
                            updatedAt = System.currentTimeMillis()
                        )
                    )
                }
            }
        }
    }

    private fun fetchAndCacheHtml(cacheKey: String): Response {
        val cfg = AppConfig.get()
        if (cfg.remoteUrl.isBlank()) {
            val msg = "未配置远程 URL，请在设置中填写。"
            val bytes = msg.toByteArray(Charsets.UTF_8)
            return newFixedLengthResponse(Status.SERVICE_UNAVAILABLE, "text/plain; charset=utf-8",
                bytes.inputStream(), bytes.size.toLong())
        }

        return try {
            val reqBuilder = Request.Builder().url(cfg.remoteUrl + "/")
            AppConfig.authHeader()?.let { reqBuilder.header("Authorization", it) }
            reqBuilder.header("Accept", "text/html,*/*")

            val response = httpClient.newCall(reqBuilder.build()).execute()
            response.use { resp ->
                if (!resp.isSuccessful) {
                    val msg = "Remote returned HTTP ${resp.code}"
                    return newFixedLengthResponse(Status.INTERNAL_ERROR, "text/plain", msg)
                }

                val bodyBytes = resp.body?.bytes() ?: byteArrayOf()
                val headersJson = buildHeadersJson(resp.headers)
                val etag = resp.header("Etag")
                val lastMod = resp.header("Last-Modified")
                val path = writeBody(cacheKey, bodyBytes)

                runBlocking {
                    db.httpCacheDao().put(
                        HttpCacheEntity(
                            url = cacheKey,
                            status = 200,
                            headers = headersJson,
                            bodyPath = path,
                            etag = etag,
                            lastModified = lastMod,
                            updatedAt = System.currentTimeMillis()
                        )
                    )
                }

                val html = bodyBytes.toString(Charsets.UTF_8)
                val patched = injectPatch(html)
                val bytes = patched.toByteArray(Charsets.UTF_8)
                newFixedLengthResponse(Status.OK, "text/html; charset=utf-8", bytes.inputStream(), bytes.size.toLong())
            }
        } catch (e: Exception) {
            Log.e(TAG, "Failed to fetch HTML from remote", e)
            // Try stale cache as last resort
            val stale = runBlocking { db.httpCacheDao().get(cacheKey) }
            if (stale != null) {
                val staleBytes = readBody(stale.bodyPath)
                if (staleBytes != null) {
                    Log.w(TAG, "Serving stale cache as fallback")
                    val html = staleBytes.toString(Charsets.UTF_8)
                    val patched = injectPatch(html)
                    val bytes = patched.toByteArray(Charsets.UTF_8)
                    return newFixedLengthResponse(Status.OK, "text/html; charset=utf-8", bytes.inputStream(), bytes.size.toLong())
                }
            }
            val msg = "代理错误: ${e.message}\n\n远程服务器响应过慢或不可达。请检查网络或设置中的 URL。"
            val bytes = msg.toByteArray(Charsets.UTF_8)
            newFixedLengthResponse(Status.INTERNAL_ERROR, "text/plain; charset=utf-8", bytes.inputStream(), bytes.size.toLong())
        }
    }

    // ---- Proxy passthrough ----

    private fun proxyToRemote(session: IHTTPSession, uri: String, method: Method): Response {
        val cfg = AppConfig.get()
        if (cfg.remoteUrl.isBlank()) {
            return newFixedLengthResponse(Status.SERVICE_UNAVAILABLE, "text/plain", "No remote URL configured")
        }

        // For GET requests check cache first
        if (method == Method.GET) {
            val cached = runBlocking { db.httpCacheDao().get(uri) }
            val now = System.currentTimeMillis()
            val REVALIDATE_AFTER = 10 * 60 * 1000L

            if (cached != null) {
                if (now - cached.updatedAt > REVALIDATE_AFTER) {
                    Thread {
                        try { revalidateHtmlCache(uri, cached.etag, cached.lastModified) }
                        catch (e: Exception) { Log.w(TAG, "BG revalidate failed for $uri", e) }
                    }.start()
                }
                val cachedBytes = readBody(cached.bodyPath) ?: byteArrayOf()
                val response = newFixedLengthResponse(Status.OK,
                    extractContentType(cached.headers),
                    cachedBytes.inputStream(), cachedBytes.size.toLong())
                response.addHeader("X-TW-Cache", "HIT")
                return response
            }
        }

        return try {
            val targetUrl = cfg.remoteUrl + uri + buildQueryString(session)
            val reqBuilder = Request.Builder().url(targetUrl)

            // Forward headers (skip hop-by-hop)
            val skipHeaders = setOf("host", "connection", "content-length", "transfer-encoding", "accept-encoding")
            for ((k, v) in session.headers) {
                if (k.lowercase() in skipHeaders) continue
                reqBuilder.header(k, v)
            }
            AppConfig.authHeader()?.let { reqBuilder.header("Authorization", it) }

            when (method) {
                Method.GET, Method.HEAD -> { /* no body */ }
                else -> {
                    val bodyStr = readBody(session)
                    val contentType = session.headers["content-type"] ?: "application/octet-stream"
                    val reqBody = bodyStr.toByteArray(Charsets.UTF_8).toRequestBody(contentType.toMediaTypeOrNull())
                    reqBuilder.method(method.name, reqBody)
                }
            }

            val response = httpClient.newCall(reqBuilder.build()).execute()
            response.use { resp ->
                val bodyBytes = resp.body?.bytes() ?: byteArrayOf()
                val contentType = resp.header("Content-Type") ?: "application/octet-stream"

                // Cache GET 200 responses (not API endpoints)
                if (method == Method.GET && resp.code == 200 &&
                    !uri.startsWith("/recipes/") && !uri.startsWith("/bags/") &&
                    !uri.startsWith("/status") && !uri.startsWith("/_sync/")) {
                    val headersJson = buildHeadersJson(resp.headers)
                    val path = writeBody(uri, bodyBytes)
                    runBlocking {
                        db.httpCacheDao().put(
                            HttpCacheEntity(
                                url = uri,
                                status = 200,
                                headers = headersJson,
                                bodyPath = path,
                                etag = resp.header("Etag"),
                                lastModified = resp.header("Last-Modified"),
                                updatedAt = System.currentTimeMillis()
                            )
                        )
                    }
                }

                val nanoresp = newFixedLengthResponse(
                    Status.lookup(resp.code) ?: Status.INTERNAL_ERROR,
                    contentType,
                    bodyBytes.inputStream(),
                    bodyBytes.size.toLong()
                )
                // Forward selected response headers
                for (name in resp.headers.names()) {
                    val lower = name.lowercase()
                    if (lower in setOf("content-encoding", "content-length", "transfer-encoding", "connection")) continue
                    nanoresp.addHeader(name, resp.header(name) ?: continue)
                }
                nanoresp
            }
        } catch (e: Exception) {
            Log.e(TAG, "Proxy error for $uri", e)
            newFixedLengthResponse(Status.INTERNAL_ERROR, "text/plain", "Proxy error: ${e.message}")
        }
    }

    // ---- HTML patch injection ----

    /**
     * Inject a patch script before the <script> tag containing $tw.boot.boot().
     * Disables TW's lazy-load and sync-from-server mechanisms since the embedded
     * HTML already contains all tiddlers with full text.
     */
    fun injectPatch(html: String): String {
        val bootCallIdx = html.indexOf("\$tw.boot.boot()")
        if (bootCallIdx < 0) {
            Log.w(TAG, "injectPatch: \$tw.boot.boot() not found — patch skipped")
            return html
        }

        val scriptTagIdx = html.lastIndexOf("<script", bootCallIdx)
        if (scriptTagIdx < 0) return html

        val patchScript = """<script>(function(){
if(!window.${"$"}tw)return;
Object.defineProperty(${"$"}tw,"syncer",{configurable:true,enumerable:true,
get:function(){return ${"$"}tw.__syncer__;},
set:function(v){
${"$"}tw.__syncer__=v;
if(!v)return;
v.handleLazyLoadEvent=function(){};
v.canSyncFromServer=function(){return false;};
v.syncFromServerInterval=999999999;
if(v.pollTimerId){clearTimeout(v.pollTimerId);v.pollTimerId=null;}
console.log("[patch] lazy-load and sync-from-server disabled");
}});
})();</script>
"""
        return html.substring(0, scriptTagIdx) + patchScript + html.substring(scriptTagIdx)
    }

    // ---- Helpers ----

    private fun readBody(session: IHTTPSession): String {
        return try {
            val files = HashMap<String, String>()
            session.parseBody(files)
            val path = files["content"]
            if (path != null) File(path).readText(Charsets.UTF_8) else ""
        } catch (e: Exception) {
            Log.w(TAG, "readBody failed", e)
            ""
        }
    }

    private fun decodeTitle(encoded: String): String {
        return try {
            URLDecoder.decode(encoded, "UTF-8")
        } catch (e: Exception) {
            encoded
        }
    }

    private fun buildEtag(title: String, revision: String): String {
        val encodedTitle = URLEncoder.encode(title, "UTF-8")
        return "\"default/$encodedTitle/$revision:\""
    }

    private fun entityToFieldsMap(entity: TiddlerEntity): Map<String, Any?> {
        // Parse headerJson to get all non-text fields
        val map = mutableMapOf<String, Any?>()
        try {
            val jsonObj = JsonParser.parseString(entity.headerJson).asJsonObject
            for ((k, v) in jsonObj.entrySet()) {
                map[k] = when {
                    v.isJsonPrimitive -> v.asString
                    v.isJsonArray -> v.asJsonArray.map { it.asString }
                    v.isJsonNull -> null
                    else -> v.toString()
                }
            }
        } catch (e: Exception) {
            Log.w(TAG, "Failed to parse headerJson for ${entity.title}", e)
        }
        // Ensure required fields
        map["title"] = entity.title
        if (entity.text.isNotEmpty()) map["text"] = entity.text
        if (entity.revision.isNotEmpty()) map["revision"] = entity.revision
        return map
    }

    private fun buildHeadersJson(headers: okhttp3.Headers): String {
        val map = mutableMapOf<String, String>()
        for (name in headers.names()) {
            map[name] = headers[name] ?: continue
        }
        return gson.toJson(map)
    }

    private fun extractContentType(headersJson: String): String {
        return try {
            val obj = JsonParser.parseString(headersJson).asJsonObject
            obj.get("Content-Type")?.asString
                ?: obj.get("content-type")?.asString
                ?: "application/octet-stream"
        } catch (e: Exception) {
            "application/octet-stream"
        }
    }

    private fun buildQueryString(session: IHTTPSession): String {
        val params = session.parameters
        if (params.isNullOrEmpty()) return ""
        val sb = StringBuilder("?")
        var first = true
        for ((k, values) in params) {
            for (v in values) {
                if (!first) sb.append("&")
                sb.append(URLEncoder.encode(k, "UTF-8"))
                sb.append("=")
                sb.append(URLEncoder.encode(v, "UTF-8"))
                first = false
            }
        }
        return sb.toString()
    }

    private fun jsonResponse(json: String): Response {
        val bytes = json.toByteArray(Charsets.UTF_8)
        val response = newFixedLengthResponse(Status.OK, "application/json; charset=utf-8",
            bytes.inputStream(), bytes.size.toLong())
        response.addHeader("Access-Control-Allow-Origin", "*")
        return response
    }
}

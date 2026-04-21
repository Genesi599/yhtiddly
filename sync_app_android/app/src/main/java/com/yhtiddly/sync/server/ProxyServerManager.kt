package com.yhtiddly.sync.server

import android.content.Context
import android.util.Log
import com.yhtiddly.sync.config.AppConfig
import fi.iki.elonen.NanoHTTPD
import java.io.File

/**
 * Process-wide singleton for the [LocalProxyServer]. Ensures the server is
 * started exactly once regardless of Activity recreation (rotation, config
 * changes) and restarted only when the upstream URL or credentials change.
 */
object ProxyServerManager {
    private const val TAG = "ProxyServerManager"
    private const val CACHE_FILE = "tiddlywiki.html"

    private var server: LocalProxyServer? = null
    private var signature: String? = null
    @Volatile private var port: Int = 0

    /**
     * Starts (or returns the already-running) proxy. Must be called once per
     * process from the Application / first Activity. Returns the local URL
     * the WebView should load, e.g. `http://127.0.0.1:43921/`.
     */
    @Synchronized
    fun ensureStarted(context: Context): String {
        val cfg = AppConfig.get()
        val sig = "${cfg.remoteUrl}|${cfg.username}|${cfg.password}"

        val existing = server
        if (existing != null && existing.isAlive && sig == signature) {
            return "http://127.0.0.1:$port/"
        }

        // Config changed (or first start) — shut down any prior instance.
        existing?.let {
            try { it.stop() } catch (_: Exception) {}
        }

        val cacheFile = File(context.applicationContext.filesDir, CACHE_FILE)
        val newServer = LocalProxyServer(
            port = 0, // OS picks a free ephemeral port
            remoteUrl = cfg.remoteUrl,
            cacheFile = cacheFile,
            authHeader = AppConfig.authHeader()
        )
        newServer.start(NanoHTTPD.SOCKET_READ_TIMEOUT, false)
        server = newServer
        signature = sig
        port = newServer.listeningPort
        Log.i(TAG, "Started on port $port (upstream=${cfg.remoteUrl}, cache=${cacheFile.absolutePath})")
        return "http://127.0.0.1:$port/"
    }

    @Synchronized
    fun stop() {
        server?.let {
            try { it.stop() } catch (_: Exception) {}
        }
        server = null
        signature = null
        port = 0
    }
}

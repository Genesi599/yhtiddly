package com.yhtiddly.sync

import android.content.Context
import android.util.Log
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.OkHttpClient
import okhttp3.Request
import java.io.File
import java.util.concurrent.TimeUnit

object CacheHelper {
    private const val TAG = "CacheHelper"
    private const val CACHE_FILE = "tiddlywiki.html"
    private const val MIN_VALID_SIZE = 1_000_000L // 1 MB

    // IMPORTANT: use filesDir (persistent) instead of cacheDir.
    // Android may clear cacheDir at any time under storage pressure, which is
    // why the 18 MB HTML kept disappearing between app launches.
    private fun getCacheFile(context: Context) = File(context.filesDir, CACHE_FILE)
    private fun getTempFile(context: Context) = File(context.filesDir, "$CACHE_FILE.tmp")

    fun getCachedFileUrl(context: Context): String? {
        val file = getCacheFile(context)
        val exists = file.exists()
        val size = if (exists) file.length() else 0L
        Log.i(TAG, "getCachedFileUrl: path=${file.absolutePath} exists=$exists size=${size / 1024} KB")
        return if (exists && size > MIN_VALID_SIZE) {
            "file://${file.absolutePath}"
        } else {
            null
        }
    }

    suspend fun fetchAndCache(context: Context, url: String): String? = withContext(Dispatchers.IO) {
        val cacheFile = getCacheFile(context)
        val tempFile = getTempFile(context)
        try {
            Log.i(TAG, "fetchAndCache START url=$url -> ${cacheFile.absolutePath}")
            val httpClient = OkHttpClient.Builder()
                .connectTimeout(30, TimeUnit.SECONDS)
                .readTimeout(300, TimeUnit.SECONDS)
                .build()

            val req = Request.Builder().url(url).build()
            val resp = httpClient.newCall(req).execute()

            if (!resp.isSuccessful) {
                Log.e(TAG, "fetchAndCache HTTP ${resp.code}")
                return@withContext null
            }

            val body = resp.body?.bytes() ?: run {
                Log.e(TAG, "fetchAndCache empty response body")
                return@withContext null
            }

            Log.i(TAG, "fetchAndCache downloaded ${body.size / 1024} KB, writing to temp...")

            // Atomic write: write to .tmp first, then rename. Ensures we never
            // leave a truncated file if the process is killed mid-write.
            tempFile.writeBytes(body)
            if (cacheFile.exists()) cacheFile.delete()
            val renamed = tempFile.renameTo(cacheFile)
            if (!renamed) {
                Log.e(TAG, "fetchAndCache rename failed, falling back to direct write")
                cacheFile.writeBytes(body)
                tempFile.delete()
            }

            val finalSize = cacheFile.length()
            Log.i(TAG, "fetchAndCache DONE size=${finalSize / 1024 / 1024} MB at ${cacheFile.absolutePath}")
            "file://${cacheFile.absolutePath}"
        } catch (e: Exception) {
            Log.e(TAG, "fetchAndCache FAILED", e)
            try { tempFile.delete() } catch (_: Exception) {}
            null
        }
    }
}

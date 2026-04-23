package com.yhtiddly.sync

import android.app.DownloadManager
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.net.Uri
import android.os.Build
import android.os.Environment
import android.util.Log
import androidx.core.content.ContextCompat
import androidx.core.content.FileProvider
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.OkHttpClient
import okhttp3.Request
import org.json.JSONObject
import java.io.File
import java.util.concurrent.TimeUnit

private const val TAG = "AutoUpdater"

// Update manifest is the GitHub "latest release" API for this repo. To cut a
// new release: tag the commit `vX.Y[.Z]`, attach the signed APK as a release
// asset. App users will be offered the update on next launch.
//
// Contract:
//   - tag_name: "vX.Y[.Z]" — the leading 'v' is stripped for comparison
//   - assets[i].name ends with ".apk" — first match is downloaded
//   - body: rendered as the changelog in the prompt
private const val RELEASES_URL =
    "https://api.github.com/repos/Genesi599/yhtiddly/releases/latest"

data class UpdateInfo(
    val tagName: String,        // e.g. "v1.1" (raw tag)
    val versionName: String,    // e.g. "1.1" (tag without leading 'v')
    val apkUrl: String,
    val apkSize: Long,
    val apkName: String,
    val changelog: String
)

object AutoUpdater {

    private val httpClient = OkHttpClient.Builder()
        .connectTimeout(10, TimeUnit.SECONDS)
        .readTimeout(15, TimeUnit.SECONDS)
        .build()

    // Fetch latest release, compare versions, return UpdateInfo if there's a
    // newer APK available. Returns null on any failure (no release, no APK
    // asset, network error, parse error, same-or-older version).
    suspend fun checkForUpdate(): UpdateInfo? = withContext(Dispatchers.IO) {
        try {
            val req = Request.Builder()
                .url(RELEASES_URL)
                .header("Accept", "application/vnd.github+json")
                .build()
            val resp = httpClient.newCall(req).execute()
            resp.use { r ->
                if (!r.isSuccessful) {
                    Log.w(TAG, "release API HTTP ${r.code}")
                    return@withContext null
                }
                val body = r.body?.string() ?: return@withContext null
                val json = JSONObject(body)
                val tag = json.optString("tag_name", "")
                if (tag.isEmpty()) return@withContext null
                val versionName = tag.removePrefix("v").removePrefix("V")
                if (compareVersions(versionName, BuildConfig.VERSION_NAME) <= 0) {
                    Log.i(TAG, "already up-to-date: $tag vs ${BuildConfig.VERSION_NAME}")
                    return@withContext null
                }
                val assets = json.optJSONArray("assets") ?: return@withContext null
                for (i in 0 until assets.length()) {
                    val a = assets.getJSONObject(i)
                    val name = a.optString("name", "")
                    if (!name.endsWith(".apk", ignoreCase = true)) continue
                    return@withContext UpdateInfo(
                        tagName = tag,
                        versionName = versionName,
                        apkUrl = a.optString("browser_download_url"),
                        apkSize = a.optLong("size", 0L),
                        apkName = name,
                        changelog = json.optString("body", "")
                    )
                }
                Log.w(TAG, "release $tag has no .apk asset")
                null
            }
        } catch (e: Exception) {
            Log.w(TAG, "checkForUpdate failed: ${e.message}")
            null
        }
    }

    // Compare two dotted version strings numerically. Missing components are
    // treated as 0. Non-numeric parts (e.g. "1.0-rc") degrade to 0 for that
    // component. Returns sign(a - b).
    fun compareVersions(a: String, b: String): Int {
        val ap = a.split(".").map { it.takeWhile { c -> c.isDigit() }.toIntOrNull() ?: 0 }
        val bp = b.split(".").map { it.takeWhile { c -> c.isDigit() }.toIntOrNull() ?: 0 }
        val n = maxOf(ap.size, bp.size)
        for (i in 0 until n) {
            val av = ap.getOrElse(i) { 0 }
            val bv = bp.getOrElse(i) { 0 }
            if (av != bv) return av.compareTo(bv)
        }
        return 0
    }

    // Kick off an Android DownloadManager job. Returns the download ID — the
    // caller is expected to register a DOWNLOAD_COMPLETE receiver to trigger
    // the install intent when the file is ready.
    fun startDownload(ctx: Context, info: UpdateInfo): Long {
        val dm = ctx.getSystemService(Context.DOWNLOAD_SERVICE) as DownloadManager
        // Save to app-scoped external cache so we don't need WRITE_EXTERNAL_STORAGE
        // on modern Android and the file is auto-cleaned when the app is
        // uninstalled / user clears cache.
        val target = File(ctx.externalCacheDir, info.apkName)
        if (target.exists()) target.delete()
        val req = DownloadManager.Request(Uri.parse(info.apkUrl)).apply {
            setTitle("TiddlyWiki Sync ${info.versionName}")
            setDescription("正在下载更新…")
            setDestinationUri(Uri.fromFile(target))
            setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED)
            setAllowedOverMetered(true)
            setAllowedOverRoaming(true)
            setMimeType("application/vnd.android.package-archive")
        }
        return dm.enqueue(req)
    }

    // Build the install intent for a downloaded APK. Uses FileProvider so we
    // don't leak file:// URIs (banned since Android 7 / Nougat).
    fun install(ctx: Context, apkFile: File) {
        val uri = FileProvider.getUriForFile(
            ctx, "${ctx.packageName}.fileprovider", apkFile
        )
        val intent = Intent(Intent.ACTION_VIEW).apply {
            setDataAndType(uri, "application/vnd.android.package-archive")
            addFlags(
                Intent.FLAG_GRANT_READ_URI_PERMISSION or
                Intent.FLAG_ACTIVITY_NEW_TASK
            )
        }
        ctx.startActivity(intent)
    }

    // Register a receiver that fires when OUR download completes, resolves the
    // actual file from DownloadManager, and kicks off the install intent. The
    // receiver unregisters itself after handling — so callers don't leak it.
    fun registerCompletionHandler(ctx: Context, downloadId: Long) {
        val receiver = object : BroadcastReceiver() {
            override fun onReceive(context: Context, intent: Intent) {
                val id = intent.getLongExtra(DownloadManager.EXTRA_DOWNLOAD_ID, -1)
                if (id != downloadId) return
                try {
                    val dm = context.getSystemService(Context.DOWNLOAD_SERVICE) as DownloadManager
                    val q = DownloadManager.Query().setFilterById(id)
                    val cursor = dm.query(q)
                    cursor.use {
                        if (!it.moveToFirst()) return
                        val status = it.getInt(it.getColumnIndexOrThrow(DownloadManager.COLUMN_STATUS))
                        if (status != DownloadManager.STATUS_SUCCESSFUL) {
                            Log.w(TAG, "download failed with status $status")
                            return
                        }
                        val uriStr = it.getString(it.getColumnIndexOrThrow(DownloadManager.COLUMN_LOCAL_URI))
                        val file = File(Uri.parse(uriStr).path ?: return)
                        install(context, file)
                    }
                } finally {
                    context.unregisterReceiver(this)
                }
            }
        }
        val filter = IntentFilter(DownloadManager.ACTION_DOWNLOAD_COMPLETE)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            ContextCompat.registerReceiver(
                ctx, receiver, filter, ContextCompat.RECEIVER_EXPORTED
            )
        } else {
            ctx.registerReceiver(receiver, filter)
        }
    }
}

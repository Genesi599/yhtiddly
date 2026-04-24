package com.yhtiddly.sync.update

import android.content.Context
import android.content.Intent
import android.net.Uri
import android.provider.Settings
import android.util.Log
import androidx.core.content.FileProvider
import com.google.gson.Gson
import com.google.gson.annotations.SerializedName
import com.yhtiddly.sync.BuildConfig
import com.yhtiddly.sync.config.AppConfig
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.OkHttpClient
import okhttp3.Request
import java.io.File
import java.util.concurrent.TimeUnit

/**
 * In-app update system. Fetches a JSON manifest from the configured TiddlyWeb
 * server, compares its `versionCode` with our own `BuildConfig.VERSION_CODE`,
 * and if newer, downloads the APK to internal cache and launches the system
 * package installer via FileProvider.
 *
 * Server-side convention (host these on your TiddlyWeb server):
 *
 *   <remoteUrl>/app-version.json     — manifest (see [VersionManifest])
 *   <remoteUrl>/yhtiddly.apk         — (or an absolute URL in the manifest)
 *
 * Example app-version.json:
 * ```
 * {
 *   "versionCode": 2,
 *   "versionName": "1.0.1",
 *   "apkUrl": "/yhtiddly.apk",
 *   "notes": "Fixed dark theme, added auto-update."
 * }
 * ```
 *
 * **Signing caveat:** Android refuses to update an installed app whose
 * signature differs from the new APK. Always build the distributed APK with
 * the same keystore (debug keystore works for personal use, as long as you
 * always build from the same machine).
 */
object UpdateChecker {
    private const val TAG = "UpdateChecker"
    private const val MANIFEST_PATH = "/app-version.json"
    private const val APK_SUBDIR = "updates"
    private const val APK_FILE = "update.apk"

    data class VersionManifest(
        @SerializedName("versionCode") val versionCode: Int = 0,
        @SerializedName("versionName") val versionName: String = "",
        @SerializedName("apkUrl") val apkUrl: String = "",
        @SerializedName("notes") val notes: String = ""
    )

    sealed class CheckResult {
        data class Update(val info: VersionManifest) : CheckResult()
        data class UpToDate(val current: Int) : CheckResult()
        data class Error(val message: String) : CheckResult()
    }

    private val client = OkHttpClient.Builder()
        .connectTimeout(10, TimeUnit.SECONDS)
        .readTimeout(30, TimeUnit.SECONDS)
        .build()

    /** Ask the server whether a newer version is available. */
    suspend fun check(): CheckResult = withContext(Dispatchers.IO) {
        try {
            val cfg = AppConfig.get()
            if (cfg.remoteUrl.isBlank()) return@withContext CheckResult.Error("未配置远程地址")
            val url = cfg.remoteUrl.trimEnd('/') + MANIFEST_PATH
            Log.i(TAG, "Check $url (current=${BuildConfig.VERSION_CODE})")

            val b = Request.Builder().url(url)
            AppConfig.authHeader()?.let { b.header("Authorization", it) }
            val resp = client.newCall(b.build()).execute()
            if (!resp.isSuccessful) return@withContext CheckResult.Error("HTTP ${resp.code}")
            val body = resp.body?.string() ?: return@withContext CheckResult.Error("空响应")

            val manifest = Gson().fromJson(body, VersionManifest::class.java)
            Log.i(TAG, "Manifest: $manifest")
            if (manifest.versionCode > BuildConfig.VERSION_CODE) {
                CheckResult.Update(manifest)
            } else {
                CheckResult.UpToDate(BuildConfig.VERSION_CODE)
            }
        } catch (e: Exception) {
            Log.e(TAG, "Check failed", e)
            CheckResult.Error(e.message ?: "未知错误")
        }
    }

    /** Stream the APK to [Context.getCacheDir]/updates/update.apk. */
    suspend fun download(
        context: Context,
        info: VersionManifest,
        onProgress: (bytesRead: Long, contentLength: Long) -> Unit
    ): Result<File> = withContext(Dispatchers.IO) {
        try {
            val cfg = AppConfig.get()
            val apkUrl = if (info.apkUrl.startsWith("http")) {
                info.apkUrl
            } else {
                cfg.remoteUrl.trimEnd('/') + "/" + info.apkUrl.trimStart('/')
            }
            Log.i(TAG, "Download $apkUrl")

            val dir = File(context.cacheDir, APK_SUBDIR).apply { mkdirs() }
            val apkFile = File(dir, APK_FILE)
            if (apkFile.exists()) apkFile.delete()

            val b = Request.Builder().url(apkUrl)
            AppConfig.authHeader()?.let { b.header("Authorization", it) }
            val dlClient = client.newBuilder().readTimeout(300, TimeUnit.SECONDS).build()
            val resp = dlClient.newCall(b.build()).execute()
            if (!resp.isSuccessful) throw Exception("HTTP ${resp.code}")

            val total = resp.body?.contentLength() ?: -1L
            val src = resp.body?.byteStream() ?: throw Exception("空响应体")
            apkFile.outputStream().use { out ->
                val buf = ByteArray(64 * 1024)
                var read = 0L
                while (true) {
                    val n = src.read(buf)
                    if (n < 0) break
                    out.write(buf, 0, n)
                    read += n
                    onProgress(read, total)
                }
            }
            Log.i(TAG, "Downloaded ${apkFile.length() / 1024} KB -> ${apkFile.absolutePath}")
            Result.success(apkFile)
        } catch (e: Exception) {
            Log.e(TAG, "Download failed", e)
            Result.failure(e)
        }
    }

    /**
     * Launch the system package installer. Requires the user to have granted
     * "Install unknown apps" permission for this app — use [ensureInstallPermission]
     * first to shepherd them through the system settings page if not.
     */
    fun install(context: Context, apkFile: File) {
        val uri = FileProvider.getUriForFile(
            context, "${context.packageName}.fileprovider", apkFile
        )
        val intent = Intent(Intent.ACTION_VIEW).apply {
            setDataAndType(uri, "application/vnd.android.package-archive")
            flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_GRANT_READ_URI_PERMISSION
        }
        context.startActivity(intent)
    }

    /**
     * Returns true if we're allowed to install APKs. On false, opens system
     * settings so the user can grant the permission for this app.
     */
    fun ensureInstallPermission(context: Context): Boolean {
        val pm = context.packageManager
        if (pm.canRequestPackageInstalls()) return true
        val intent = Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES)
            .setData(Uri.parse("package:${context.packageName}"))
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        context.startActivity(intent)
        return false
    }
}

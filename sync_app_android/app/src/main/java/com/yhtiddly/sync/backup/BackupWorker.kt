package com.yhtiddly.sync.backup

import android.content.Context
import android.util.Log
import androidx.work.BackoffPolicy
import androidx.work.Constraints
import androidx.work.CoroutineWorker
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.NetworkType
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.WorkerParameters
import com.yhtiddly.sync.config.AppConfig
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.OkHttpClient
import okhttp3.Request
import java.io.File
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.concurrent.TimeUnit

private const val TAG = "BackupWorker"
private const val WORK_NAME = "periodic_backup"
private const val MAX_BACKUPS = 30

class BackupWorker(ctx: Context, params: WorkerParameters) : CoroutineWorker(ctx, params) {

    private val httpClient = OkHttpClient.Builder()
        .connectTimeout(30, TimeUnit.SECONDS)
        .readTimeout(180, TimeUnit.SECONDS)
        .writeTimeout(60, TimeUnit.SECONDS)
        .build()

    override suspend fun doWork(): Result {
        val cfg = AppConfig.get()

        val backupDir = cfg.backupDir
        if (backupDir.isBlank()) {
            Log.d(TAG, "Backup skipped: no backupDir configured")
            return Result.success()
        }

        if (cfg.remoteUrl.isBlank()) {
            Log.w(TAG, "Backup skipped: no remoteUrl")
            return Result.success()
        }

        return try {
            doBackup(cfg.remoteUrl, backupDir, AppConfig.authHeader())
            Result.success()
        } catch (e: Exception) {
            Log.e(TAG, "Backup failed", e)
            Result.retry()
        }
    }

    private suspend fun doBackup(remoteUrl: String, backupDir: String, authHeader: String?) =
        withContext(Dispatchers.IO) {
            // Ensure backup directory exists
            val dir = File(backupDir)
            dir.mkdirs()

            // Fetch full HTML from remote
            val reqBuilder = Request.Builder()
                .url("$remoteUrl/")
                .header("Accept", "text/html,*/*")
                .header("Cache-Control", "no-cache")
            authHeader?.let { reqBuilder.header("Authorization", it) }

            val response = httpClient.newCall(reqBuilder.build()).execute()
            response.use { resp ->
                if (!resp.isSuccessful) throw Exception("HTTP ${resp.code} from $remoteUrl")
                val html = resp.body?.string() ?: throw Exception("Empty response body")
                if (html.length < 1000) throw Exception("Response too short — not a TiddlyWiki HTML")

                val filename = timestampedFilename()
                val destFile = File(dir, filename)

                // Write to temp file first, then move atomically
                val tmpFile = File(applicationContext.cacheDir, "tw-backup-tmp.html")
                tmpFile.writeText(html, Charsets.UTF_8)
                tmpFile.copyTo(destFile, overwrite = true)
                tmpFile.delete()

                Log.i(TAG, "Backup saved: ${destFile.absolutePath} (${html.length / 1024} KiB)")

                // Prune old backups
                pruneOldBackups(dir)
            }
        }

    private fun timestampedFilename(): String {
        val sdf = SimpleDateFormat("yyyyMMdd_HHmmss", Locale.US)
        return "tiddlywiki_${sdf.format(Date())}.html"
    }

    private fun pruneOldBackups(dir: File) {
        try {
            val pattern = Regex("^tiddlywiki_\\d{8}_\\d{6}\\.html$")
            val files = dir.listFiles { f -> pattern.matches(f.name) }
                ?.sortedBy { it.name }  // lexicographic = chronological
                ?: return

            val excess = files.size - MAX_BACKUPS
            if (excess <= 0) return

            files.take(excess).forEach { file ->
                try {
                    file.delete()
                    Log.d(TAG, "Pruned old backup: ${file.name}")
                } catch (e: Exception) {
                    Log.w(TAG, "Could not delete ${file.name}: ${e.message}")
                }
            }
        } catch (e: Exception) {
            Log.w(TAG, "Prune failed: ${e.message}")
        }
    }

    companion object {
        fun schedule(context: Context) {
            val constraints = Constraints.Builder()
                .setRequiredNetworkType(NetworkType.CONNECTED)
                .build()

            val request = PeriodicWorkRequestBuilder<BackupWorker>(1, TimeUnit.HOURS)
                .setConstraints(constraints)
                .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 5, TimeUnit.MINUTES)
                .build()

            WorkManager.getInstance(context).enqueueUniquePeriodicWork(
                WORK_NAME,
                ExistingPeriodicWorkPolicy.KEEP,
                request
            )
            Log.i(TAG, "Periodic backup scheduled (1 hour)")
        }

        fun cancel(context: Context) {
            WorkManager.getInstance(context).cancelUniqueWork(WORK_NAME)
        }
    }
}

package com.yhtiddly.sync.sync

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
import com.yhtiddly.sync.App
import java.util.concurrent.TimeUnit

private const val TAG = "SyncWorker"
private const val WORK_NAME = "periodic_sync"

class SyncWorker(ctx: Context, params: WorkerParameters) : CoroutineWorker(ctx, params) {

    override suspend fun doWork(): Result {
        Log.d(TAG, "Starting periodic sync")
        return try {
            val db = (applicationContext as App).database
            val engine = SyncEngine(db)
            val report = engine.syncOnce()
            Log.i(TAG, "Sync done: pushed=${report.pushed} pulled=${report.pulled} " +
                       "deleted=${report.deleted} removed=${report.removed} " +
                       "errors=${report.errors.size}")
            if (report.errors.isEmpty()) Result.success() else Result.retry()
        } catch (e: Exception) {
            Log.e(TAG, "Sync worker failed", e)
            Result.retry()
        }
    }

    companion object {
        fun schedule(context: Context) {
            val constraints = Constraints.Builder()
                .setRequiredNetworkType(NetworkType.CONNECTED)
                .build()

            // WorkManager minimum interval is 15 minutes
            val request = PeriodicWorkRequestBuilder<SyncWorker>(15, TimeUnit.MINUTES)
                .setConstraints(constraints)
                .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 1, TimeUnit.MINUTES)
                .build()

            WorkManager.getInstance(context).enqueueUniquePeriodicWork(
                WORK_NAME,
                ExistingPeriodicWorkPolicy.KEEP,
                request
            )
            Log.i(TAG, "Periodic sync scheduled (15 min, requires network)")
        }

        fun cancel(context: Context) {
            WorkManager.getInstance(context).cancelUniqueWork(WORK_NAME)
        }
    }
}

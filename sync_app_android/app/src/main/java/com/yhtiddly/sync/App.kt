package com.yhtiddly.sync

import android.app.Application
import com.yhtiddly.sync.config.AppConfig
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.Dispatchers

class App : Application() {
    // Application-scoped coroutine scope that survives Activity destruction.
    // Used for background tasks (e.g. caching the 18 MB HTML) that must not
    // be cancelled when the user backgrounds / closes the Activity.
    val applicationScope = CoroutineScope(SupervisorJob() + Dispatchers.IO)

    override fun onCreate() {
        super.onCreate()
        AppConfig.init(this)
    }
}

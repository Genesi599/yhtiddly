package com.yhtiddly.sync

import android.app.Application
import com.yhtiddly.sync.config.AppConfig
import com.yhtiddly.sync.data.AppDatabase

class App : Application() {

    val database: AppDatabase by lazy {
        AppDatabase.getInstance(this)
    }

    override fun onCreate() {
        super.onCreate()
        AppConfig.init(this)
    }
}

package com.yhtiddly.sync.config

import android.content.Context
import android.content.SharedPreferences
import android.util.Base64
import androidx.preference.PreferenceManager

data class Config(
    val remoteUrl: String = "",
    val username: String = "",
    val password: String = "",
    val syncInterval: Long = 15_000L,
    val backupDir: String = "",
    val backupInterval: Long = 3_600_000L
)

object AppConfig {
    private lateinit var prefs: SharedPreferences

    fun init(ctx: Context) {
        prefs = PreferenceManager.getDefaultSharedPreferences(ctx)
    }

    fun get(): Config {
        val rawUrl = prefs.getString("remoteUrl", "") ?: ""
        // Normalize: strip trailing slashes
        val remoteUrl = rawUrl.trimEnd('/')
        return Config(
            remoteUrl = remoteUrl,
            username = prefs.getString("username", "") ?: "",
            password = prefs.getString("password", "") ?: "",
            syncInterval = prefs.getLong("syncInterval", 15_000L),
            backupDir = prefs.getString("backupDir", "") ?: "",
            backupInterval = prefs.getLong("backupInterval", 3_600_000L)
        )
    }

    fun save(updates: Map<String, Any>) {
        val editor = prefs.edit()
        for ((key, value) in updates) {
            when (value) {
                is String -> editor.putString(key, value)
                is Long -> editor.putLong(key, value)
                is Int -> editor.putInt(key, value)
                is Boolean -> editor.putBoolean(key, value)
                is Float -> editor.putFloat(key, value)
                else -> editor.putString(key, value.toString())
            }
        }
        editor.apply()
    }

    fun isConfigured(): Boolean {
        val url = prefs.getString("remoteUrl", "") ?: ""
        return url.isNotBlank()
    }

    fun authHeader(): String? {
        val cfg = get()
        return if (cfg.username.isNotBlank() && cfg.password.isNotBlank()) {
            val credentials = "${cfg.username}:${cfg.password}"
            val encoded = Base64.encodeToString(credentials.toByteArray(Charsets.UTF_8), Base64.NO_WRAP)
            "Basic $encoded"
        } else {
            null
        }
    }
}

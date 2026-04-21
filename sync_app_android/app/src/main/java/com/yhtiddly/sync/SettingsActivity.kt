package com.yhtiddly.sync

import android.os.Bundle
import android.webkit.WebStorage
import android.widget.Toast
import androidx.appcompat.app.AppCompatActivity
import com.yhtiddly.sync.config.AppConfig
import com.yhtiddly.sync.databinding.ActivitySettingsBinding

class SettingsActivity : AppCompatActivity() {

    private lateinit var binding: ActivitySettingsBinding

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        binding = ActivitySettingsBinding.inflate(layoutInflater)
        setContentView(binding.root)

        supportActionBar?.apply {
            setDisplayHomeAsUpEnabled(true)
            title = getString(R.string.title_settings)
        }

        loadCurrentConfig()

        binding.btnSave.setOnClickListener {
            saveSettings()
        }
    }

    private fun loadCurrentConfig() {
        val cfg = AppConfig.get()
        binding.etRemoteUrl.setText(cfg.remoteUrl)
        binding.etUsername.setText(cfg.username)
        binding.etPassword.setText(cfg.password)
    }

    private fun saveSettings() {
        val remoteUrl = binding.etRemoteUrl.text.toString().trim().trimEnd('/')
        val username = binding.etUsername.text.toString().trim()
        val password = binding.etPassword.text.toString()

        if (remoteUrl.isBlank()) {
            binding.tilRemoteUrl.error = getString(R.string.error_url_required)
            return
        }
        binding.tilRemoteUrl.error = null

        AppConfig.save(
            mapOf(
                "remoteUrl" to remoteUrl,
                "username" to username,
                "password" to password
            )
        )

        Toast.makeText(this, R.string.settings_saved, Toast.LENGTH_SHORT).show()
        finish()
    }

    override fun onSupportNavigateUp(): Boolean {
        finish()
        return true
    }
}

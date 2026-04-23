package com.yhtiddly.sync

import android.content.Intent
import android.net.Uri
import android.net.http.SslError
import android.os.Bundle
import android.provider.Settings
import android.util.Log
import android.view.Menu
import android.view.MenuItem
import android.view.View
import android.webkit.ConsoleMessage
import android.webkit.HttpAuthHandler
import android.webkit.SslErrorHandler
import android.webkit.WebChromeClient
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.appcompat.app.AlertDialog
import androidx.appcompat.app.AppCompatActivity
import androidx.lifecycle.lifecycleScope
import com.yhtiddly.sync.config.AppConfig
import com.yhtiddly.sync.databinding.ActivityMainBinding
import com.yhtiddly.sync.server.ProxyServerManager
import kotlinx.coroutines.launch

private const val TAG = "MainActivity"

class MainActivity : AppCompatActivity() {

    private lateinit var binding: ActivityMainBinding

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        binding = ActivityMainBinding.inflate(layoutInflater)
        setContentView(binding.root)
        setSupportActionBar(binding.toolbar)

        if (!AppConfig.isConfigured()) {
            startActivity(Intent(this, SettingsActivity::class.java))
            finish()
            return
        }

        setupWebView()
        setupSwipeRefresh()

        // Start (or reuse) the local proxy. The WebView always loads
        // http://127.0.0.1:<port>/ — same origin for root + API, so TiddlyWiki
        // sync works; cache persistence is handled server-side.
        val localUrl = ProxyServerManager.ensureStarted(this)
        Log.i(TAG, "Local URL: $localUrl")

        if (savedInstanceState != null) {
            binding.webView.restoreState(savedInstanceState)
            binding.pageProgress.visibility = View.GONE
        } else {
            binding.webView.loadUrl(localUrl)
        }

        // Check for a newer APK on GitHub Releases and prompt the user if
        // one is available. Skipped-versions are remembered so we don't nag.
        lifecycleScope.launch { checkForUpdateAndPrompt() }
    }

    private suspend fun checkForUpdateAndPrompt() {
        val info = AutoUpdater.checkForUpdate() ?: return
        val prefs = getSharedPreferences("auto_update", MODE_PRIVATE)
        val skipped = prefs.getString("skipped_tag", null)
        if (skipped == info.tagName) return
        runOnUiThread { showUpdateDialog(info) }
    }

    private fun showUpdateDialog(info: UpdateInfo) {
        val sizeMb = if (info.apkSize > 0) String.format("%.1f MB", info.apkSize / 1048576.0) else "?"
        val message = buildString {
            append("当前版本: ").append(BuildConfig.VERSION_NAME).append('\n')
            append("新版本:   ").append(info.versionName).append("  (").append(sizeMb).append(")\n")
            if (info.changelog.isNotBlank()) {
                append('\n').append(info.changelog.take(800))
            }
        }
        AlertDialog.Builder(this)
            .setTitle("发现新版本")
            .setMessage(message)
            .setPositiveButton("更新") { _, _ -> beginUpdate(info) }
            .setNegativeButton("稍后", null)
            .setNeutralButton("跳过此版本") { _, _ ->
                getSharedPreferences("auto_update", MODE_PRIVATE)
                    .edit().putString("skipped_tag", info.tagName).apply()
            }
            .show()
    }

    private fun beginUpdate(info: UpdateInfo) {
        // Android O+ requires the user to grant this app permission to install
        // APKs. We can only check the state; the grant has to happen in
        // Settings. Send the user there if the permission is missing.
        if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.O
            && !packageManager.canRequestPackageInstalls()) {
            AlertDialog.Builder(this)
                .setTitle("需要安装权限")
                .setMessage("Android 需要您授权本应用安装未知来源的 APK。点击下一步打开系统设置,授权后回到本应用重试更新。")
                .setPositiveButton("下一步") { _, _ ->
                    val intent = Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
                        Uri.parse("package:$packageName"))
                    startActivity(intent)
                }
                .setNegativeButton("取消", null)
                .show()
            return
        }
        val downloadId = AutoUpdater.startDownload(this, info)
        AutoUpdater.registerCompletionHandler(this, downloadId)
        android.widget.Toast.makeText(this,
            "已开始下载 ${info.versionName},完成后会自动弹出安装",
            android.widget.Toast.LENGTH_LONG).show()
    }

    private fun setupWebView() {
        binding.webView.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            databaseEnabled = true
            allowFileAccess = false
            cacheMode = WebSettings.LOAD_DEFAULT
            setSupportZoom(true)
            builtInZoomControls = true
            displayZoomControls = false
            useWideViewPort = true
            loadWithOverviewMode = true
            mixedContentMode = WebSettings.MIXED_CONTENT_ALWAYS_ALLOW
        }

        binding.webView.webViewClient = object : WebViewClient() {
            override fun onReceivedHttpAuthRequest(
                view: WebView, handler: HttpAuthHandler, host: String, realm: String
            ) {
                // The local proxy doesn't challenge — this handler exists only
                // as a safety net if somehow a cross-origin subresource prompts.
                val cfg = AppConfig.get()
                if (cfg.username.isNotBlank()) {
                    handler.proceed(cfg.username, cfg.password)
                } else {
                    handler.cancel()
                }
            }

            override fun onPageStarted(view: WebView, url: String?, favicon: android.graphics.Bitmap?) {
                Log.i(TAG, "onPageStarted: $url")
                binding.pageProgress.visibility = View.VISIBLE
            }

            override fun onPageFinished(view: WebView, url: String?) {
                Log.i(TAG, "onPageFinished: $url")
                binding.pageProgress.visibility = View.GONE
                binding.swipeRefreshLayout.isRefreshing = false
            }

            override fun onReceivedSslError(view: WebView, handler: SslErrorHandler, error: SslError) {
                Log.e(TAG, "SSL error: ${error.primaryError}")
                handler.cancel()
            }

            override fun onReceivedError(
                view: WebView, request: WebResourceRequest, error: WebResourceError
            ) {
                if (request.isForMainFrame) {
                    Log.e(TAG, "Main-frame error ${error.errorCode}: ${request.url}")
                    binding.pageProgress.visibility = View.GONE
                }
            }
        }

        binding.webView.webChromeClient = object : WebChromeClient() {
            override fun onProgressChanged(view: WebView, newProgress: Int) {
                binding.pageProgress.progress = newProgress
            }

            override fun onConsoleMessage(msg: ConsoleMessage): Boolean {
                if (msg.messageLevel() == ConsoleMessage.MessageLevel.ERROR) {
                    Log.e(TAG, "JS: ${msg.message()} @ ${msg.sourceId()}:${msg.lineNumber()}")
                }
                return true
            }
        }
    }

    private fun setupSwipeRefresh() {
        binding.swipeRefreshLayout.setOnRefreshListener {
            binding.webView.reload()
        }
    }

    override fun onSaveInstanceState(outState: Bundle) {
        super.onSaveInstanceState(outState)
        binding.webView.saveState(outState)
    }

    override fun onCreateOptionsMenu(menu: Menu): Boolean {
        menuInflater.inflate(R.menu.main_menu, menu)
        return true
    }

    override fun onOptionsItemSelected(item: MenuItem): Boolean {
        return when (item.itemId) {
            R.id.action_reload -> {
                binding.webView.reload()
                true
            }
            R.id.action_settings -> {
                startActivity(Intent(this, SettingsActivity::class.java))
                true
            }
            R.id.action_check_update -> {
                // Manual trigger: clears the "skip this version" memory and
                // checks again. Shows a toast if already up-to-date.
                getSharedPreferences("auto_update", MODE_PRIVATE)
                    .edit().remove("skipped_tag").apply()
                android.widget.Toast.makeText(this, "正在检查…",
                    android.widget.Toast.LENGTH_SHORT).show()
                lifecycleScope.launch {
                    val info = AutoUpdater.checkForUpdate()
                    runOnUiThread {
                        if (info == null) {
                            android.widget.Toast.makeText(this@MainActivity,
                                "已是最新版本 (${BuildConfig.VERSION_NAME})",
                                android.widget.Toast.LENGTH_SHORT).show()
                        } else {
                            showUpdateDialog(info)
                        }
                    }
                }
                true
            }
            else -> super.onOptionsItemSelected(item)
        }
    }

    @Deprecated("Use onBackPressedDispatcher")
    override fun onBackPressed() {
        if (binding.webView.canGoBack()) {
            binding.webView.goBack()
        } else {
            @Suppress("DEPRECATION")
            super.onBackPressed()
        }
    }

    override fun onDestroy() {
        super.onDestroy()
        binding.webView.destroy()
        // NOTE: do not stop the proxy server here. It's process-scoped so it
        // survives Activity teardown (rotation, re-launch from Recents).
    }
}

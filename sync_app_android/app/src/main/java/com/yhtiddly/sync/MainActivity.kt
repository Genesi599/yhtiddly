package com.yhtiddly.sync

import android.content.Intent
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.util.Log
import android.view.Menu
import android.view.MenuItem
import android.view.View
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Toast
import androidx.appcompat.app.AppCompatActivity
import androidx.lifecycle.lifecycleScope
import com.yhtiddly.sync.backup.BackupWorker
import com.yhtiddly.sync.config.AppConfig
import com.yhtiddly.sync.databinding.ActivityMainBinding
import com.yhtiddly.sync.server.LocalServer
import com.yhtiddly.sync.sync.SyncEngine
import com.yhtiddly.sync.sync.SyncWorker
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

private const val TAG = "MainActivity"
private const val LOCAL_PORT = 8080

class MainActivity : AppCompatActivity() {

    private lateinit var binding: ActivityMainBinding
    private var localServer: LocalServer? = null

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        binding = ActivityMainBinding.inflate(layoutInflater)
        setContentView(binding.root)

        setupWebView()
        setupSwipeRefresh()

        // Check configuration first
        if (!AppConfig.isConfigured()) {
            startActivity(Intent(this, SettingsActivity::class.java))
            return
        }

        startLocalServer()

        val db = (application as App).database
        val engine = SyncEngine(db)

        if (!engine.isInitialSyncDone()) {
            runInitialSync(engine)
        } else {
            loadWebView()
            scheduleBackgroundWork()
        }
    }

    private fun setupWebView() {
        val webView = binding.webView
        webView.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            allowFileAccess = true
            allowContentAccess = true
            mixedContentMode = WebSettings.MIXED_CONTENT_ALWAYS_ALLOW
            setSupportZoom(true)
            builtInZoomControls = true
            displayZoomControls = false
            cacheMode = WebSettings.LOAD_DEFAULT
            useWideViewPort = true
            loadWithOverviewMode = true
        }

        webView.webViewClient = object : WebViewClient() {
            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                val url = request.url.toString()
                // Keep everything on localhost
                return if (url.startsWith("http://localhost:$LOCAL_PORT") ||
                           url.startsWith("http://127.0.0.1:$LOCAL_PORT")) {
                    false  // let WebView handle it
                } else {
                    // External URLs: open in browser (optional — for now just block)
                    Log.d(TAG, "External URL blocked: $url")
                    true
                }
            }

            override fun onPageFinished(view: WebView, url: String?) {
                binding.swipeRefreshLayout.isRefreshing = false
                // Inject fallback patch JS in case the server-side injection was missed
                val patchJs = """
                    (function(){
                        if(!window.${'$'}tw)return;
                        if(${'$'}tw.__patchApplied)return;
                        ${'$'}tw.__patchApplied=true;
                        Object.defineProperty(${'$'}tw,'syncer',{configurable:true,enumerable:true,
                            get:function(){return ${'$'}tw.__syncer__;},
                            set:function(v){
                                ${'$'}tw.__syncer__=v;
                                if(!v)return;
                                v.handleLazyLoadEvent=function(){};
                                v.canSyncFromServer=function(){return false;};
                                v.syncFromServerInterval=999999999;
                                if(v.pollTimerId){clearTimeout(v.pollTimerId);v.pollTimerId=null;}
                            }
                        });
                    })();
                """.trimIndent()
                view.evaluateJavascript(patchJs, null)
            }

            override fun onReceivedError(
                view: WebView,
                errorCode: Int,
                description: String?,
                failingUrl: String?
            ) {
                Log.w(TAG, "WebView error $errorCode: $description for $failingUrl")
            }
        }

        webView.webChromeClient = object : WebChromeClient() {
            override fun onProgressChanged(view: WebView?, newProgress: Int) {
                // Progress feedback if desired
            }
        }
    }

    private fun setupSwipeRefresh() {
        binding.swipeRefreshLayout.setOnRefreshListener {
            binding.webView.reload()
        }
    }

    private fun startLocalServer() {
        if (localServer != null) return
        try {
            val db = (application as App).database
            localServer = LocalServer(LOCAL_PORT, db)
            localServer!!.start()
            Log.i(TAG, "Local server started on port $LOCAL_PORT")
        } catch (e: Exception) {
            Log.e(TAG, "Failed to start local server", e)
            Toast.makeText(this, "本地服务器启动失败: ${e.message}", Toast.LENGTH_LONG).show()
        }
    }

    private fun loadWebView() {
        binding.webView.loadUrl("http://localhost:$LOCAL_PORT/")
    }

    private fun runInitialSync(engine: SyncEngine) {
        binding.progressOverlay.visibility = View.VISIBLE
        binding.progressText.text = getString(R.string.initial_sync_starting)

        val mainHandler = Handler(Looper.getMainLooper())

        lifecycleScope.launch {
            try {
                withContext(Dispatchers.IO) {
                    engine.initialFullSync { done, total ->
                        val pct = if (total > 0) (done * 100 / total) else 0
                        mainHandler.post {
                            binding.progressText.text = getString(
                                R.string.initial_sync_progress, done, total, pct
                            )
                            if (total > 0) {
                                binding.progressBar.progress = pct
                            }
                        }
                    }
                }
                binding.progressOverlay.visibility = View.GONE
                Toast.makeText(this@MainActivity, R.string.initial_sync_done, Toast.LENGTH_SHORT).show()
                loadWebView()
                scheduleBackgroundWork()
            } catch (e: Exception) {
                Log.e(TAG, "Initial sync failed", e)
                binding.progressOverlay.visibility = View.GONE
                Toast.makeText(
                    this@MainActivity,
                    getString(R.string.initial_sync_error, e.message),
                    Toast.LENGTH_LONG
                ).show()
                // Still load WebView — it will try to proxy directly
                loadWebView()
            }
        }
    }

    private fun scheduleBackgroundWork() {
        SyncWorker.schedule(this)
        BackupWorker.schedule(this)
    }

    override fun onCreateOptionsMenu(menu: Menu): Boolean {
        menuInflater.inflate(R.menu.main_menu, menu)
        return true
    }

    override fun onOptionsItemSelected(item: MenuItem): Boolean {
        return when (item.itemId) {
            R.id.action_sync -> {
                syncNow()
                true
            }
            R.id.action_reload -> {
                binding.webView.reload()
                true
            }
            R.id.action_settings -> {
                startActivity(Intent(this, SettingsActivity::class.java))
                true
            }
            else -> super.onOptionsItemSelected(item)
        }
    }

    private fun syncNow() {
        Toast.makeText(this, R.string.syncing, Toast.LENGTH_SHORT).show()
        val db = (application as App).database
        lifecycleScope.launch {
            try {
                val engine = SyncEngine(db)
                val report = withContext(Dispatchers.IO) { engine.syncOnce() }
                val msg = getString(
                    R.string.sync_done,
                    report.pushed, report.pulled, report.deleted, report.removed
                )
                Toast.makeText(this@MainActivity, msg, Toast.LENGTH_LONG).show()
                if (report.errors.isNotEmpty()) {
                    Log.w(TAG, "Sync errors: ${report.errors.joinToString()}")
                }
            } catch (e: Exception) {
                Log.e(TAG, "Manual sync failed", e)
                Toast.makeText(
                    this@MainActivity,
                    getString(R.string.sync_error, e.message),
                    Toast.LENGTH_LONG
                ).show()
            }
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
        try {
            localServer?.stop()
            localServer = null
        } catch (e: Exception) {
            Log.w(TAG, "Error stopping server", e)
        }
        binding.webView.destroy()
    }
}

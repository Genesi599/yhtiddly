package com.yhtiddly.sync.sync

import android.util.Log
import com.google.gson.Gson
import com.google.gson.JsonObject
import com.google.gson.JsonParser
import com.yhtiddly.sync.config.AppConfig
import com.yhtiddly.sync.data.AppDatabase
import com.yhtiddly.sync.data.MetaEntity
import com.yhtiddly.sync.data.TiddlerEntity
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.sync.Semaphore
import kotlinx.coroutines.sync.withPermit
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withContext
import okhttp3.MediaType.Companion.toMediaTypeOrNull
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger

private const val TAG = "SyncEngine"

class SyncReport {
    private val _pushed = AtomicInteger(0)
    private val _deleted = AtomicInteger(0)
    private val _pulled = AtomicInteger(0)
    private val _removed = AtomicInteger(0)
    private val _errors = java.util.concurrent.CopyOnWriteArrayList<String>()

    var pushed: Int
        get() = _pushed.get()
        set(v) { _pushed.set(v) }
    var deleted: Int
        get() = _deleted.get()
        set(v) { _deleted.set(v) }
    var pulled: Int
        get() = _pulled.get()
        set(v) { _pulled.set(v) }
    var removed: Int
        get() = _removed.get()
        set(v) { _removed.set(v) }
    val errors: MutableList<String> get() = _errors

    fun incPushed() { _pushed.incrementAndGet() }
    fun incDeleted() { _deleted.incrementAndGet() }
    fun incPulled() { _pulled.incrementAndGet() }
    fun incRemoved() { _removed.incrementAndGet() }
}

data class RemoteSkinny(
    val title: String,
    val modified: String?,
    val revision: String?
)

class SyncEngine(private val db: AppDatabase) {

    private val gson = Gson()
    private val httpClient = OkHttpClient.Builder()
        .connectTimeout(30, TimeUnit.SECONDS)
        .readTimeout(60, TimeUnit.SECONDS)
        .writeTimeout(60, TimeUnit.SECONDS)
        .build()

    companion object {
        private val NOSYNC_TITLES = setOf("\$:/StoryList")
    }

    // ---- Helpers ----

    private fun defaultHeaders(): Map<String, String> {
        val headers = mutableMapOf(
            "Accept" to "application/json",
            "X-Requested-With" to "TiddlyWiki"
        )
        AppConfig.authHeader()?.let { headers["Authorization"] = it }
        return headers
    }

    private fun applyHeaders(builder: Request.Builder, extra: Map<String, String> = emptyMap()): Request.Builder {
        for ((k, v) in defaultHeaders()) builder.header(k, v)
        for ((k, v) in extra) builder.header(k, v)
        return builder
    }

    /**
     * Parse TW modified timestamp to epoch ms.
     * Handles both:
     *   - TW compact: "20240101120000000" (YYYYMMDDHHmmssSSS, 17 digits)
     *   - ISO 8601:   "2024-01-01T12:00:00.000Z"
     * Returns 0 for missing/unparseable values.
     */
    fun parseModified(s: String?): Long {
        if (s.isNullOrBlank()) return 0L
        val str = s.trim()
        val compactMatch = Regex("^(\\d{4})(\\d{2})(\\d{2})(\\d{2})(\\d{2})(\\d{2})(\\d{3})?$").matchEntire(str)
        if (compactMatch != null) {
            val (year, month, day, hour, min, sec) = compactMatch.destructured
            val ms = compactMatch.groupValues.getOrNull(7)?.toIntOrNull() ?: 0
            return try {
                java.util.Calendar.getInstance(java.util.TimeZone.getTimeZone("UTC")).let { cal ->
                    cal.set(year.toInt(), month.toInt() - 1, day.toInt(),
                            hour.toInt(), min.toInt(), sec.toInt())
                    cal.set(java.util.Calendar.MILLISECOND, ms)
                    cal.timeInMillis
                }
            } catch (e: Exception) { 0L }
        }
        return try {
            java.time.Instant.parse(str).toEpochMilli()
        } catch (e: Exception) {
            0L
        }
    }

    private fun revisionFromEtag(etag: String?): String? {
        if (etag.isNullOrBlank()) return null
        val m = Regex("\"[^/]+/[^/]+/(\\d+):\"").find(etag)
        return m?.groupValues?.getOrNull(1)
    }

    // ---- Remote fetch helpers ----

    private suspend fun fetchRemoteSkinnyList(): List<RemoteSkinny> = withContext(Dispatchers.IO) {
        val cfg = AppConfig.get()
        val url = cfg.remoteUrl + "/recipes/default/tiddlers.json"
        val req = applyHeaders(Request.Builder().url(url)).build()
        val response = httpClient.newCall(req).execute()
        response.use { resp ->
            if (!resp.isSuccessful) throw Exception("list: HTTP ${resp.code}")
            val body = resp.body?.string() ?: "[]"
            val arr = JsonParser.parseString(body).asJsonArray
            arr.mapNotNull { el ->
                try {
                    val obj = el.asJsonObject
                    RemoteSkinny(
                        title = obj.get("title")?.asString ?: return@mapNotNull null,
                        modified = obj.get("modified")?.asString,
                        revision = obj.get("revision")?.asString
                    )
                } catch (e: Exception) { null }
            }
        }
    }

    private suspend fun fetchRemoteTiddlerOnce(title: String): Pair<Map<String, Any?>, String?>? = withContext(Dispatchers.IO) {
        val cfg = AppConfig.get()
        val encoded = java.net.URLEncoder.encode(title, "UTF-8")
        val url = cfg.remoteUrl + "/recipes/default/tiddlers/$encoded"
        val req = applyHeaders(Request.Builder().url(url)).build()
        val response = httpClient.newCall(req).execute()
        response.use { resp ->
            if (resp.code == 404) {
                // Try bag fallback
                val bagUrl = cfg.remoteUrl + "/bags/default/tiddlers/$encoded"
                val bagReq = applyHeaders(Request.Builder().url(bagUrl)).build()
                val bagResp = httpClient.newCall(bagReq).execute()
                bagResp.use { br ->
                    if (br.code == 404) return@withContext null
                    if (!br.isSuccessful) throw Exception("HTTP ${br.code} (bag fallback)")
                    val rev = revisionFromEtag(br.header("Etag"))
                    val text = br.body?.string() ?: throw Exception("empty bag response")
                    val fields = parseFieldsJson(text, title)
                    return@withContext Pair(fields, rev)
                }
            }
            if (!resp.isSuccessful) throw Exception("HTTP ${resp.code}")
            val rev = revisionFromEtag(resp.header("Etag"))
            val text = resp.body?.string() ?: throw Exception("empty response")
            val fields = parseFieldsJson(text, title)
            Pair(fields, rev)
        }
    }

    private fun parseFieldsJson(json: String, knownTitle: String): Map<String, Any?> {
        val obj = JsonParser.parseString(json).asJsonObject
        val fields = mutableMapOf<String, Any?>()

        // Handle {fields:{...}} wrapper
        val src: JsonObject = if (obj.has("fields") && !obj.has("title")) {
            obj.getAsJsonObject("fields")
        } else {
            obj
        }

        for ((k, v) in src.entrySet()) {
            fields[k] = when {
                v.isJsonPrimitive -> v.asString
                v.isJsonArray -> v.asJsonArray.map { it.asString }
                v.isJsonNull -> null
                else -> v.toString()
            }
        }
        if (!fields.containsKey("title")) fields["title"] = knownTitle
        return fields
    }

    /** Fetch with 3 retries and exponential backoff (500ms, 1500ms) */
    private suspend fun fetchRemoteTiddler(title: String): Pair<Map<String, Any?>, String?>? {
        var lastErr: Exception? = null
        for (attempt in 0 until 3) {
            try {
                return fetchRemoteTiddlerOnce(title)
            } catch (e: Exception) {
                lastErr = e
                if (attempt < 2) {
                    kotlinx.coroutines.delay(500L * (1 + attempt * 2))
                }
            }
        }
        throw lastErr ?: Exception("fetchRemoteTiddler failed")
    }

    private suspend fun pushTiddler(title: String, fields: Map<String, Any?>): String? = withContext(Dispatchers.IO) {
        val cfg = AppConfig.get()
        val encoded = java.net.URLEncoder.encode(title, "UTF-8")
        val url = cfg.remoteUrl + "/recipes/default/tiddlers/$encoded"
        val bodyJson = gson.toJson(fields)
        val reqBody = bodyJson.toByteArray(Charsets.UTF_8)
            .toRequestBody("application/json; charset=utf-8".toMediaTypeOrNull())
        val req = applyHeaders(
            Request.Builder().url(url).put(reqBody),
            mapOf("Content-Type" to "application/json", "X-Requested-With" to "TiddlyWiki")
        ).build()
        val response = httpClient.newCall(req).execute()
        response.use { resp ->
            if (!resp.isSuccessful) throw Exception("PUT $title: HTTP ${resp.code}")
            val etag = resp.header("Etag") ?: ""
            val m = Regex("\"[^/]+/[^/]+/(\\d+):\"").find(etag)
            m?.groupValues?.getOrNull(1)
        }
    }

    private suspend fun pushDeletion(title: String): Boolean = withContext(Dispatchers.IO) {
        val cfg = AppConfig.get()
        val encoded = java.net.URLEncoder.encode(title, "UTF-8")
        val url = cfg.remoteUrl + "/bags/default/tiddlers/$encoded"
        val req = applyHeaders(
            Request.Builder().url(url).delete(),
            mapOf("X-Requested-With" to "TiddlyWiki")
        ).build()
        val response = httpClient.newCall(req).execute()
        response.use { resp ->
            if (!resp.isSuccessful && resp.code != 404) {
                throw Exception("DELETE $title: HTTP ${resp.code}")
            }
        }
        true
    }

    // ---- Convert fields map to TiddlerEntity ----

    private fun fieldsToEntity(
        fields: Map<String, Any?>,
        revision: String?,
        dirty: Int = 0,
        tombstone: Int = 0,
        existing: TiddlerEntity? = null
    ): TiddlerEntity {
        val title = fields["title"] as? String ?: ""
        val text = fields["text"] as? String ?: ""
        val modified = fields["modified"] as? String ?: ""
        val headerMap = fields.filter { it.key != "text" }
        val headerJson = gson.toJson(headerMap)
        return TiddlerEntity(
            title = title,
            headerJson = headerJson,
            text = text,
            revision = revision ?: existing?.revision ?: "0",
            modified = modified,
            dirty = dirty,
            tombstone = tombstone,
            lastSynced = if (dirty == 0) System.currentTimeMillis() else (existing?.lastSynced ?: 0L)
        )
    }

    // ---- Initial full sync ----

    suspend fun initialFullSync(onProgress: (Int, Int) -> Unit = { _, _ -> }) {
        // Strategy 1: try bulk endpoint
        try {
            val bulk = tryBulkFetch(onProgress)
            if (bulk != null && bulk.isNotEmpty()) {
                commitBulk(bulk)
                db.metaDao().set(MetaEntity("initial-sync-complete", "1"))
                db.metaDao().set(MetaEntity("last-sync", System.currentTimeMillis().toString()))
                Log.i(TAG, "initial (bulk): saved ${bulk.size}")
                return
            }
        } catch (e: Exception) {
            Log.w(TAG, "bulk fetch failed, falling back: ${e.message}")
        }

        // Strategy 2: per-tiddler fetch
        val list = fetchRemoteSkinnyList()
        val total = list.size
        Log.i(TAG, "initial (per-tiddler): remote has $total tiddlers")

        val semaphore = Semaphore(15)
        val doneCount = AtomicInteger(0)
        val buffer = mutableListOf<TiddlerEntity>()

        coroutineScope {
            val jobs = list.map { skinny ->
                async(Dispatchers.IO) {
                    semaphore.withPermit {
                        try {
                            val result = fetchRemoteTiddler(skinny.title)
                            if (result != null) {
                                val (fields, rev) = result
                                val entity = fieldsToEntity(fields, rev ?: skinny.revision, dirty = 0)
                                synchronized(buffer) { buffer.add(entity) }
                            }
                        } catch (e: Exception) {
                            Log.w(TAG, "Failed to fetch ${skinny.title}: ${e.message}")
                        }
                        val done = doneCount.incrementAndGet()
                        onProgress(done, total)
                        // Flush in batches
                        val shouldFlush = synchronized(buffer) { buffer.size >= 200 }
                        if (shouldFlush) {
                            val batch = synchronized(buffer) {
                                val copy = buffer.toList()
                                buffer.clear()
                                copy
                            }
                            db.tiddlerDao().upsertAll(batch)
                        }
                    }
                }
            }
            jobs.awaitAll()
        }

        // Flush remaining
        if (buffer.isNotEmpty()) {
            withContext(Dispatchers.IO) { db.tiddlerDao().upsertAll(buffer) }
        }

        withContext(Dispatchers.IO) {
            db.metaDao().set(MetaEntity("initial-sync-complete", "1"))
            db.metaDao().set(MetaEntity("last-sync", System.currentTimeMillis().toString()))
        }
        Log.i(TAG, "initial: done, saved ${doneCount.get()}")
    }

    private suspend fun tryBulkFetch(progressCb: (Int, Int) -> Unit): List<Map<String, Any?>>? {
        val cfg = AppConfig.get()
        val PAGE_SIZE = 1000
        val all = mutableListOf<Map<String, Any?>>()
        var offset = 0

        while (true) {
            val url = cfg.remoteUrl + "/bulk-tiddlers/?offset=$offset&limit=$PAGE_SIZE"
            val req = applyHeaders(Request.Builder().url(url)).build()
            val (statusCode, bodyStr) = withContext(Dispatchers.IO) {
                val resp = httpClient.newCall(req).execute()
                val code = resp.code
                val body = resp.body?.string()
                resp.close()
                Pair(code, body)
            }

            if (statusCode != 200) {
                if (offset == 0) return null  // endpoint absent — signal fallback
                throw Exception("bulk: HTTP $statusCode")
            }
            val body = bodyStr ?: return null
            val obj = try { JsonParser.parseString(body).asJsonObject } catch (e: Exception) { return null }
            val tiddlersArr = obj.getAsJsonArray("tiddlers") ?: return null
            val total = obj.get("total")?.asInt ?: 0

            val batch = tiddlersArr.mapNotNull { el ->
                try { parseFieldsJson(el.toString(), "") }
                catch (e: Exception) { null }
            }
            all.addAll(batch)
            progressCb(all.size, total)

            offset += PAGE_SIZE
            if (offset >= total) return all
        }
    }

    private suspend fun commitBulk(tiddlers: List<Map<String, Any?>>) {
        val CHUNK = 500
        for (i in tiddlers.indices step CHUNK) {
            val chunk = tiddlers.subList(i, minOf(i + CHUNK, tiddlers.size))
            val entities = chunk.mapNotNull { fields ->
                val title = fields["title"] as? String ?: return@mapNotNull null
                fieldsToEntity(fields, fields["revision"] as? String, dirty = 0)
            }
            withContext(Dispatchers.IO) { db.tiddlerDao().upsertAll(entities) }
        }
    }

    fun isInitialSyncDone(): Boolean {
        return runBlocking { db.metaDao().get("initial-sync-complete") == "1" }
    }

    // ---- Incremental sync ----

    suspend fun syncOnce(): SyncReport {
        val report = SyncReport()

        if (!AppConfig.isConfigured()) {
            report.errors.add("not configured")
            return report
        }

        try {
            // --- Push phase ---
            val dirty = withContext(Dispatchers.IO) {
                db.tiddlerDao().getDirty().filter { it.title !in NOSYNC_TITLES }
            }

            for (entity in dirty) {
                try {
                    if (entity.tombstone == 1) {
                        Log.d(TAG, "push delete: ${entity.title}")
                        pushDeletion(entity.title)
                        withContext(Dispatchers.IO) { db.tiddlerDao().purgeTombstone(entity.title) }
                        report.incDeleted()
                    } else {
                        Log.d(TAG, "push update: ${entity.title}")
                        val fields = entityToFieldsMap(entity)
                        val newRev = pushTiddler(entity.title, fields)
                        withContext(Dispatchers.IO) {
                            if (newRev != null) {
                                db.tiddlerDao().clearDirty(entity.title, newRev)
                            } else {
                                db.tiddlerDao().clearDirtyNoRevision(entity.title)
                            }
                        }
                        report.incPushed()
                    }
                } catch (e: Exception) {
                    val op = if (entity.tombstone == 1) "delete" else "put"
                    report.errors.add("$op ${entity.title}: ${e.message}")
                    Log.w(TAG, "push error for ${entity.title}", e)
                }
            }

            // --- Pull phase ---
            val remoteList = fetchRemoteSkinnyList()
            val remoteMap = remoteList.associateBy { it.title }

            val localList = withContext(Dispatchers.IO) { db.tiddlerDao().getAllSkinny() }
            val localMap = localList.associateBy { it.title }

            val toFetch = mutableListOf<String>()
            for ((title, remote) in remoteMap) {
                val local = localMap[title]
                if (local == null) {
                    toFetch.add(title)
                    continue
                }
                val rMod = parseModified(remote.modified)
                val lMod = parseModified(local.modified)
                if (rMod > lMod) {
                    toFetch.add(title)
                } else if (remote.revision != null && local.revision.isNotBlank() &&
                           local.revision != "0" && remote.revision != local.revision && rMod >= lMod) {
                    toFetch.add(title)
                }
            }

            // Parallel fetch with semaphore(10)
            val semaphore = Semaphore(10)
            coroutineScope {
                val jobs = toFetch.map { title ->
                    async(Dispatchers.IO) {
                        semaphore.withPermit {
                            try {
                                val result = fetchRemoteTiddler(title)
                                if (result != null) {
                                    val (fields, rev) = result
                                    val existingLocal = localMap[title]
                                    // Don't overwrite if local is dirty
                                    if (existingLocal == null || existingLocal.dirty == 0) {
                                        val entity = fieldsToEntity(fields, rev, dirty = 0)
                                        db.tiddlerDao().upsert(entity)
                                        report.incPulled()
                                    } else { /* local is dirty, skip */ }
                                } else { /* not found on remote */ }
                            } catch (e: Exception) {
                                report.errors.add("pull $title: ${e.message}")
                                Log.w(TAG, "pull error for $title", e)
                            }
                        }
                    }
                }
                jobs.awaitAll()
            }

            // --- Detect remote deletions ---
            for ((title, local) in localMap) {
                if (!remoteMap.containsKey(title) && local.dirty == 0) {
                    Log.d(TAG, "remote delete detected: $title")
                    withContext(Dispatchers.IO) { db.tiddlerDao().delete(title) }
                    report.incRemoved()
                }
            }

            withContext(Dispatchers.IO) {
                val now = System.currentTimeMillis()
                db.metaDao().set(MetaEntity("last-sync", now.toString()))
                db.metaDao().set(MetaEntity("last-sync-pushed", report.pushed.toString()))
                db.metaDao().set(MetaEntity("last-sync-pulled", report.pulled.toString()))
                db.metaDao().set(MetaEntity("last-sync-deleted", report.deleted.toString()))
                db.metaDao().set(MetaEntity("last-sync-removed", report.removed.toString()))
                db.metaDao().set(MetaEntity("last-sync-errors", report.errors.joinToString("\n")))
            }

        } catch (e: Exception) {
            Log.e(TAG, "syncOnce error", e)
            report.errors.add("sync: ${e.message}")
        }

        return report
    }

    suspend fun pushOnly(): SyncReport {
        val report = SyncReport()
        if (!AppConfig.isConfigured()) return report

        try {
            val dirty = withContext(Dispatchers.IO) { db.tiddlerDao().getDirty() }
            val semaphore = Semaphore(5)
            coroutineScope {
                val jobs = dirty.map { entity ->
                    async(Dispatchers.IO) {
                        semaphore.withPermit {
                            try {
                                if (entity.tombstone == 1) {
                                    pushDeletion(entity.title)
                                    db.tiddlerDao().purgeTombstone(entity.title)
                                    report.incDeleted()
                                } else {
                                    val fields = entityToFieldsMap(entity)
                                    val newRev = pushTiddler(entity.title, fields)
                                    if (newRev != null) {
                                        db.tiddlerDao().clearDirty(entity.title, newRev)
                                    } else {
                                        db.tiddlerDao().clearDirtyNoRevision(entity.title)
                                    }
                                    report.incPushed()
                                }
                            } catch (e: Exception) {
                                report.errors.add("${entity.title}: ${e.message}")
                            }
                        }
                    }
                }
                jobs.awaitAll()
            }
        } catch (e: Exception) {
            report.errors.add("pushOnly: ${e.message}")
        }

        return report
    }

    private fun entityToFieldsMap(entity: TiddlerEntity): Map<String, Any?> {
        val map = mutableMapOf<String, Any?>()
        try {
            val obj = com.google.gson.JsonParser.parseString(entity.headerJson).asJsonObject
            for ((k, v) in obj.entrySet()) {
                map[k] = when {
                    v.isJsonPrimitive -> v.asString
                    v.isJsonArray -> v.asJsonArray.map { it.asString }
                    v.isJsonNull -> null
                    else -> v.toString()
                }
            }
        } catch (e: Exception) {
            Log.w(TAG, "Failed to parse headerJson for ${entity.title}", e)
        }
        map["title"] = entity.title
        if (entity.text.isNotEmpty()) map["text"] = entity.text
        return map
    }
}

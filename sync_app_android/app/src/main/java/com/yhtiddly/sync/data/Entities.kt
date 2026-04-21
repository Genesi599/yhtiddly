package com.yhtiddly.sync.data

import androidx.room.Entity
import androidx.room.PrimaryKey

@Entity(tableName = "tiddlers")
data class TiddlerEntity(
    @PrimaryKey val title: String,
    val headerJson: String,
    val text: String,
    val revision: String,
    val modified: String,
    val dirty: Int = 0,
    val tombstone: Int = 0,
    val lastSynced: Long = 0L
)

/**
 * Lightweight projection for list queries — avoids loading `text` blobs for
 * potentially thousands of rows. Room maps query columns to matching field names.
 */
data class TiddlerSkinny(
    val title: String,
    val headerJson: String,
    val revision: String,
    val modified: String,
    val dirty: Int,
    val tombstone: Int
)

@Entity(tableName = "meta")
data class MetaEntity(
    @PrimaryKey val key: String,
    val value: String
)

@Entity(tableName = "http_cache")
data class HttpCacheEntity(
    @PrimaryKey val url: String,
    val status: Int,
    val headers: String,
    val bodyPath: String,       // path to file containing body bytes
    val etag: String?,
    val lastModified: String?,
    val updatedAt: Long
)

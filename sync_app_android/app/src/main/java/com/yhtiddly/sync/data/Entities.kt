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
    val body: ByteArray,
    val etag: String?,
    val lastModified: String?,
    val updatedAt: Long
) {
    override fun equals(other: Any?): Boolean {
        if (this === other) return true
        if (other !is HttpCacheEntity) return false
        return url == other.url && status == other.status &&
               headers == other.headers && body.contentEquals(other.body) &&
               etag == other.etag && lastModified == other.lastModified &&
               updatedAt == other.updatedAt
    }

    override fun hashCode(): Int {
        var result = url.hashCode()
        result = 31 * result + status
        result = 31 * result + headers.hashCode()
        result = 31 * result + body.contentHashCode()
        result = 31 * result + (etag?.hashCode() ?: 0)
        result = 31 * result + (lastModified?.hashCode() ?: 0)
        result = 31 * result + updatedAt.hashCode()
        return result
    }
}

package com.yhtiddly.sync.data

import androidx.room.Dao
import androidx.room.Insert
import androidx.room.OnConflictStrategy
import androidx.room.Query

@Dao
interface HttpCacheDao {

    @Query("SELECT * FROM http_cache WHERE url = :url LIMIT 1")
    suspend fun get(url: String): HttpCacheEntity?

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun put(entry: HttpCacheEntity)

    @Query("DELETE FROM http_cache")
    suspend fun clear()
}

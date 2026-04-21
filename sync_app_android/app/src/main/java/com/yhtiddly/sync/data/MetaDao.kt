package com.yhtiddly.sync.data

import androidx.room.Dao
import androidx.room.Insert
import androidx.room.OnConflictStrategy
import androidx.room.Query

@Dao
interface MetaDao {

    @Query("SELECT value FROM meta WHERE key = :key LIMIT 1")
    suspend fun get(key: String): String?

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun set(entry: MetaEntity)
}

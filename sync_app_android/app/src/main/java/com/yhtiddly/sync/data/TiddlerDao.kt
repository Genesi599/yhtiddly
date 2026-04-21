package com.yhtiddly.sync.data

import androidx.room.Dao
import androidx.room.Insert
import androidx.room.OnConflictStrategy
import androidx.room.Query
import androidx.room.Transaction

@Dao
abstract class TiddlerDao {

    @Query("SELECT * FROM tiddlers WHERE title = :title AND tombstone = 0 LIMIT 1")
    abstract suspend fun get(title: String): TiddlerEntity?

    @Query("SELECT * FROM tiddlers WHERE tombstone = 0")
    abstract suspend fun getAll(): List<TiddlerEntity>

    @Query("SELECT title, headerJson, revision, modified, dirty, tombstone FROM tiddlers WHERE tombstone = 0")
    abstract suspend fun getAllSkinny(): List<TiddlerSkinny>

    @Query("SELECT * FROM tiddlers WHERE dirty = 1 OR tombstone = 1")
    abstract suspend fun getDirty(): List<TiddlerEntity>

    @Query("SELECT COUNT(*) FROM tiddlers WHERE tombstone = 0")
    abstract suspend fun count(): Int

    @Query("SELECT COUNT(*) FROM tiddlers WHERE dirty = 1")
    abstract suspend fun countDirty(): Int

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    abstract suspend fun upsert(entity: TiddlerEntity)

    @Transaction
    open suspend fun upsertAll(list: List<TiddlerEntity>) {
        for (entity in list) {
            upsert(entity)
        }
    }

    @Query("UPDATE tiddlers SET dirty = 0, revision = :revision, lastSynced = :now WHERE title = :title")
    abstract suspend fun clearDirty(title: String, revision: String, now: Long = System.currentTimeMillis())

    @Query("UPDATE tiddlers SET dirty = 0, lastSynced = :now WHERE title = :title")
    abstract suspend fun clearDirtyNoRevision(title: String, now: Long = System.currentTimeMillis())

    @Query("UPDATE tiddlers SET tombstone = 1, dirty = 1, modified = :modified WHERE title = :title")
    abstract suspend fun markTombstone(title: String, modified: String)

    @Query("DELETE FROM tiddlers WHERE title = :title AND tombstone = 1")
    abstract suspend fun purgeTombstone(title: String)

    @Query("DELETE FROM tiddlers WHERE title = :title")
    abstract suspend fun delete(title: String)

    @Query("SELECT * FROM tiddlers WHERE tombstone = 0 ORDER BY modified DESC LIMIT :limit")
    abstract suspend fun getRecent(limit: Int): List<TiddlerEntity>
}

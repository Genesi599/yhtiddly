package com.yhtiddly.sync.data

import android.content.Context
import androidx.room.Database
import androidx.room.Room
import androidx.room.RoomDatabase

@Database(
    entities = [TiddlerEntity::class, MetaEntity::class, HttpCacheEntity::class],
    version = 1,
    exportSchema = false
)
abstract class AppDatabase : RoomDatabase() {

    abstract fun tiddlerDao(): TiddlerDao
    abstract fun metaDao(): MetaDao
    abstract fun httpCacheDao(): HttpCacheDao

    companion object {
        @Volatile
        private var INSTANCE: AppDatabase? = null

        fun getInstance(context: Context): AppDatabase {
            return INSTANCE ?: synchronized(this) {
                val instance = Room.databaseBuilder(
                    context.applicationContext,
                    AppDatabase::class.java,
                    "twsync.db"
                ).build()
                INSTANCE = instance
                instance
            }
        }
    }
}

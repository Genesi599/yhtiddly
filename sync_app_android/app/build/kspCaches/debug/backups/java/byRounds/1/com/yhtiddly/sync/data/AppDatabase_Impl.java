package com.yhtiddly.sync.data;

import androidx.annotation.NonNull;
import androidx.room.DatabaseConfiguration;
import androidx.room.InvalidationTracker;
import androidx.room.RoomDatabase;
import androidx.room.RoomOpenHelper;
import androidx.room.migration.AutoMigrationSpec;
import androidx.room.migration.Migration;
import androidx.room.util.DBUtil;
import androidx.room.util.TableInfo;
import androidx.sqlite.db.SupportSQLiteDatabase;
import androidx.sqlite.db.SupportSQLiteOpenHelper;
import java.lang.Class;
import java.lang.Override;
import java.lang.String;
import java.lang.SuppressWarnings;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import javax.annotation.processing.Generated;

@Generated("androidx.room.RoomProcessor")
@SuppressWarnings({"unchecked", "deprecation"})
public final class AppDatabase_Impl extends AppDatabase {
  private volatile TiddlerDao _tiddlerDao;

  private volatile MetaDao _metaDao;

  private volatile HttpCacheDao _httpCacheDao;

  @Override
  @NonNull
  protected SupportSQLiteOpenHelper createOpenHelper(@NonNull final DatabaseConfiguration config) {
    final SupportSQLiteOpenHelper.Callback _openCallback = new RoomOpenHelper(config, new RoomOpenHelper.Delegate(2) {
      @Override
      public void createAllTables(@NonNull final SupportSQLiteDatabase db) {
        db.execSQL("CREATE TABLE IF NOT EXISTS `tiddlers` (`title` TEXT NOT NULL, `headerJson` TEXT NOT NULL, `text` TEXT NOT NULL, `revision` TEXT NOT NULL, `modified` TEXT NOT NULL, `dirty` INTEGER NOT NULL, `tombstone` INTEGER NOT NULL, `lastSynced` INTEGER NOT NULL, PRIMARY KEY(`title`))");
        db.execSQL("CREATE TABLE IF NOT EXISTS `meta` (`key` TEXT NOT NULL, `value` TEXT NOT NULL, PRIMARY KEY(`key`))");
        db.execSQL("CREATE TABLE IF NOT EXISTS `http_cache` (`url` TEXT NOT NULL, `status` INTEGER NOT NULL, `headers` TEXT NOT NULL, `bodyPath` TEXT NOT NULL, `etag` TEXT, `lastModified` TEXT, `updatedAt` INTEGER NOT NULL, PRIMARY KEY(`url`))");
        db.execSQL("CREATE TABLE IF NOT EXISTS room_master_table (id INTEGER PRIMARY KEY,identity_hash TEXT)");
        db.execSQL("INSERT OR REPLACE INTO room_master_table (id,identity_hash) VALUES(42, '5d15c00bfae9282375d775f98b3c4099')");
      }

      @Override
      public void dropAllTables(@NonNull final SupportSQLiteDatabase db) {
        db.execSQL("DROP TABLE IF EXISTS `tiddlers`");
        db.execSQL("DROP TABLE IF EXISTS `meta`");
        db.execSQL("DROP TABLE IF EXISTS `http_cache`");
        final List<? extends RoomDatabase.Callback> _callbacks = mCallbacks;
        if (_callbacks != null) {
          for (RoomDatabase.Callback _callback : _callbacks) {
            _callback.onDestructiveMigration(db);
          }
        }
      }

      @Override
      public void onCreate(@NonNull final SupportSQLiteDatabase db) {
        final List<? extends RoomDatabase.Callback> _callbacks = mCallbacks;
        if (_callbacks != null) {
          for (RoomDatabase.Callback _callback : _callbacks) {
            _callback.onCreate(db);
          }
        }
      }

      @Override
      public void onOpen(@NonNull final SupportSQLiteDatabase db) {
        mDatabase = db;
        internalInitInvalidationTracker(db);
        final List<? extends RoomDatabase.Callback> _callbacks = mCallbacks;
        if (_callbacks != null) {
          for (RoomDatabase.Callback _callback : _callbacks) {
            _callback.onOpen(db);
          }
        }
      }

      @Override
      public void onPreMigrate(@NonNull final SupportSQLiteDatabase db) {
        DBUtil.dropFtsSyncTriggers(db);
      }

      @Override
      public void onPostMigrate(@NonNull final SupportSQLiteDatabase db) {
      }

      @Override
      @NonNull
      public RoomOpenHelper.ValidationResult onValidateSchema(
          @NonNull final SupportSQLiteDatabase db) {
        final HashMap<String, TableInfo.Column> _columnsTiddlers = new HashMap<String, TableInfo.Column>(8);
        _columnsTiddlers.put("title", new TableInfo.Column("title", "TEXT", true, 1, null, TableInfo.CREATED_FROM_ENTITY));
        _columnsTiddlers.put("headerJson", new TableInfo.Column("headerJson", "TEXT", true, 0, null, TableInfo.CREATED_FROM_ENTITY));
        _columnsTiddlers.put("text", new TableInfo.Column("text", "TEXT", true, 0, null, TableInfo.CREATED_FROM_ENTITY));
        _columnsTiddlers.put("revision", new TableInfo.Column("revision", "TEXT", true, 0, null, TableInfo.CREATED_FROM_ENTITY));
        _columnsTiddlers.put("modified", new TableInfo.Column("modified", "TEXT", true, 0, null, TableInfo.CREATED_FROM_ENTITY));
        _columnsTiddlers.put("dirty", new TableInfo.Column("dirty", "INTEGER", true, 0, null, TableInfo.CREATED_FROM_ENTITY));
        _columnsTiddlers.put("tombstone", new TableInfo.Column("tombstone", "INTEGER", true, 0, null, TableInfo.CREATED_FROM_ENTITY));
        _columnsTiddlers.put("lastSynced", new TableInfo.Column("lastSynced", "INTEGER", true, 0, null, TableInfo.CREATED_FROM_ENTITY));
        final HashSet<TableInfo.ForeignKey> _foreignKeysTiddlers = new HashSet<TableInfo.ForeignKey>(0);
        final HashSet<TableInfo.Index> _indicesTiddlers = new HashSet<TableInfo.Index>(0);
        final TableInfo _infoTiddlers = new TableInfo("tiddlers", _columnsTiddlers, _foreignKeysTiddlers, _indicesTiddlers);
        final TableInfo _existingTiddlers = TableInfo.read(db, "tiddlers");
        if (!_infoTiddlers.equals(_existingTiddlers)) {
          return new RoomOpenHelper.ValidationResult(false, "tiddlers(com.yhtiddly.sync.data.TiddlerEntity).\n"
                  + " Expected:\n" + _infoTiddlers + "\n"
                  + " Found:\n" + _existingTiddlers);
        }
        final HashMap<String, TableInfo.Column> _columnsMeta = new HashMap<String, TableInfo.Column>(2);
        _columnsMeta.put("key", new TableInfo.Column("key", "TEXT", true, 1, null, TableInfo.CREATED_FROM_ENTITY));
        _columnsMeta.put("value", new TableInfo.Column("value", "TEXT", true, 0, null, TableInfo.CREATED_FROM_ENTITY));
        final HashSet<TableInfo.ForeignKey> _foreignKeysMeta = new HashSet<TableInfo.ForeignKey>(0);
        final HashSet<TableInfo.Index> _indicesMeta = new HashSet<TableInfo.Index>(0);
        final TableInfo _infoMeta = new TableInfo("meta", _columnsMeta, _foreignKeysMeta, _indicesMeta);
        final TableInfo _existingMeta = TableInfo.read(db, "meta");
        if (!_infoMeta.equals(_existingMeta)) {
          return new RoomOpenHelper.ValidationResult(false, "meta(com.yhtiddly.sync.data.MetaEntity).\n"
                  + " Expected:\n" + _infoMeta + "\n"
                  + " Found:\n" + _existingMeta);
        }
        final HashMap<String, TableInfo.Column> _columnsHttpCache = new HashMap<String, TableInfo.Column>(7);
        _columnsHttpCache.put("url", new TableInfo.Column("url", "TEXT", true, 1, null, TableInfo.CREATED_FROM_ENTITY));
        _columnsHttpCache.put("status", new TableInfo.Column("status", "INTEGER", true, 0, null, TableInfo.CREATED_FROM_ENTITY));
        _columnsHttpCache.put("headers", new TableInfo.Column("headers", "TEXT", true, 0, null, TableInfo.CREATED_FROM_ENTITY));
        _columnsHttpCache.put("bodyPath", new TableInfo.Column("bodyPath", "TEXT", true, 0, null, TableInfo.CREATED_FROM_ENTITY));
        _columnsHttpCache.put("etag", new TableInfo.Column("etag", "TEXT", false, 0, null, TableInfo.CREATED_FROM_ENTITY));
        _columnsHttpCache.put("lastModified", new TableInfo.Column("lastModified", "TEXT", false, 0, null, TableInfo.CREATED_FROM_ENTITY));
        _columnsHttpCache.put("updatedAt", new TableInfo.Column("updatedAt", "INTEGER", true, 0, null, TableInfo.CREATED_FROM_ENTITY));
        final HashSet<TableInfo.ForeignKey> _foreignKeysHttpCache = new HashSet<TableInfo.ForeignKey>(0);
        final HashSet<TableInfo.Index> _indicesHttpCache = new HashSet<TableInfo.Index>(0);
        final TableInfo _infoHttpCache = new TableInfo("http_cache", _columnsHttpCache, _foreignKeysHttpCache, _indicesHttpCache);
        final TableInfo _existingHttpCache = TableInfo.read(db, "http_cache");
        if (!_infoHttpCache.equals(_existingHttpCache)) {
          return new RoomOpenHelper.ValidationResult(false, "http_cache(com.yhtiddly.sync.data.HttpCacheEntity).\n"
                  + " Expected:\n" + _infoHttpCache + "\n"
                  + " Found:\n" + _existingHttpCache);
        }
        return new RoomOpenHelper.ValidationResult(true, null);
      }
    }, "5d15c00bfae9282375d775f98b3c4099", "c6f6e3ebe5b76e2191871b1f95163a11");
    final SupportSQLiteOpenHelper.Configuration _sqliteConfig = SupportSQLiteOpenHelper.Configuration.builder(config.context).name(config.name).callback(_openCallback).build();
    final SupportSQLiteOpenHelper _helper = config.sqliteOpenHelperFactory.create(_sqliteConfig);
    return _helper;
  }

  @Override
  @NonNull
  protected InvalidationTracker createInvalidationTracker() {
    final HashMap<String, String> _shadowTablesMap = new HashMap<String, String>(0);
    final HashMap<String, Set<String>> _viewTables = new HashMap<String, Set<String>>(0);
    return new InvalidationTracker(this, _shadowTablesMap, _viewTables, "tiddlers","meta","http_cache");
  }

  @Override
  public void clearAllTables() {
    super.assertNotMainThread();
    final SupportSQLiteDatabase _db = super.getOpenHelper().getWritableDatabase();
    try {
      super.beginTransaction();
      _db.execSQL("DELETE FROM `tiddlers`");
      _db.execSQL("DELETE FROM `meta`");
      _db.execSQL("DELETE FROM `http_cache`");
      super.setTransactionSuccessful();
    } finally {
      super.endTransaction();
      _db.query("PRAGMA wal_checkpoint(FULL)").close();
      if (!_db.inTransaction()) {
        _db.execSQL("VACUUM");
      }
    }
  }

  @Override
  @NonNull
  protected Map<Class<?>, List<Class<?>>> getRequiredTypeConverters() {
    final HashMap<Class<?>, List<Class<?>>> _typeConvertersMap = new HashMap<Class<?>, List<Class<?>>>();
    _typeConvertersMap.put(TiddlerDao.class, TiddlerDao_Impl.getRequiredConverters());
    _typeConvertersMap.put(MetaDao.class, MetaDao_Impl.getRequiredConverters());
    _typeConvertersMap.put(HttpCacheDao.class, HttpCacheDao_Impl.getRequiredConverters());
    return _typeConvertersMap;
  }

  @Override
  @NonNull
  public Set<Class<? extends AutoMigrationSpec>> getRequiredAutoMigrationSpecs() {
    final HashSet<Class<? extends AutoMigrationSpec>> _autoMigrationSpecsSet = new HashSet<Class<? extends AutoMigrationSpec>>();
    return _autoMigrationSpecsSet;
  }

  @Override
  @NonNull
  public List<Migration> getAutoMigrations(
      @NonNull final Map<Class<? extends AutoMigrationSpec>, AutoMigrationSpec> autoMigrationSpecs) {
    final List<Migration> _autoMigrations = new ArrayList<Migration>();
    return _autoMigrations;
  }

  @Override
  public TiddlerDao tiddlerDao() {
    if (_tiddlerDao != null) {
      return _tiddlerDao;
    } else {
      synchronized(this) {
        if(_tiddlerDao == null) {
          _tiddlerDao = new TiddlerDao_Impl(this);
        }
        return _tiddlerDao;
      }
    }
  }

  @Override
  public MetaDao metaDao() {
    if (_metaDao != null) {
      return _metaDao;
    } else {
      synchronized(this) {
        if(_metaDao == null) {
          _metaDao = new MetaDao_Impl(this);
        }
        return _metaDao;
      }
    }
  }

  @Override
  public HttpCacheDao httpCacheDao() {
    if (_httpCacheDao != null) {
      return _httpCacheDao;
    } else {
      synchronized(this) {
        if(_httpCacheDao == null) {
          _httpCacheDao = new HttpCacheDao_Impl(this);
        }
        return _httpCacheDao;
      }
    }
  }
}

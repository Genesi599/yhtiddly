package com.yhtiddly.sync.data;

import android.database.Cursor;
import android.os.CancellationSignal;
import androidx.annotation.NonNull;
import androidx.annotation.Nullable;
import androidx.room.CoroutinesRoom;
import androidx.room.EntityInsertionAdapter;
import androidx.room.RoomDatabase;
import androidx.room.RoomDatabaseKt;
import androidx.room.RoomSQLiteQuery;
import androidx.room.SharedSQLiteStatement;
import androidx.room.util.CursorUtil;
import androidx.room.util.DBUtil;
import androidx.sqlite.db.SupportSQLiteStatement;
import java.lang.Class;
import java.lang.Exception;
import java.lang.Integer;
import java.lang.Object;
import java.lang.Override;
import java.lang.String;
import java.lang.SuppressWarnings;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.concurrent.Callable;
import javax.annotation.processing.Generated;
import kotlin.Unit;
import kotlin.coroutines.Continuation;

@Generated("androidx.room.RoomProcessor")
@SuppressWarnings({"unchecked", "deprecation"})
public final class TiddlerDao_Impl extends TiddlerDao {
  private final RoomDatabase __db;

  private final EntityInsertionAdapter<TiddlerEntity> __insertionAdapterOfTiddlerEntity;

  private final SharedSQLiteStatement __preparedStmtOfClearDirty;

  private final SharedSQLiteStatement __preparedStmtOfClearDirtyNoRevision;

  private final SharedSQLiteStatement __preparedStmtOfMarkTombstone;

  private final SharedSQLiteStatement __preparedStmtOfPurgeTombstone;

  private final SharedSQLiteStatement __preparedStmtOfDelete;

  public TiddlerDao_Impl(@NonNull final RoomDatabase __db) {
    this.__db = __db;
    this.__insertionAdapterOfTiddlerEntity = new EntityInsertionAdapter<TiddlerEntity>(__db) {
      @Override
      @NonNull
      protected String createQuery() {
        return "INSERT OR REPLACE INTO `tiddlers` (`title`,`headerJson`,`text`,`revision`,`modified`,`dirty`,`tombstone`,`lastSynced`) VALUES (?,?,?,?,?,?,?,?)";
      }

      @Override
      protected void bind(@NonNull final SupportSQLiteStatement statement,
          @NonNull final TiddlerEntity entity) {
        statement.bindString(1, entity.getTitle());
        statement.bindString(2, entity.getHeaderJson());
        statement.bindString(3, entity.getText());
        statement.bindString(4, entity.getRevision());
        statement.bindString(5, entity.getModified());
        statement.bindLong(6, entity.getDirty());
        statement.bindLong(7, entity.getTombstone());
        statement.bindLong(8, entity.getLastSynced());
      }
    };
    this.__preparedStmtOfClearDirty = new SharedSQLiteStatement(__db) {
      @Override
      @NonNull
      public String createQuery() {
        final String _query = "UPDATE tiddlers SET dirty = 0, revision = ?, lastSynced = ? WHERE title = ?";
        return _query;
      }
    };
    this.__preparedStmtOfClearDirtyNoRevision = new SharedSQLiteStatement(__db) {
      @Override
      @NonNull
      public String createQuery() {
        final String _query = "UPDATE tiddlers SET dirty = 0, lastSynced = ? WHERE title = ?";
        return _query;
      }
    };
    this.__preparedStmtOfMarkTombstone = new SharedSQLiteStatement(__db) {
      @Override
      @NonNull
      public String createQuery() {
        final String _query = "UPDATE tiddlers SET tombstone = 1, dirty = 1, modified = ? WHERE title = ?";
        return _query;
      }
    };
    this.__preparedStmtOfPurgeTombstone = new SharedSQLiteStatement(__db) {
      @Override
      @NonNull
      public String createQuery() {
        final String _query = "DELETE FROM tiddlers WHERE title = ? AND tombstone = 1";
        return _query;
      }
    };
    this.__preparedStmtOfDelete = new SharedSQLiteStatement(__db) {
      @Override
      @NonNull
      public String createQuery() {
        final String _query = "DELETE FROM tiddlers WHERE title = ?";
        return _query;
      }
    };
  }

  @Override
  public Object upsert(final TiddlerEntity entity, final Continuation<? super Unit> $completion) {
    return CoroutinesRoom.execute(__db, true, new Callable<Unit>() {
      @Override
      @NonNull
      public Unit call() throws Exception {
        __db.beginTransaction();
        try {
          __insertionAdapterOfTiddlerEntity.insert(entity);
          __db.setTransactionSuccessful();
          return Unit.INSTANCE;
        } finally {
          __db.endTransaction();
        }
      }
    }, $completion);
  }

  @Override
  public Object upsertAll(final List<TiddlerEntity> list,
      final Continuation<? super Unit> $completion) {
    return RoomDatabaseKt.withTransaction(__db, (__cont) -> TiddlerDao_Impl.super.upsertAll(list, __cont), $completion);
  }

  @Override
  public Object clearDirty(final String title, final String revision, final long now,
      final Continuation<? super Unit> $completion) {
    return CoroutinesRoom.execute(__db, true, new Callable<Unit>() {
      @Override
      @NonNull
      public Unit call() throws Exception {
        final SupportSQLiteStatement _stmt = __preparedStmtOfClearDirty.acquire();
        int _argIndex = 1;
        _stmt.bindString(_argIndex, revision);
        _argIndex = 2;
        _stmt.bindLong(_argIndex, now);
        _argIndex = 3;
        _stmt.bindString(_argIndex, title);
        try {
          __db.beginTransaction();
          try {
            _stmt.executeUpdateDelete();
            __db.setTransactionSuccessful();
            return Unit.INSTANCE;
          } finally {
            __db.endTransaction();
          }
        } finally {
          __preparedStmtOfClearDirty.release(_stmt);
        }
      }
    }, $completion);
  }

  @Override
  public Object clearDirtyNoRevision(final String title, final long now,
      final Continuation<? super Unit> $completion) {
    return CoroutinesRoom.execute(__db, true, new Callable<Unit>() {
      @Override
      @NonNull
      public Unit call() throws Exception {
        final SupportSQLiteStatement _stmt = __preparedStmtOfClearDirtyNoRevision.acquire();
        int _argIndex = 1;
        _stmt.bindLong(_argIndex, now);
        _argIndex = 2;
        _stmt.bindString(_argIndex, title);
        try {
          __db.beginTransaction();
          try {
            _stmt.executeUpdateDelete();
            __db.setTransactionSuccessful();
            return Unit.INSTANCE;
          } finally {
            __db.endTransaction();
          }
        } finally {
          __preparedStmtOfClearDirtyNoRevision.release(_stmt);
        }
      }
    }, $completion);
  }

  @Override
  public Object markTombstone(final String title, final String modified,
      final Continuation<? super Unit> $completion) {
    return CoroutinesRoom.execute(__db, true, new Callable<Unit>() {
      @Override
      @NonNull
      public Unit call() throws Exception {
        final SupportSQLiteStatement _stmt = __preparedStmtOfMarkTombstone.acquire();
        int _argIndex = 1;
        _stmt.bindString(_argIndex, modified);
        _argIndex = 2;
        _stmt.bindString(_argIndex, title);
        try {
          __db.beginTransaction();
          try {
            _stmt.executeUpdateDelete();
            __db.setTransactionSuccessful();
            return Unit.INSTANCE;
          } finally {
            __db.endTransaction();
          }
        } finally {
          __preparedStmtOfMarkTombstone.release(_stmt);
        }
      }
    }, $completion);
  }

  @Override
  public Object purgeTombstone(final String title, final Continuation<? super Unit> $completion) {
    return CoroutinesRoom.execute(__db, true, new Callable<Unit>() {
      @Override
      @NonNull
      public Unit call() throws Exception {
        final SupportSQLiteStatement _stmt = __preparedStmtOfPurgeTombstone.acquire();
        int _argIndex = 1;
        _stmt.bindString(_argIndex, title);
        try {
          __db.beginTransaction();
          try {
            _stmt.executeUpdateDelete();
            __db.setTransactionSuccessful();
            return Unit.INSTANCE;
          } finally {
            __db.endTransaction();
          }
        } finally {
          __preparedStmtOfPurgeTombstone.release(_stmt);
        }
      }
    }, $completion);
  }

  @Override
  public Object delete(final String title, final Continuation<? super Unit> $completion) {
    return CoroutinesRoom.execute(__db, true, new Callable<Unit>() {
      @Override
      @NonNull
      public Unit call() throws Exception {
        final SupportSQLiteStatement _stmt = __preparedStmtOfDelete.acquire();
        int _argIndex = 1;
        _stmt.bindString(_argIndex, title);
        try {
          __db.beginTransaction();
          try {
            _stmt.executeUpdateDelete();
            __db.setTransactionSuccessful();
            return Unit.INSTANCE;
          } finally {
            __db.endTransaction();
          }
        } finally {
          __preparedStmtOfDelete.release(_stmt);
        }
      }
    }, $completion);
  }

  @Override
  public Object get(final String title, final Continuation<? super TiddlerEntity> $completion) {
    final String _sql = "SELECT * FROM tiddlers WHERE title = ? AND tombstone = 0 LIMIT 1";
    final RoomSQLiteQuery _statement = RoomSQLiteQuery.acquire(_sql, 1);
    int _argIndex = 1;
    _statement.bindString(_argIndex, title);
    final CancellationSignal _cancellationSignal = DBUtil.createCancellationSignal();
    return CoroutinesRoom.execute(__db, false, _cancellationSignal, new Callable<TiddlerEntity>() {
      @Override
      @Nullable
      public TiddlerEntity call() throws Exception {
        final Cursor _cursor = DBUtil.query(__db, _statement, false, null);
        try {
          final int _cursorIndexOfTitle = CursorUtil.getColumnIndexOrThrow(_cursor, "title");
          final int _cursorIndexOfHeaderJson = CursorUtil.getColumnIndexOrThrow(_cursor, "headerJson");
          final int _cursorIndexOfText = CursorUtil.getColumnIndexOrThrow(_cursor, "text");
          final int _cursorIndexOfRevision = CursorUtil.getColumnIndexOrThrow(_cursor, "revision");
          final int _cursorIndexOfModified = CursorUtil.getColumnIndexOrThrow(_cursor, "modified");
          final int _cursorIndexOfDirty = CursorUtil.getColumnIndexOrThrow(_cursor, "dirty");
          final int _cursorIndexOfTombstone = CursorUtil.getColumnIndexOrThrow(_cursor, "tombstone");
          final int _cursorIndexOfLastSynced = CursorUtil.getColumnIndexOrThrow(_cursor, "lastSynced");
          final TiddlerEntity _result;
          if (_cursor.moveToFirst()) {
            final String _tmpTitle;
            _tmpTitle = _cursor.getString(_cursorIndexOfTitle);
            final String _tmpHeaderJson;
            _tmpHeaderJson = _cursor.getString(_cursorIndexOfHeaderJson);
            final String _tmpText;
            _tmpText = _cursor.getString(_cursorIndexOfText);
            final String _tmpRevision;
            _tmpRevision = _cursor.getString(_cursorIndexOfRevision);
            final String _tmpModified;
            _tmpModified = _cursor.getString(_cursorIndexOfModified);
            final int _tmpDirty;
            _tmpDirty = _cursor.getInt(_cursorIndexOfDirty);
            final int _tmpTombstone;
            _tmpTombstone = _cursor.getInt(_cursorIndexOfTombstone);
            final long _tmpLastSynced;
            _tmpLastSynced = _cursor.getLong(_cursorIndexOfLastSynced);
            _result = new TiddlerEntity(_tmpTitle,_tmpHeaderJson,_tmpText,_tmpRevision,_tmpModified,_tmpDirty,_tmpTombstone,_tmpLastSynced);
          } else {
            _result = null;
          }
          return _result;
        } finally {
          _cursor.close();
          _statement.release();
        }
      }
    }, $completion);
  }

  @Override
  public Object getAll(final Continuation<? super List<TiddlerEntity>> $completion) {
    final String _sql = "SELECT * FROM tiddlers WHERE tombstone = 0";
    final RoomSQLiteQuery _statement = RoomSQLiteQuery.acquire(_sql, 0);
    final CancellationSignal _cancellationSignal = DBUtil.createCancellationSignal();
    return CoroutinesRoom.execute(__db, false, _cancellationSignal, new Callable<List<TiddlerEntity>>() {
      @Override
      @NonNull
      public List<TiddlerEntity> call() throws Exception {
        final Cursor _cursor = DBUtil.query(__db, _statement, false, null);
        try {
          final int _cursorIndexOfTitle = CursorUtil.getColumnIndexOrThrow(_cursor, "title");
          final int _cursorIndexOfHeaderJson = CursorUtil.getColumnIndexOrThrow(_cursor, "headerJson");
          final int _cursorIndexOfText = CursorUtil.getColumnIndexOrThrow(_cursor, "text");
          final int _cursorIndexOfRevision = CursorUtil.getColumnIndexOrThrow(_cursor, "revision");
          final int _cursorIndexOfModified = CursorUtil.getColumnIndexOrThrow(_cursor, "modified");
          final int _cursorIndexOfDirty = CursorUtil.getColumnIndexOrThrow(_cursor, "dirty");
          final int _cursorIndexOfTombstone = CursorUtil.getColumnIndexOrThrow(_cursor, "tombstone");
          final int _cursorIndexOfLastSynced = CursorUtil.getColumnIndexOrThrow(_cursor, "lastSynced");
          final List<TiddlerEntity> _result = new ArrayList<TiddlerEntity>(_cursor.getCount());
          while (_cursor.moveToNext()) {
            final TiddlerEntity _item;
            final String _tmpTitle;
            _tmpTitle = _cursor.getString(_cursorIndexOfTitle);
            final String _tmpHeaderJson;
            _tmpHeaderJson = _cursor.getString(_cursorIndexOfHeaderJson);
            final String _tmpText;
            _tmpText = _cursor.getString(_cursorIndexOfText);
            final String _tmpRevision;
            _tmpRevision = _cursor.getString(_cursorIndexOfRevision);
            final String _tmpModified;
            _tmpModified = _cursor.getString(_cursorIndexOfModified);
            final int _tmpDirty;
            _tmpDirty = _cursor.getInt(_cursorIndexOfDirty);
            final int _tmpTombstone;
            _tmpTombstone = _cursor.getInt(_cursorIndexOfTombstone);
            final long _tmpLastSynced;
            _tmpLastSynced = _cursor.getLong(_cursorIndexOfLastSynced);
            _item = new TiddlerEntity(_tmpTitle,_tmpHeaderJson,_tmpText,_tmpRevision,_tmpModified,_tmpDirty,_tmpTombstone,_tmpLastSynced);
            _result.add(_item);
          }
          return _result;
        } finally {
          _cursor.close();
          _statement.release();
        }
      }
    }, $completion);
  }

  @Override
  public Object getAllSkinny(final Continuation<? super List<TiddlerSkinny>> $completion) {
    final String _sql = "SELECT title, headerJson, revision, modified, dirty, tombstone FROM tiddlers WHERE tombstone = 0";
    final RoomSQLiteQuery _statement = RoomSQLiteQuery.acquire(_sql, 0);
    final CancellationSignal _cancellationSignal = DBUtil.createCancellationSignal();
    return CoroutinesRoom.execute(__db, false, _cancellationSignal, new Callable<List<TiddlerSkinny>>() {
      @Override
      @NonNull
      public List<TiddlerSkinny> call() throws Exception {
        final Cursor _cursor = DBUtil.query(__db, _statement, false, null);
        try {
          final int _cursorIndexOfTitle = 0;
          final int _cursorIndexOfHeaderJson = 1;
          final int _cursorIndexOfRevision = 2;
          final int _cursorIndexOfModified = 3;
          final int _cursorIndexOfDirty = 4;
          final int _cursorIndexOfTombstone = 5;
          final List<TiddlerSkinny> _result = new ArrayList<TiddlerSkinny>(_cursor.getCount());
          while (_cursor.moveToNext()) {
            final TiddlerSkinny _item;
            final String _tmpTitle;
            _tmpTitle = _cursor.getString(_cursorIndexOfTitle);
            final String _tmpHeaderJson;
            _tmpHeaderJson = _cursor.getString(_cursorIndexOfHeaderJson);
            final String _tmpRevision;
            _tmpRevision = _cursor.getString(_cursorIndexOfRevision);
            final String _tmpModified;
            _tmpModified = _cursor.getString(_cursorIndexOfModified);
            final int _tmpDirty;
            _tmpDirty = _cursor.getInt(_cursorIndexOfDirty);
            final int _tmpTombstone;
            _tmpTombstone = _cursor.getInt(_cursorIndexOfTombstone);
            _item = new TiddlerSkinny(_tmpTitle,_tmpHeaderJson,_tmpRevision,_tmpModified,_tmpDirty,_tmpTombstone);
            _result.add(_item);
          }
          return _result;
        } finally {
          _cursor.close();
          _statement.release();
        }
      }
    }, $completion);
  }

  @Override
  public Object getDirty(final Continuation<? super List<TiddlerEntity>> $completion) {
    final String _sql = "SELECT * FROM tiddlers WHERE dirty = 1 OR tombstone = 1";
    final RoomSQLiteQuery _statement = RoomSQLiteQuery.acquire(_sql, 0);
    final CancellationSignal _cancellationSignal = DBUtil.createCancellationSignal();
    return CoroutinesRoom.execute(__db, false, _cancellationSignal, new Callable<List<TiddlerEntity>>() {
      @Override
      @NonNull
      public List<TiddlerEntity> call() throws Exception {
        final Cursor _cursor = DBUtil.query(__db, _statement, false, null);
        try {
          final int _cursorIndexOfTitle = CursorUtil.getColumnIndexOrThrow(_cursor, "title");
          final int _cursorIndexOfHeaderJson = CursorUtil.getColumnIndexOrThrow(_cursor, "headerJson");
          final int _cursorIndexOfText = CursorUtil.getColumnIndexOrThrow(_cursor, "text");
          final int _cursorIndexOfRevision = CursorUtil.getColumnIndexOrThrow(_cursor, "revision");
          final int _cursorIndexOfModified = CursorUtil.getColumnIndexOrThrow(_cursor, "modified");
          final int _cursorIndexOfDirty = CursorUtil.getColumnIndexOrThrow(_cursor, "dirty");
          final int _cursorIndexOfTombstone = CursorUtil.getColumnIndexOrThrow(_cursor, "tombstone");
          final int _cursorIndexOfLastSynced = CursorUtil.getColumnIndexOrThrow(_cursor, "lastSynced");
          final List<TiddlerEntity> _result = new ArrayList<TiddlerEntity>(_cursor.getCount());
          while (_cursor.moveToNext()) {
            final TiddlerEntity _item;
            final String _tmpTitle;
            _tmpTitle = _cursor.getString(_cursorIndexOfTitle);
            final String _tmpHeaderJson;
            _tmpHeaderJson = _cursor.getString(_cursorIndexOfHeaderJson);
            final String _tmpText;
            _tmpText = _cursor.getString(_cursorIndexOfText);
            final String _tmpRevision;
            _tmpRevision = _cursor.getString(_cursorIndexOfRevision);
            final String _tmpModified;
            _tmpModified = _cursor.getString(_cursorIndexOfModified);
            final int _tmpDirty;
            _tmpDirty = _cursor.getInt(_cursorIndexOfDirty);
            final int _tmpTombstone;
            _tmpTombstone = _cursor.getInt(_cursorIndexOfTombstone);
            final long _tmpLastSynced;
            _tmpLastSynced = _cursor.getLong(_cursorIndexOfLastSynced);
            _item = new TiddlerEntity(_tmpTitle,_tmpHeaderJson,_tmpText,_tmpRevision,_tmpModified,_tmpDirty,_tmpTombstone,_tmpLastSynced);
            _result.add(_item);
          }
          return _result;
        } finally {
          _cursor.close();
          _statement.release();
        }
      }
    }, $completion);
  }

  @Override
  public Object count(final Continuation<? super Integer> $completion) {
    final String _sql = "SELECT COUNT(*) FROM tiddlers WHERE tombstone = 0";
    final RoomSQLiteQuery _statement = RoomSQLiteQuery.acquire(_sql, 0);
    final CancellationSignal _cancellationSignal = DBUtil.createCancellationSignal();
    return CoroutinesRoom.execute(__db, false, _cancellationSignal, new Callable<Integer>() {
      @Override
      @NonNull
      public Integer call() throws Exception {
        final Cursor _cursor = DBUtil.query(__db, _statement, false, null);
        try {
          final Integer _result;
          if (_cursor.moveToFirst()) {
            final int _tmp;
            _tmp = _cursor.getInt(0);
            _result = _tmp;
          } else {
            _result = 0;
          }
          return _result;
        } finally {
          _cursor.close();
          _statement.release();
        }
      }
    }, $completion);
  }

  @Override
  public Object countDirty(final Continuation<? super Integer> $completion) {
    final String _sql = "SELECT COUNT(*) FROM tiddlers WHERE dirty = 1";
    final RoomSQLiteQuery _statement = RoomSQLiteQuery.acquire(_sql, 0);
    final CancellationSignal _cancellationSignal = DBUtil.createCancellationSignal();
    return CoroutinesRoom.execute(__db, false, _cancellationSignal, new Callable<Integer>() {
      @Override
      @NonNull
      public Integer call() throws Exception {
        final Cursor _cursor = DBUtil.query(__db, _statement, false, null);
        try {
          final Integer _result;
          if (_cursor.moveToFirst()) {
            final int _tmp;
            _tmp = _cursor.getInt(0);
            _result = _tmp;
          } else {
            _result = 0;
          }
          return _result;
        } finally {
          _cursor.close();
          _statement.release();
        }
      }
    }, $completion);
  }

  @Override
  public Object getRecent(final int limit,
      final Continuation<? super List<TiddlerEntity>> $completion) {
    final String _sql = "SELECT * FROM tiddlers WHERE tombstone = 0 ORDER BY modified DESC LIMIT ?";
    final RoomSQLiteQuery _statement = RoomSQLiteQuery.acquire(_sql, 1);
    int _argIndex = 1;
    _statement.bindLong(_argIndex, limit);
    final CancellationSignal _cancellationSignal = DBUtil.createCancellationSignal();
    return CoroutinesRoom.execute(__db, false, _cancellationSignal, new Callable<List<TiddlerEntity>>() {
      @Override
      @NonNull
      public List<TiddlerEntity> call() throws Exception {
        final Cursor _cursor = DBUtil.query(__db, _statement, false, null);
        try {
          final int _cursorIndexOfTitle = CursorUtil.getColumnIndexOrThrow(_cursor, "title");
          final int _cursorIndexOfHeaderJson = CursorUtil.getColumnIndexOrThrow(_cursor, "headerJson");
          final int _cursorIndexOfText = CursorUtil.getColumnIndexOrThrow(_cursor, "text");
          final int _cursorIndexOfRevision = CursorUtil.getColumnIndexOrThrow(_cursor, "revision");
          final int _cursorIndexOfModified = CursorUtil.getColumnIndexOrThrow(_cursor, "modified");
          final int _cursorIndexOfDirty = CursorUtil.getColumnIndexOrThrow(_cursor, "dirty");
          final int _cursorIndexOfTombstone = CursorUtil.getColumnIndexOrThrow(_cursor, "tombstone");
          final int _cursorIndexOfLastSynced = CursorUtil.getColumnIndexOrThrow(_cursor, "lastSynced");
          final List<TiddlerEntity> _result = new ArrayList<TiddlerEntity>(_cursor.getCount());
          while (_cursor.moveToNext()) {
            final TiddlerEntity _item;
            final String _tmpTitle;
            _tmpTitle = _cursor.getString(_cursorIndexOfTitle);
            final String _tmpHeaderJson;
            _tmpHeaderJson = _cursor.getString(_cursorIndexOfHeaderJson);
            final String _tmpText;
            _tmpText = _cursor.getString(_cursorIndexOfText);
            final String _tmpRevision;
            _tmpRevision = _cursor.getString(_cursorIndexOfRevision);
            final String _tmpModified;
            _tmpModified = _cursor.getString(_cursorIndexOfModified);
            final int _tmpDirty;
            _tmpDirty = _cursor.getInt(_cursorIndexOfDirty);
            final int _tmpTombstone;
            _tmpTombstone = _cursor.getInt(_cursorIndexOfTombstone);
            final long _tmpLastSynced;
            _tmpLastSynced = _cursor.getLong(_cursorIndexOfLastSynced);
            _item = new TiddlerEntity(_tmpTitle,_tmpHeaderJson,_tmpText,_tmpRevision,_tmpModified,_tmpDirty,_tmpTombstone,_tmpLastSynced);
            _result.add(_item);
          }
          return _result;
        } finally {
          _cursor.close();
          _statement.release();
        }
      }
    }, $completion);
  }

  @NonNull
  public static List<Class<?>> getRequiredConverters() {
    return Collections.emptyList();
  }
}

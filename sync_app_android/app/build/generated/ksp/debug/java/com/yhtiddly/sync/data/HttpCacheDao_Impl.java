package com.yhtiddly.sync.data;

import android.database.Cursor;
import android.os.CancellationSignal;
import androidx.annotation.NonNull;
import androidx.annotation.Nullable;
import androidx.room.CoroutinesRoom;
import androidx.room.EntityInsertionAdapter;
import androidx.room.RoomDatabase;
import androidx.room.RoomSQLiteQuery;
import androidx.room.SharedSQLiteStatement;
import androidx.room.util.CursorUtil;
import androidx.room.util.DBUtil;
import androidx.sqlite.db.SupportSQLiteStatement;
import java.lang.Class;
import java.lang.Exception;
import java.lang.Object;
import java.lang.Override;
import java.lang.String;
import java.lang.SuppressWarnings;
import java.util.Collections;
import java.util.List;
import java.util.concurrent.Callable;
import javax.annotation.processing.Generated;
import kotlin.Unit;
import kotlin.coroutines.Continuation;

@Generated("androidx.room.RoomProcessor")
@SuppressWarnings({"unchecked", "deprecation"})
public final class HttpCacheDao_Impl implements HttpCacheDao {
  private final RoomDatabase __db;

  private final EntityInsertionAdapter<HttpCacheEntity> __insertionAdapterOfHttpCacheEntity;

  private final SharedSQLiteStatement __preparedStmtOfClear;

  private final SharedSQLiteStatement __preparedStmtOfDeleteByUrl;

  public HttpCacheDao_Impl(@NonNull final RoomDatabase __db) {
    this.__db = __db;
    this.__insertionAdapterOfHttpCacheEntity = new EntityInsertionAdapter<HttpCacheEntity>(__db) {
      @Override
      @NonNull
      protected String createQuery() {
        return "INSERT OR REPLACE INTO `http_cache` (`url`,`status`,`headers`,`bodyPath`,`etag`,`lastModified`,`updatedAt`) VALUES (?,?,?,?,?,?,?)";
      }

      @Override
      protected void bind(@NonNull final SupportSQLiteStatement statement,
          @NonNull final HttpCacheEntity entity) {
        statement.bindString(1, entity.getUrl());
        statement.bindLong(2, entity.getStatus());
        statement.bindString(3, entity.getHeaders());
        statement.bindString(4, entity.getBodyPath());
        if (entity.getEtag() == null) {
          statement.bindNull(5);
        } else {
          statement.bindString(5, entity.getEtag());
        }
        if (entity.getLastModified() == null) {
          statement.bindNull(6);
        } else {
          statement.bindString(6, entity.getLastModified());
        }
        statement.bindLong(7, entity.getUpdatedAt());
      }
    };
    this.__preparedStmtOfClear = new SharedSQLiteStatement(__db) {
      @Override
      @NonNull
      public String createQuery() {
        final String _query = "DELETE FROM http_cache";
        return _query;
      }
    };
    this.__preparedStmtOfDeleteByUrl = new SharedSQLiteStatement(__db) {
      @Override
      @NonNull
      public String createQuery() {
        final String _query = "DELETE FROM http_cache WHERE url = ?";
        return _query;
      }
    };
  }

  @Override
  public Object put(final HttpCacheEntity entry, final Continuation<? super Unit> $completion) {
    return CoroutinesRoom.execute(__db, true, new Callable<Unit>() {
      @Override
      @NonNull
      public Unit call() throws Exception {
        __db.beginTransaction();
        try {
          __insertionAdapterOfHttpCacheEntity.insert(entry);
          __db.setTransactionSuccessful();
          return Unit.INSTANCE;
        } finally {
          __db.endTransaction();
        }
      }
    }, $completion);
  }

  @Override
  public Object clear(final Continuation<? super Unit> $completion) {
    return CoroutinesRoom.execute(__db, true, new Callable<Unit>() {
      @Override
      @NonNull
      public Unit call() throws Exception {
        final SupportSQLiteStatement _stmt = __preparedStmtOfClear.acquire();
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
          __preparedStmtOfClear.release(_stmt);
        }
      }
    }, $completion);
  }

  @Override
  public Object deleteByUrl(final String url, final Continuation<? super Unit> $completion) {
    return CoroutinesRoom.execute(__db, true, new Callable<Unit>() {
      @Override
      @NonNull
      public Unit call() throws Exception {
        final SupportSQLiteStatement _stmt = __preparedStmtOfDeleteByUrl.acquire();
        int _argIndex = 1;
        _stmt.bindString(_argIndex, url);
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
          __preparedStmtOfDeleteByUrl.release(_stmt);
        }
      }
    }, $completion);
  }

  @Override
  public Object get(final String url, final Continuation<? super HttpCacheEntity> $completion) {
    final String _sql = "SELECT * FROM http_cache WHERE url = ? LIMIT 1";
    final RoomSQLiteQuery _statement = RoomSQLiteQuery.acquire(_sql, 1);
    int _argIndex = 1;
    _statement.bindString(_argIndex, url);
    final CancellationSignal _cancellationSignal = DBUtil.createCancellationSignal();
    return CoroutinesRoom.execute(__db, false, _cancellationSignal, new Callable<HttpCacheEntity>() {
      @Override
      @Nullable
      public HttpCacheEntity call() throws Exception {
        final Cursor _cursor = DBUtil.query(__db, _statement, false, null);
        try {
          final int _cursorIndexOfUrl = CursorUtil.getColumnIndexOrThrow(_cursor, "url");
          final int _cursorIndexOfStatus = CursorUtil.getColumnIndexOrThrow(_cursor, "status");
          final int _cursorIndexOfHeaders = CursorUtil.getColumnIndexOrThrow(_cursor, "headers");
          final int _cursorIndexOfBodyPath = CursorUtil.getColumnIndexOrThrow(_cursor, "bodyPath");
          final int _cursorIndexOfEtag = CursorUtil.getColumnIndexOrThrow(_cursor, "etag");
          final int _cursorIndexOfLastModified = CursorUtil.getColumnIndexOrThrow(_cursor, "lastModified");
          final int _cursorIndexOfUpdatedAt = CursorUtil.getColumnIndexOrThrow(_cursor, "updatedAt");
          final HttpCacheEntity _result;
          if (_cursor.moveToFirst()) {
            final String _tmpUrl;
            _tmpUrl = _cursor.getString(_cursorIndexOfUrl);
            final int _tmpStatus;
            _tmpStatus = _cursor.getInt(_cursorIndexOfStatus);
            final String _tmpHeaders;
            _tmpHeaders = _cursor.getString(_cursorIndexOfHeaders);
            final String _tmpBodyPath;
            _tmpBodyPath = _cursor.getString(_cursorIndexOfBodyPath);
            final String _tmpEtag;
            if (_cursor.isNull(_cursorIndexOfEtag)) {
              _tmpEtag = null;
            } else {
              _tmpEtag = _cursor.getString(_cursorIndexOfEtag);
            }
            final String _tmpLastModified;
            if (_cursor.isNull(_cursorIndexOfLastModified)) {
              _tmpLastModified = null;
            } else {
              _tmpLastModified = _cursor.getString(_cursorIndexOfLastModified);
            }
            final long _tmpUpdatedAt;
            _tmpUpdatedAt = _cursor.getLong(_cursorIndexOfUpdatedAt);
            _result = new HttpCacheEntity(_tmpUrl,_tmpStatus,_tmpHeaders,_tmpBodyPath,_tmpEtag,_tmpLastModified,_tmpUpdatedAt);
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

  @NonNull
  public static List<Class<?>> getRequiredConverters() {
    return Collections.emptyList();
  }
}

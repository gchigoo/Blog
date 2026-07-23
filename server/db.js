const Database = require('better-sqlite3');
const path = require('path');
const { migrateDatabase } = require('./migrations');

const DB_PATH = path.join(__dirname, '..', 'blog.db');

// 创建数据库连接
const db = new Database(DB_PATH);

console.log('数据库连接成功');

// 为并发读取、分析写入和后台发布提供稳定的 SQLite 运行参数。
db.pragma('foreign_keys = ON');
db.pragma('journal_mode = WAL');
db.pragma('synchronous = NORMAL');
db.pragma('busy_timeout = 5000');
migrateDatabase(db);

// 同步方法封装（better-sqlite3 是同步的）
const dbGet = (sql, params = []) => {
  try {
    const stmt = db.prepare(sql);
    return stmt.get(...params);
  } catch (error) {
    console.error('dbGet 错误:', error);
    throw error;
  }
};

const dbAll = (sql, params = []) => {
  try {
    const stmt = db.prepare(sql);
    return stmt.all(...params);
  } catch (error) {
    console.error('dbAll 错误:', error);
    throw error;
  }
};

const dbRun = (sql, params = []) => {
  try {
    const stmt = db.prepare(sql);
    const info = stmt.run(...params);
    return { id: info.lastInsertRowid, changes: info.changes };
  } catch (error) {
    console.error('dbRun 错误:', error);
    throw error;
  }
};

module.exports = {
  db,
  dbGet,
  dbAll,
  dbRun
};

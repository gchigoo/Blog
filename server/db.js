const Database = require('better-sqlite3');
const path = require('path');

const DB_PATH = path.join(__dirname, '..', 'blog.db');

// 创建数据库连接
const db = new Database(DB_PATH);

console.log('数据库连接成功');

// 启用外键支持
db.pragma('foreign_keys = ON');

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

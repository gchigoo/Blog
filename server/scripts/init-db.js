const Database = require('better-sqlite3');
const path = require('path');
const bcrypt = require('bcrypt');
const { validatePassword } = require('../utils/password');

const DB_PATH = path.join(__dirname, '..', '..', 'blog.db');
const ADMIN_USERNAME = 'admin';

console.log('正在初始化数据库...');

let db;

try {
  db = new Database(DB_PATH);

  // 文章表
  db.exec(`
    CREATE TABLE IF NOT EXISTS articles (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      slug TEXT UNIQUE NOT NULL,
      content TEXT NOT NULL,
      html TEXT NOT NULL,
      tags TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);
  console.log('✓ articles 表创建成功');

  // 创建索引
  db.exec('CREATE INDEX IF NOT EXISTS idx_created_at ON articles(created_at DESC)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_slug ON articles(slug)');
  console.log('✓ 索引创建成功');

  // 管理员用户表
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);
  console.log('✓ users 表创建成功');

  const existingUser = db.prepare('SELECT id FROM users WHERE username = ?').get(ADMIN_USERNAME);

  if (!existingUser) {
    const initialPassword = process.env.INITIAL_ADMIN_PASSWORD;
    const validationError = validatePassword(initialPassword);
    if (validationError) {
      throw new Error(`INITIAL_ADMIN_PASSWORD 无效：${validationError}`);
    }

    const hash = bcrypt.hashSync(initialPassword, 10);
    db.prepare('INSERT INTO users (username, password_hash) VALUES (?, ?)').run(ADMIN_USERNAME, hash);
    console.log('✓ 初始管理员账号创建成功');
    console.log(`  用户名: ${ADMIN_USERNAME}`);
  } else {
    console.log('✓ 管理员账号已存在');
  }

  console.log('\n数据库初始化完成！');
} catch (error) {
  console.error('数据库初始化失败:', error.message);
  process.exitCode = 1;
} finally {
  if (db) db.close();
}

const Database = require('better-sqlite3');
const path = require('path');
const bcrypt = require('bcrypt');

const DB_PATH = path.join(__dirname, '..', '..', 'blog.db');

console.log('正在初始化数据库...');

try {
  const db = new Database(DB_PATH);
  
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

  // 插入默认管理员账号
  const defaultUsername = 'admin';
  const defaultPassword = 'admin123';
  
  const existingUser = db.prepare('SELECT id FROM users WHERE username = ?').get(defaultUsername);
  
  if (!existingUser) {
    const hash = bcrypt.hashSync(defaultPassword, 10);
    db.prepare('INSERT INTO users (username, password_hash) VALUES (?, ?)').run(defaultUsername, hash);
    console.log('✓ 默认管理员账号创建成功');
    console.log('  用户名: admin');
    console.log('  密码: admin123');
    console.log('  ⚠️  请在首次登录后修改密码！');
  } else {
    console.log('✓ 管理员账号已存在');
  }

  db.close();
  console.log('\n数据库初始化完成！');
} catch (error) {
  console.error('数据库初始化失败:', error.message);
  process.exit(1);
}

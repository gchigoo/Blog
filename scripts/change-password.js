#!/usr/bin/env node
/**
 * 修改管理员密码脚本
 * 用法: node scripts/change-password.js [新密码]
 */

const Database = require('better-sqlite3');
const bcrypt = require('bcrypt');
const path = require('path');
const readline = require('readline');

const dbPath = path.join(__dirname, '../blog.db');

// 创建命令行输入接口
const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

console.log('\n╔══════════════════════════════════════════╗');
console.log('║      极简博客 - 密码修改工具            ║');
console.log('╚══════════════════════════════════════════╝\n');

// 从命令行参数获取新密码
const newPassword = process.argv[2];

if (newPassword) {
  // 如果提供了密码参数，直接修改
  changePassword(newPassword);
} else {
  // 否则交互式输入
  rl.question('请输入管理员用户名 (默认: admin): ', (username) => {
    const user = username.trim() || 'admin';
    
    rl.question('请输入新密码: ', (password) => {
      if (!password || password.length < 6) {
        console.error('❌ 密码长度至少 6 位！');
        rl.close();
        process.exit(1);
      }
      
      rl.question('请再次输入新密码: ', (confirmPassword) => {
        if (password !== confirmPassword) {
          console.error('❌ 两次密码不一致！');
          rl.close();
          process.exit(1);
        }
        
        changePassword(password, user);
        rl.close();
      });
    });
  });
}

async function changePassword(password, username = 'admin') {
  try {
    console.log('\n🔄 正在生成密码哈希...');
    
    // 生成密码哈希
    const hash = await bcrypt.hash(password, 10);
    
    console.log('🔄 正在更新数据库...');
    
    // 打开数据库
    const db = new Database(dbPath);
    
    // 更新密码
    const result = db.prepare(`
      UPDATE users 
      SET password = ?
      WHERE username = ?
    `).run(hash, username);
    
    db.close();
    
    if (result.changes === 0) {
      console.error(`\n❌ 用户 "${username}" 不存在！`);
      console.log('💡 提示：运行 node scripts/query-db.js 查看所有用户');
      process.exit(1);
    }
    
    console.log('\n✅ 密码修改成功！');
    console.log(`   用户名: ${username}`);
    console.log('   请使用新密码登录后台\n');
    
  } catch (error) {
    console.error('\n❌ 密码修改失败:', error.message);
    process.exit(1);
  }
}

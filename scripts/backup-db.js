#!/usr/bin/env node
/**
 * 数据库备份脚本
 * 用法: node scripts/backup-db.js
 */

const fs = require('fs');
const path = require('path');

const dbPath = path.join(__dirname, '../blog.db');
const backupDir = path.join(__dirname, '../backups');

console.log('\n╔══════════════════════════════════════════╗');
console.log('║      极简博客 - 数据库备份工具          ║');
console.log('╚══════════════════════════════════════════╝\n');

try {
  // 检查数据库是否存在
  if (!fs.existsSync(dbPath)) {
    console.error('❌ 数据库文件不存在:', dbPath);
    process.exit(1);
  }
  
  // 创建备份目录
  if (!fs.existsSync(backupDir)) {
    fs.mkdirSync(backupDir, { recursive: true });
    console.log('✅ 创建备份目录:', backupDir);
  }
  
  // 生成备份文件名（时间戳）
  const timestamp = new Date().toISOString()
    .replace(/[:.]/g, '-')
    .replace('T', '_')
    .split('.')[0];
  
  const backupPath = path.join(backupDir, `blog_${timestamp}.db`);
  
  console.log('🔄 正在备份数据库...');
  console.log(`   源文件: ${dbPath}`);
  console.log(`   目标文件: ${backupPath}`);
  
  // 复制数据库文件
  fs.copyFileSync(dbPath, backupPath);
  
  // 获取文件大小
  const stats = fs.statSync(backupPath);
  const fileSize = (stats.size / 1024).toFixed(2);
  
  console.log('\n✅ 备份完成！');
  console.log(`   文件大小: ${fileSize} KB`);
  console.log(`   备份位置: ${backupPath}`);
  
  // 列出所有备份
  console.log('\n📦 历史备份:');
  console.log('─'.repeat(50));
  
  const backups = fs.readdirSync(backupDir)
    .filter(file => file.startsWith('blog_') && file.endsWith('.db'))
    .map(file => {
      const filePath = path.join(backupDir, file);
      const stat = fs.statSync(filePath);
      return {
        name: file,
        path: filePath,
        size: stat.size,
        time: stat.mtime
      };
    })
    .sort((a, b) => b.time - a.time);
  
  if (backups.length === 0) {
    console.log('   暂无备份');
  } else {
    backups.forEach((backup, index) => {
      const size = (backup.size / 1024).toFixed(2);
      const time = backup.time.toLocaleString('zh-CN');
      console.log(`   ${index + 1}. ${backup.name}`);
      console.log(`      大小: ${size} KB, 时间: ${time}`);
    });
    
    // 显示总大小
    const totalSize = (backups.reduce((sum, b) => sum + b.size, 0) / 1024).toFixed(2);
    console.log(`\n   共 ${backups.length} 个备份文件，总大小: ${totalSize} KB`);
    
    // 如果备份超过 10 个，提示清理
    if (backups.length > 10) {
      console.log('\n💡 提示：备份文件较多，建议定期清理旧备份');
    }
  }
  
  console.log('\n');
  
} catch (error) {
  console.error('\n❌ 备份失败:', error.message);
  process.exit(1);
}

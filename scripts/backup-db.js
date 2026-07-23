#!/usr/bin/env node
/**
 * 数据库备份脚本
 * 用法: node scripts/backup-db.js
 */

const fs = require('node:fs');
const path = require('node:path');
const Database = require('better-sqlite3');
const { formatDate } = require('../server/utils/presentation');

const dbPath = path.join(__dirname, '../blog.db');
const backupDir = path.join(__dirname, '../backups');

function listBackups() {
  console.log('\n📦 历史备份:');
  console.log('─'.repeat(50));

  const backups = fs.readdirSync(backupDir)
    .filter(file => file.startsWith('blog_') && file.endsWith('.db'))
    .map(file => {
      const filePath = path.join(backupDir, file);
      const stat = fs.statSync(filePath);
      return {
        name: file,
        size: stat.size,
        time: stat.mtime
      };
    })
    .sort((a, b) => b.time.getTime() - a.time.getTime());

  backups.forEach((backup, index) => {
    console.log(`   ${index + 1}. ${backup.name}`);
    console.log(`      大小: ${(backup.size / 1024).toFixed(2)} KB, 时间: ${formatDate(backup.time, { dateStyle: 'medium', timeStyle: 'medium' })}`);
  });

  const totalSize = (backups.reduce((sum, backup) => sum + backup.size, 0) / 1024).toFixed(2);
  console.log(`\n   共 ${backups.length} 个备份文件，总大小: ${totalSize} KB`);
  if (backups.length > 10) {
    console.log('\n💡 提示：备份文件较多，建议定期清理旧备份');
  }
}

async function main() {
  console.log('\n╔══════════════════════════════════════════╗');
  console.log('║      极简博客 - 数据库备份工具          ║');
  console.log('╚══════════════════════════════════════════╝\n');

  if (!fs.existsSync(dbPath)) {
    throw new Error(`数据库文件不存在: ${dbPath}`);
  }

  if (!fs.existsSync(backupDir)) {
    fs.mkdirSync(backupDir, { recursive: true });
    console.log('✅ 创建备份目录:', backupDir);
  }

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupPath = path.join(backupDir, `blog_${timestamp}.db`);
  const temporaryBackupPath = `${backupPath}.tmp`;

  console.log('🔄 正在备份数据库...');
  console.log(`   源文件: ${dbPath}`);
  console.log(`   目标文件: ${backupPath}`);

  try {
    // SQLite online backup includes committed WAL pages and produces one
    // transactionally consistent database file while the application is running.
    const source = new Database(dbPath, { readonly: true, fileMustExist: true });
    try {
      await source.backup(temporaryBackupPath);
    } finally {
      source.close();
    }

    const verification = new Database(temporaryBackupPath, {
      readonly: true,
      fileMustExist: true
    });
    try {
      const result = verification.pragma('integrity_check', { simple: true });
      if (result !== 'ok') throw new Error(`备份完整性检查失败: ${result}`);
    } finally {
      verification.close();
    }

    fs.renameSync(temporaryBackupPath, backupPath);
  } catch (error) {
    fs.rmSync(temporaryBackupPath, { force: true });
    throw error;
  }

  const stats = fs.statSync(backupPath);
  console.log('\n✅ 备份完成！');
  console.log(`   文件大小: ${(stats.size / 1024).toFixed(2)} KB`);
  console.log(`   备份位置: ${backupPath}`);
  listBackups();
  console.log('\n');
}

main().catch(error => {
  console.error('\n❌ 备份失败:', error.message);
  process.exitCode = 1;
});

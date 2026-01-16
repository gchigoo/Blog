#!/usr/bin/env node
/**
 * 数据库查询脚本
 * 用法: node scripts/query-db.js
 */

const Database = require('better-sqlite3');
const path = require('path');

const dbPath = path.join(__dirname, '../blog.db');
const db = new Database(dbPath, { readonly: true });

console.log('\n╔══════════════════════════════════════════╗');
console.log('║      极简博客 - 数据库查询工具          ║');
console.log('╚══════════════════════════════════════════╝\n');

try {
  // 1. 统计信息
  console.log('📊 统计信息');
  console.log('─'.repeat(50));
  
  const stats = db.prepare(`
    SELECT 
      COUNT(*) as total,
      MIN(created_at) as first,
      MAX(created_at) as last
    FROM articles
  `).get();
  
  const userCount = db.prepare('SELECT COUNT(*) as count FROM users').get();
  
  console.log(`📝 文章总数: ${stats.total || 0}`);
  console.log(`👤 用户数量: ${userCount.count || 0}`);
  if (stats.total > 0) {
    console.log(`📅 最早发布: ${new Date(stats.first).toLocaleString('zh-CN')}`);
    console.log(`📅 最新发布: ${new Date(stats.last).toLocaleString('zh-CN')}`);
  }
  
  // 2. 所有文章列表
  console.log('\n\n📄 文章列表');
  console.log('─'.repeat(50));
  
  const articles = db.prepare(`
    SELECT id, title, slug, tags, created_at 
    FROM articles 
    ORDER BY created_at DESC
  `).all();
  
  if (articles.length === 0) {
    console.log('暂无文章');
  } else {
    articles.forEach((article, index) => {
      console.log(`\n${index + 1}. ${article.title}`);
      console.log(`   ID: ${article.id}`);
      console.log(`   Slug: ${article.slug}`);
      
      try {
        const tags = JSON.parse(article.tags || '[]');
        if (tags.length > 0) {
          console.log(`   标签: ${tags.join(', ')}`);
        }
      } catch (e) {
        console.log(`   标签: ${article.tags}`);
      }
      
      console.log(`   时间: ${new Date(article.created_at).toLocaleString('zh-CN')}`);
    });
  }
  
  // 3. 标签统计
  console.log('\n\n🏷️  标签统计');
  console.log('─'.repeat(50));
  
  const allTags = {};
  articles.forEach(article => {
    try {
      const tags = JSON.parse(article.tags || '[]');
      tags.forEach(tag => {
        allTags[tag] = (allTags[tag] || 0) + 1;
      });
    } catch (e) {
      // 忽略解析错误
    }
  });
  
  const sortedTags = Object.entries(allTags)
    .sort((a, b) => b[1] - a[1]);
  
  if (sortedTags.length === 0) {
    console.log('暂无标签');
  } else {
    sortedTags.forEach(([tag, count]) => {
      console.log(`   ${tag}: ${count} 篇`);
    });
  }
  
  // 4. 用户信息
  console.log('\n\n👥 用户列表');
  console.log('─'.repeat(50));
  
  const users = db.prepare(`
    SELECT id, username, created_at 
    FROM users 
    ORDER BY id
  `).all();
  
  users.forEach(user => {
    console.log(`   ${user.id}. ${user.username} (创建于 ${new Date(user.created_at).toLocaleString('zh-CN')})`);
  });
  
  console.log('\n');
  
} catch (error) {
  console.error('❌ 查询失败:', error.message);
  process.exit(1);
} finally {
  db.close();
}

#!/usr/bin/env node
/**
 * 数据库查询脚本
 * 用法: node scripts/query-db.js
 */

const Database = require('better-sqlite3');
const path = require('path');
const { formatDate } = require('../server/utils/presentation');

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
    console.log(`📅 最早发布: ${formatDate(stats.first, { dateStyle: 'medium', timeStyle: 'medium' })}`);
    console.log(`📅 最新发布: ${formatDate(stats.last, { dateStyle: 'medium', timeStyle: 'medium' })}`);
  }

  // 2. 所有文章列表（tags 已从 article_tags + tag_labels 规范化读取）
  console.log('\n\n📄 文章列表');
  console.log('─'.repeat(50));

  const articles = db.prepare(`
    SELECT articles.id, articles.title, articles.slug, articles.created_at, posts.translation_key
    FROM articles
    JOIN posts ON posts.id = articles.post_id
    ORDER BY articles.created_at DESC
  `).all();

  const tagRows = db.prepare(`
    SELECT article_tags.article_id AS article_id, tag_labels.name AS name, category_labels.name AS category_name
    FROM article_tags
    JOIN tag_labels ON tag_labels.tag_id = article_tags.tag_id AND tag_labels.locale = 'zh'
    JOIN tags ON tags.id = article_tags.tag_id
    JOIN category_labels ON category_labels.category_id = tags.category_id AND category_labels.locale = 'zh'
    ORDER BY article_tags.article_id, tag_labels.tag_id
  `).all();

  const tagsByArticle = new Map();
  for (const row of tagRows) {
    if (!tagsByArticle.has(row.article_id)) tagsByArticle.set(row.article_id, []);
    tagsByArticle.get(row.article_id).push(row.name);
  }

  if (articles.length === 0) {
    console.log('暂无文章');
  } else {
    articles.forEach((article, index) => {
      console.log(`\n${index + 1}. ${article.title}`);
      console.log(`   ID: ${article.id}`);
      console.log(`   Slug: ${article.slug}`);
      console.log(`   翻译键: ${article.translation_key}`);

      const tags = tagsByArticle.get(article.id) || [];
      if (tags.length > 0) {
        console.log(`   标签: ${tags.join(', ')}`);
      }

      console.log(`   时间: ${formatDate(article.created_at, { dateStyle: 'medium', timeStyle: 'medium' })}`);
    });
  }

  // 3. 标签统计
  console.log('\n\n🏷️  标签统计');
  console.log('─'.repeat(50));

  const allTags = {};
  for (const row of tagRows) {
    allTags[row.name] = (allTags[row.name] || 0) + 1;
  }

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
    console.log(`   ${user.id}. ${user.username} (创建于 ${formatDate(user.created_at, { dateStyle: 'medium', timeStyle: 'medium' })})`);
  });

  console.log('\n');

} catch (error) {
  console.error('❌ 查询失败:', error.message);
  process.exit(1);
} finally {
  db.close();
}

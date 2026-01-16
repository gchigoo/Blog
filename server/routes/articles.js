const express = require('express');
const router = express.Router();
const { dbGet, dbAll, dbRun } = require('../db');

/**
 * GET /api/articles
 * 获取文章列表（分页）
 */
router.get('/', (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const pageSize = parseInt(req.query.pageSize) || 20;
    const offset = (page - 1) * pageSize;
    
    // 获取文章列表
    const articles = dbAll(
      `SELECT id, title, slug, tags, created_at, updated_at 
       FROM articles 
       ORDER BY created_at DESC 
       LIMIT ? OFFSET ?`,
      [pageSize, offset]
    );
    
    // 获取总数
    const { total } = dbGet('SELECT COUNT(*) as total FROM articles');
    
    // 解析标签
    const articlesWithTags = articles.map(article => ({
      ...article,
      tags: article.tags ? JSON.parse(article.tags) : []
    }));
    
    res.json({
      articles: articlesWithTags,
      pagination: {
        page,
        pageSize,
        total,
        totalPages: Math.ceil(total / pageSize)
      }
    });
  } catch (error) {
    console.error('获取文章列表失败:', error);
    res.status(500).json({ error: '服务器错误' });
  }
});

/**
 * GET /api/articles/:slug
 * 获取文章详情
 */
router.get('/:slug', (req, res) => {
  try {
    const { slug } = req.params;
    
    const article = dbGet(
      'SELECT * FROM articles WHERE slug = ?',
      [slug]
    );
    
    if (!article) {
      return res.status(404).json({ error: '文章不存在' });
    }
    
    // 解析标签
    article.tags = article.tags ? JSON.parse(article.tags) : [];
    
    res.json(article);
  } catch (error) {
    console.error('获取文章详情失败:', error);
    res.status(500).json({ error: '服务器错误' });
  }
});

/**
 * GET /api/articles/tag/:tag
 * 根据标签获取文章
 */
router.get('/tag/:tag', (req, res) => {
  try {
    const { tag } = req.params;
    
    // 获取所有文章，然后过滤（SQLite 不支持 JSON 查询）
    const allArticles = dbAll(
      'SELECT id, title, slug, tags, created_at FROM articles ORDER BY created_at DESC'
    );
    
    // 过滤包含指定标签的文章
    const articles = allArticles
      .map(article => ({
        ...article,
        tags: article.tags ? JSON.parse(article.tags) : []
      }))
      .filter(article => article.tags.includes(tag));
    
    res.json({ tag, articles });
  } catch (error) {
    console.error('根据标签获取文章失败:', error);
    res.status(500).json({ error: '服务器错误' });
  }
});

/**
 * GET /api/tags
 * 获取所有标签及其文章数量
 */
router.get('/tags/all', (req, res) => {
  try {
    const articles = dbAll('SELECT tags FROM articles');
    
    // 统计标签
    const tagCount = {};
    articles.forEach(article => {
      if (article.tags) {
        const tags = JSON.parse(article.tags);
        tags.forEach(tag => {
          tagCount[tag] = (tagCount[tag] || 0) + 1;
        });
      }
    });
    
    // 转换为数组并排序
    const tags = Object.entries(tagCount)
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count);
    
    res.json(tags);
  } catch (error) {
    console.error('获取标签列表失败:', error);
    res.status(500).json({ error: '服务器错误' });
  }
});

/**
 * GET /api/archive
 * 获取归档（按年月分组）
 */
router.get('/archive/all', (req, res) => {
  try {
    const articles = dbAll(
      `SELECT id, title, slug, created_at 
       FROM articles 
       ORDER BY created_at DESC`
    );
    
    // 按年月分组
    const archive = {};
    articles.forEach(article => {
      const date = new Date(article.created_at);
      const year = date.getFullYear();
      const month = date.getMonth() + 1;
      
      if (!archive[year]) {
        archive[year] = {};
      }
      
      if (!archive[year][month]) {
        archive[year][month] = [];
      }
      
      archive[year][month].push({
        id: article.id,
        title: article.title,
        slug: article.slug,
        created_at: article.created_at
      });
    });
    
    res.json(archive);
  } catch (error) {
    console.error('获取归档失败:', error);
    res.status(500).json({ error: '服务器错误' });
  }
});

module.exports = router;

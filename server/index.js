const express = require('express');
const path = require('path');
const cookieParser = require('cookie-parser');
const config = require('./config');

const app = express();

// 中间件
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());
app.use(express.static(path.join(__dirname, '..', 'public')));

// 视图引擎
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, '..', 'views'));

// API 路由
app.use('/api/auth', require('./routes/auth'));
app.use('/api/articles', require('./routes/articles'));
app.use('/api/admin', require('./routes/admin'));

// 前台页面路由
const { dbGet, dbAll } = require('./db');
const { optionalAuth } = require('./middleware/auth');

// 首页 - 文章列表
app.get('/', optionalAuth, (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const pageSize = 20;
    const offset = (page - 1) * pageSize;
    
    const articles = dbAll(
      `SELECT id, title, slug, tags, created_at 
       FROM articles 
       ORDER BY created_at DESC 
       LIMIT ? OFFSET ?`,
      [pageSize, offset]
    );
    
    const { total } = dbGet('SELECT COUNT(*) as total FROM articles') || { total: 0 };
    
    const articlesWithTags = articles.map(article => ({
      ...article,
      tags: article.tags ? JSON.parse(article.tags) : []
    }));
    
    res.render('index', {
      articles: articlesWithTags,
      page,
      totalPages: Math.ceil(total / pageSize),
      user: req.user
    });
  } catch (error) {
    console.error('渲染首页失败:', error);
    res.status(500).send('服务器错误');
  }
});

// 文章详情页
app.get('/article/:slug', optionalAuth, (req, res) => {
  try {
    const { slug } = req.params;
    
    const article = dbGet(
      'SELECT * FROM articles WHERE slug = ?',
      [slug]
    );
    
    if (!article) {
      return res.status(404).render('404', { user: req.user });
    }
    
    article.tags = article.tags ? JSON.parse(article.tags) : [];
    
    res.render('article', { article, user: req.user });
  } catch (error) {
    console.error('渲染文章详情失败:', error);
    res.status(500).send('服务器错误');
  }
});

// 归档页面
app.get('/archive', optionalAuth, (req, res) => {
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
      
      archive[year][month].push(article);
    });
    
    res.render('archive', { archive, user: req.user });
  } catch (error) {
    console.error('渲染归档页面失败:', error);
    res.status(500).send('服务器错误');
  }
});

// 标签列表页
app.get('/tags', optionalAuth, (req, res) => {
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
    
    res.render('tags', { tags, user: req.user });
  } catch (error) {
    console.error('渲染标签页面失败:', error);
    res.status(500).send('服务器错误');
  }
});

// 标签文章列表
app.get('/tag/:tag', optionalAuth, (req, res) => {
  try {
    const { tag } = req.params;
    
    const allArticles = dbAll(
      'SELECT id, title, slug, tags, created_at FROM articles ORDER BY created_at DESC'
    );
    
    const articles = allArticles
      .map(article => ({
        ...article,
        tags: article.tags ? JSON.parse(article.tags) : []
      }))
      .filter(article => article.tags.includes(tag));
    
    res.render('tag', { tag, articles, user: req.user });
  } catch (error) {
    console.error('渲染标签文章列表失败:', error);
    res.status(500).send('服务器错误');
  }
});

// 关于页面
app.get('/about', optionalAuth, (req, res) => {
  try {
    res.render('about', { user: req.user });
  } catch (error) {
    console.error('渲染关于页面失败:', error);
    res.status(500).send('服务器错误');
  }
});

// 后台登录页
app.get('/admin/login', (req, res) => {
  res.render('admin/login');
});

// 后台管理页
const { authenticateToken } = require('./middleware/auth');

app.get('/admin', (req, res) => {
  // 检查是否已登录
  const token = req.cookies.token;
  if (!token) {
    return res.redirect('/admin/login');
  }
  
  try {
    const jwt = require('jsonwebtoken');
    const config = require('./config');
    jwt.verify(token, config.jwtSecret);
    res.redirect('/admin/upload');
  } catch (error) {
    res.redirect('/admin/login');
  }
});

app.get('/admin/upload', authenticateToken, (req, res) => {
  res.render('admin/upload', { user: req.user });
});

app.get('/admin/articles', authenticateToken, (req, res) => {
  try {
    const articles = dbAll(
      `SELECT id, title, slug, tags, created_at, updated_at 
       FROM articles 
       ORDER BY created_at DESC`
    );
    
    const articlesWithTags = articles.map(article => ({
      ...article,
      tags: article.tags ? JSON.parse(article.tags) : []
    }));
    
    res.render('admin/articles', { articles: articlesWithTags, user: req.user });
  } catch (error) {
    console.error('渲染后台文章列表失败:', error);
    res.status(500).send('服务器错误');
  }
});

// 404 页面
app.use((req, res) => {
  res.status(404).render('404', { user: req.user || null });
});

// 启动服务器
app.listen(config.port, () => {
  console.log(`博客服务器运行在 http://localhost:${config.port}`);
  console.log(`后台管理: http://localhost:${config.port}/admin`);
});

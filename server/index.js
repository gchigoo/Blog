const express = require('express');
const path = require('path');
const cookieParser = require('cookie-parser');
const config = require('./config').loadRuntimeConfig(process.env);

const { createAnalyticsModule } = require('./analytics/module');
const { AUDIO_FORMATS } = require('./article-audio/formats');
const { db, dbGet, dbAll } = require('./db');

const app = express();
app.set('trust proxy', 'loopback');
app.locals.commentsEnabled = config.comments.enabled;
app.locals.analyticsDetailsEnabled = config.analytics.detailsEnabled;
const analyticsModule = createAnalyticsModule({ db, config: config.analytics });
const articleAudioPath = new RegExp(
  `^/[a-z0-9]+(?:-[a-z0-9]+)*/[a-f0-9]{64}(${Object.keys(AUDIO_FORMATS)
    .map(extension => extension.replace('.', '\\.'))
    .join('|')})$`
);
const articleAudioStatic = express.static(
  path.resolve(__dirname, '..', config.audioDir),
  {
    setHeaders(res, filePath) {
      const format = AUDIO_FORMATS[path.extname(filePath)];
      if (format) res.setHeader('Content-Type', format.mimeType);
    }
  }
);

// 中间件
app.use(analyticsModule.publicContextRouter);
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

// 视图引擎
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, '..', 'views'));

let commentsModule = null;
if (config.comments.enabled) {
  const { createGoogleIdentityClient } = require('./comments/google-identity');
  const { createCommentsModule } = require('./comments/module');
  const identityClient = createGoogleIdentityClient({
    clientId: config.comments.googleClientId,
    clientSecret: config.comments.googleClientSecret,
    redirectUri: config.comments.googleRedirectUri
  });
  commentsModule = createCommentsModule({
    db,
    config: config.comments,
    identityClient
  });
  app.use(commentsModule.commenterSession);
  app.use(commentsModule.authRouter);
  app.use(commentsModule.publicRouter);
  app.use(commentsModule.adminRouter);
}

// API 路由
app.use('/api/auth', require('./routes/auth'));
app.use('/api/articles', require('./routes/articles'));
app.use('/api/admin/analytics', analyticsModule.adminApiRouter);
app.use('/api/admin', require('./routes/admin'));

// 公开页面采集必须位于 API 之后、公开页面与静态资源之前。
app.use(analyticsModule.collectorMiddleware);
app.use('/audio', (req, res, next) => {
  const match = articleAudioPath.exec(req.path);
  if (!match || !AUDIO_FORMATS[match[1]]) return res.sendStatus(404);
  articleAudioStatic(req, res, error => {
    if (error) return next(error);
    res.sendStatus(404);
  });
});
app.use(express.static(path.join(__dirname, '..', 'public')));
app.use(analyticsModule.adminPageRouter);

// 前台页面路由
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
    
    const comments = commentsModule
      ? commentsModule.getArticleCommentsViewModel(article.id, {
        commenter: req.commenter,
        csrfToken: req.commentSession?.csrfToken || null
      })
      : { enabled: false };

    res.render('article', { article, user: req.user, comments });
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
let server = null;
let stopping = false;

async function stop() {
  if (stopping) return;
  stopping = true;
  if (server) {
    await new Promise(resolve => server.close(resolve));
  }
  analyticsModule.lifecycle.stop();
  db.close();
}

async function start() {
  await analyticsModule.lifecycle.start();
  server = app.listen(config.port, () => {
    console.log(`博客服务器运行在 http://localhost:${config.port}`);
    console.log(`后台管理: http://localhost:${config.port}/admin`);
  });
}

for (const signal of ['SIGTERM', 'SIGINT']) {
  process.once(signal, () => {
    stop().finally(() => process.exit(0));
  });
}

start().catch(error => {
  console.error(`[analytics] startup failed: ${error.message}`);
  analyticsModule.lifecycle.stop();
  db.close();
  process.exitCode = 1;
});

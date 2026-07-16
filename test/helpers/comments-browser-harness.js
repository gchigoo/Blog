const express = require('express');
const cookieParser = require('cookie-parser');
const Database = require('better-sqlite3');
const jwt = require('jsonwebtoken');
const path = require('node:path');
const appConfig = require('../../server/config');
const { parseCommentsConfig } = require('../../server/comments/config');
const { createCommentsModule } = require('../../server/comments/module');
const {
  createTokenService,
  randomBase64Url,
  sessionCookieOptions
} = require('../../server/comments/security');

const SESSION_SECRET = 'browser-harness-secret-0123456789abcdef';
const clock = { now: () => new Date() };
const db = new Database(':memory:');
db.pragma('foreign_keys = ON');
db.exec(`
  CREATE TABLE articles (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    slug TEXT NOT NULL UNIQUE,
    content TEXT NOT NULL,
    html TEXT NOT NULL,
    tags TEXT,
    created_at TEXT NOT NULL
  );
  CREATE TABLE users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL UNIQUE
  );
  INSERT INTO articles (title, slug, content, html, tags, created_at)
  VALUES (
    'Node 24 评论区浏览器验收',
    'comments-browser-smoke',
    'body',
    '<h2>浏览器验收文章</h2><p>用于验证评论区的公开状态与审核交互。</p>',
    '["Node.js", "评论"]',
    '2026-07-16T00:00:00.000Z'
  );
  INSERT INTO articles (title, slug, content, html, tags, created_at)
  VALUES (
    '暂无评论的文章',
    'comments-empty',
    'body',
    '<p>用于验证评论区空状态。</p>',
    '[]',
    '2026-07-16T00:01:00.000Z'
  );
  INSERT INTO users (username) VALUES ('browser-admin');
`);
db.prepare('UPDATE articles SET title = ? WHERE id = 1').run('T'.repeat(80));

const commentsConfig = parseCommentsConfig({
  GOOGLE_CLIENT_ID: 'browser-harness-client',
  GOOGLE_CLIENT_SECRET: 'browser-harness-client-secret',
  GOOGLE_REDIRECT_URI: 'http://127.0.0.1:3000/auth/google/callback',
  COMMENT_SESSION_SECRET: SESSION_SECRET,
  NODE_ENV: 'test'
});
const identityClient = {
  createAuthorizationUrl: () => 'https://accounts.google.com/o/oauth2/v2/auth',
  exchangeCode: async () => ({ subject: 'unused', displayName: 'unused' })
};
const commentsModule = createCommentsModule({
  db,
  config: commentsConfig,
  identityClient,
  clock
});
const commenter = db.prepare(`
  INSERT INTO comment_users (google_sub, display_name, created_at, updated_at, last_login_at)
  VALUES (?, ?, ?, ?, ?)
  RETURNING id
`).get(
  'browser-commenter',
  'N'.repeat(80),
  '2026-07-16T00:00:00.000Z',
  '2026-07-16T00:00:00.000Z',
  '2026-07-16T00:00:00.000Z'
);
db.prepare(`
  INSERT INTO comments (article_id, comment_user_id, content, status, created_at)
  VALUES (1, ?, ?, ?, ?)
`).run(
  commenter.id,
  '这是一条已经审核通过的长评论，用来确认移动端不会横向溢出。\n第二行会保留换行，并继续使用纯文本显示。',
  'approved',
  '2026-07-16T00:10:00.000Z'
);
db.prepare(`
  INSERT INTO comments (article_id, comment_user_id, content, status, created_at)
  VALUES (1, ?, ?, ?, ?)
`).run(
  commenter.id,
  '<script>待审核内容必须转义</script>',
  'pending',
  '2026-07-16T00:11:00.000Z'
);
db.prepare(`
  INSERT INTO comments (article_id, comment_user_id, content, status, created_at)
  VALUES (1, ?, ?, ?, ?)
`).run(
  commenter.id,
  '已经拒绝的评论',
  'rejected',
  '2026-07-16T00:12:00.000Z'
);

const app = express();
app.set('trust proxy', 'loopback');
app.set('view engine', 'ejs');
app.set('views', path.resolve(__dirname, '..', '..', 'views'));
app.locals.commentsEnabled = true;
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());
app.use(express.static(path.resolve(__dirname, '..', '..', 'public')));
app.use(commentsModule.commenterSession);

const tokens = createTokenService(SESSION_SECRET, clock);
app.get('/__test/commenter-login', (req, res) => {
  res.cookie('comment_session', tokens.createSession({
    commenterId: commenter.id,
    csrfToken: randomBase64Url()
  }), sessionCookieOptions(false));
  res.redirect('/article/comments-browser-smoke');
});
app.get('/__test/commenter-logout', (req, res) => {
  res.clearCookie('comment_session', sessionCookieOptions(false, false));
  res.redirect('/article/comments-browser-smoke');
});
app.get('/__test/admin-login', (req, res) => {
  res.cookie('token', jwt.sign({ id: 1, username: 'browser-admin' }, appConfig.jwtSecret, {
    expiresIn: '5m'
  }), {
    httpOnly: true,
    sameSite: 'strict',
    path: '/'
  });
  res.redirect('/admin/comments');
});

app.use(commentsModule.authRouter);
app.use(commentsModule.publicRouter);
app.use(commentsModule.adminRouter);

app.get('/article/:slug', (req, res) => {
  const article = db.prepare('SELECT * FROM articles WHERE slug = ?').get(req.params.slug);
  if (!article) return res.status(404).end();
  article.tags = JSON.parse(article.tags || '[]');
  return res.render('article', {
    article,
    user: null,
    comments: commentsModule.getArticleCommentsViewModel(article.id, {
      commenter: req.commenter,
      csrfToken: req.commentSession?.csrfToken || null
    })
  });
});

app.get('/disabled/article', (req, res) => {
  const article = db.prepare('SELECT * FROM articles WHERE id = 1').get();
  article.tags = JSON.parse(article.tags || '[]');
  res.render('article', { article, user: null, comments: { enabled: false } });
});

const server = app.listen(Number(process.env.BROWSER_HARNESS_PORT || 0), '127.0.0.1', () => {
  const { port } = server.address();
  console.log(`BROWSER_HARNESS_URL=http://127.0.0.1:${port}`);
});

function shutdown() {
  server.close(() => {
    db.close();
    process.exit(0);
  });
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

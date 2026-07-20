process.env.TZ = 'Asia/Shanghai';
process.env.JWT_SECRET ||= 'ejs-visual-admin-secret-0123456789abcdef';

const NativeDate = Date;
const FIXED_NOW_MS = NativeDate.parse('2026-07-17T08:00:00.000Z');
function FixedDate(...args) {
  if (!new.target) return new NativeDate(FIXED_NOW_MS).toString();
  return args.length === 0 ? new NativeDate(FIXED_NOW_MS) : new NativeDate(...args);
}
Object.setPrototypeOf(FixedDate, NativeDate);
FixedDate.prototype = NativeDate.prototype;
FixedDate.now = () => FIXED_NOW_MS;
global.Date = FixedDate;

const express = require('express');
const cookieParser = require('cookie-parser');
const crypto = require('node:crypto');
const Database = require('better-sqlite3');
const fs = require('node:fs');
const jwt = require('jsonwebtoken');
const path = require('node:path');
const appConfig = require('../../server/config');
const { parseCommentsConfig } = require('../../server/comments/config');
const { createCommentsModule } = require('../../server/comments/module');
const { createTokenService, sessionCookieOptions } = require('../../server/comments/security');
const { renderMarkdown } = require('../../server/utils/markdown');

const PORT = Number(process.env.BROWSER_HARNESS_PORT || 4173);
const SESSION_SECRET = 'ejs-visual-session-secret-0123456789abcdef';
const FIXED_NOW = new Date(FIXED_NOW_MS);
const clock = { now: () => new Date(FIXED_NOW) };
const db = new Database(':memory:');
const AUDIO_FIXTURE_DIRECTORY = path.resolve(__dirname, '..', 'fixtures', 'article-audio');
const AUDIO_FIXTURES = [
  { extension: 'mp3', mimeType: 'audio/mpeg', title: 'Stay Until Tomorrow' },
  { extension: 'aac', mimeType: 'audio/aac', title: 'AAC-LC ADTS Mix' },
  { extension: 'm4a', mimeType: 'audio/mp4', title: 'AAC-LC M4A Mix' },
  { extension: 'flac', mimeType: 'audio/flac', title: 'Lossless FLAC Mix' }
].map(fixture => {
  const buffer = fs.readFileSync(path.join(AUDIO_FIXTURE_DIRECTORY, `tone.${fixture.extension}`));
  const hash = crypto.createHash('sha256').update(buffer).digest('hex');
  return {
    ...fixture,
    buffer,
    fileName: `${hash}.${fixture.extension}`,
    src: `/audio/audio-browser/${hash}.${fixture.extension}`
  };
});
const AUDIO_FIXTURES_BY_FILE = new Map(AUDIO_FIXTURES.map(fixture => [fixture.fileName, fixture]));
const AUDIO_ARTICLE_HTML = renderMarkdown(`## 从灵感到最终混音

我先记录歌词、旋律与声音实验，再把最终版本放在文章中。

${AUDIO_FIXTURES.map(fixture => `:::audio
title: ${fixture.title}
artist: AI Voice Experiment
src: ./audio/tone.${fixture.extension}
caption: ${fixture.extension.toUpperCase()} 合成音频播放验证
:::`).join('\n\n')}`, {
  resolvedAudioBlocks: AUDIO_FIXTURES.map(fixture => ({
    src: fixture.src,
    mimeType: fixture.mimeType
  }))
});

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
  INSERT INTO users (username) VALUES ('visual-admin');
`);

const insertArticle = db.prepare(`
  INSERT INTO articles (title, slug, content, html, tags, created_at)
  VALUES (@title, @slug, @content, @html, @tags, @created_at)
`);

const articleFixtures = [
  {
    title: '从 EJS 3 升级到 EJS 6：保持页面像素级一致的实践记录',
    slug: 'comments-browser-smoke',
    content: 'visual fixture',
    html: '<h2>升级目标</h2><p>依赖升级前后保持完全一致的 HTML、布局和样式。</p><blockquote>先冻结行为，再替换依赖。</blockquote><h3>验证清单</h3><ul><li>HTML 快照</li><li>六档设备截图</li><li>人工目视确认</li></ul><pre><code>npm run test:visual</code></pre>',
    tags: JSON.stringify(['EJS', 'upgrade', '视觉回归']),
    created_at: '2026-07-16T01:30:00.000Z'
  },
  {
    title: '暂无评论的文章',
    slug: 'comments-empty',
    content: 'visual fixture',
    html: '<h2>空状态</h2><p>这个页面用于固定评论区尚无公开评论时的布局。</p>',
    tags: JSON.stringify(['测试']),
    created_at: '2026-07-15T03:00:00.000Z'
  },
  {
    title: '评论功能关闭时的文章详情',
    slug: 'comments-disabled',
    content: 'visual fixture',
    html: '<h2>正文保持不变</h2><p>评论功能关闭时，文章页不渲染评论区域。</p><table><thead><tr><th>版本</th><th>状态</th></tr></thead><tbody><tr><td>EJS 3</td><td>基线</td></tr><tr><td>EJS 6</td><td>待验证</td></tr></tbody></table>',
    tags: JSON.stringify(['EJS', 'upgrade']),
    created_at: '2026-07-14T05:20:00.000Z'
  },
  {
    title: 'Node.js 24 下的服务端模板测试策略',
    slug: 'node-24-template-tests',
    content: 'visual fixture',
    html: '<p>用于首页、归档和标签页面的固定数据。</p>',
    tags: JSON.stringify(['Node.js', '测试']),
    created_at: '2026-06-20T08:00:00.000Z'
  },
  {
    title: '把外部样式与字体固定到本地测试资源',
    slug: 'pin-browser-assets',
    content: 'visual fixture',
    html: '<p>消除 CDN 和字体响应漂移。</p>',
    tags: JSON.stringify(['CSS', 'upgrade']),
    created_at: '2025-12-08T09:00:00.000Z'
  }
];
for (const article of articleFixtures) insertArticle.run(article);

const commentsConfig = parseCommentsConfig({
  GOOGLE_CLIENT_ID: 'ejs-visual-client',
  GOOGLE_CLIENT_SECRET: 'ejs-visual-client-secret',
  GOOGLE_REDIRECT_URI: `http://127.0.0.1:${PORT}/auth/google/callback`,
  COMMENT_SESSION_SECRET: SESSION_SECRET,
  NODE_ENV: 'test'
});
const commentsModule = createCommentsModule({
  db,
  config: commentsConfig,
  identityClient: {
    createAuthorizationUrl: () => 'https://accounts.google.com/o/oauth2/v2/auth',
    exchangeCode: async () => ({ subject: 'unused', displayName: 'unused' })
  },
  clock
});

const commenter = db.prepare(`
  INSERT INTO comment_users (google_sub, display_name, created_at, updated_at, last_login_at)
  VALUES (?, ?, ?, ?, ?)
  RETURNING id
`).get(
  'ejs-visual-commenter',
  '视觉基线评论者',
  '2026-07-16T00:00:00.000Z',
  '2026-07-16T00:00:00.000Z',
  '2026-07-16T00:00:00.000Z'
);

const insertComment = db.prepare(`
  INSERT INTO comments (article_id, comment_user_id, content, status, created_at)
  VALUES (1, ?, ?, ?, ?)
`);
insertComment.run(
  commenter.id,
  '这是一条已经审核通过的长评论，用来确认桌面和移动端都不会横向溢出。\n第二行保留换行，并继续以纯文本显示。',
  'approved',
  '2026-07-16T02:00:00.000Z'
);
insertComment.run(
  commenter.id,
  '<script>待审核内容必须作为纯文本显示</script>',
  'pending',
  '2026-07-16T02:05:00.000Z'
);
insertComment.run(
  commenter.id,
  '已经拒绝的评论，用于固定审核状态筛选。',
  'rejected',
  '2026-07-16T02:10:00.000Z'
);

function normalizeArticle(row) {
  return { ...row, tags: JSON.parse(row.tags || '[]') };
}

function allArticles() {
  return db.prepare('SELECT * FROM articles ORDER BY created_at DESC, id DESC')
    .all()
    .map(normalizeArticle);
}

function renderHome(res, user) {
  return res.render('index', {
    articles: allArticles(),
    page: 1,
    totalPages: 3,
    user
  });
}

const emptyDimension = Object.freeze({
  items: [],
  distinctCount: 0,
  truncated: false,
  otherPageViews: 0
});

function dimension(items) {
  return {
    items,
    distinctCount: items.length,
    truncated: false,
    otherPageViews: 0
  };
}

function analyticsViewModel() {
  const overview = {
    days: 7,
    pageViews: 128,
    anonymousVisitors: 46,
    detailCoverage: { pageViews: 116 },
    byHour: [],
    byDevice: [{ deviceKind: 'desktop', pageViews: 82 }, { deviceKind: 'mobile', pageViews: 46 }],
    byPage: [
      { displayPath: '/', pageViews: 52, anonymousVisitors: 31 },
      { displayPath: '/article/comments-browser-smoke', pageViews: 44, anonymousVisitors: 25 },
      { displayPath: '/tag/upgrade', pageViews: 32, anonymousVisitors: 18 }
    ],
    byCountry: dimension([{ key: 'CN', label: '中国', pageViews: 91 }, { key: 'US', label: '美国', pageViews: 25 }]),
    bySubdivision: dimension([{ key: 'CN:beijing', label: '中国 / 北京', pageViews: 57 }]),
    byCity: dimension([{ key: 'CN:beijing', label: '中国 / 北京', pageViews: 43 }]),
    byBrowser: dimension([{ key: 'chrome', label: 'Chrome', pageViews: 76 }, { key: 'safari', label: 'Safari', pageViews: 39 }]),
    byOs: dimension([{ key: 'windows', label: 'Windows', pageViews: 63 }, { key: 'ios', label: 'iOS', pageViews: 38 }]),
    byDeviceModel: dimension([{ key: 'iphone', label: 'Apple iPhone', pageViews: 34 }]),
    byReferrerHost: dimension([{ key: 'google.com', label: 'google.com', pageViews: 28 }]),
    geoData: {
      reader: { datasetDate: '2026-07-15T00:00:00.000Z', reloadStatus: 'ok' },
      updater: { state: 'ok', result: 'updated', lastSuccessAt: '2026-07-17T00:00:00.000Z' },
      stale: false
    }
  };
  const events = {
    days: 7,
    nextCursor: null,
    items: [
      {
        id: '11111111111111111111111111111111',
        observedAtUtc: '2026-07-17T07:30:00.000Z',
        displayPath: '/article/comments-browser-smoke',
        ipAddress: '203.0.113.10',
        location: {
          country: { code: 'CN', name: '中国' },
          subdivision: { code: 'BJ', name: '北京' },
          city: '北京'
        },
        client: {
          deviceType: 'desktop',
          browser: { name: 'Chrome', version: '126' },
          os: { name: 'Windows', version: '11' }
        },
        referrer: 'https://www.google.com/'
      },
      {
        id: '22222222222222222222222222222222',
        observedAtUtc: '2026-07-17T06:20:00.000Z',
        displayPath: '/',
        ipAddress: '198.51.100.24',
        location: {
          country: { code: 'US', name: '美国' },
          subdivision: { code: 'CA', name: 'California' },
          city: 'San Francisco'
        },
        client: {
          deviceType: 'mobile',
          browser: { name: 'Safari', version: '19' },
          os: { name: 'iOS', version: '19' }
        },
        referrer: null
      }
    ]
  };
  return {
    overview,
    events,
    filters: {
      days: '7', ip: '', country: '', subdivision: '', city: '', browser: '',
      os: '', device: '', pathPrefix: '', referrerHost: ''
    },
    eventNextUrl: null,
    pageError: null,
    formatBeijingTime: value => new Intl.DateTimeFormat('zh-CN', {
      timeZone: 'Asia/Shanghai',
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23'
    }).format(new Date(value)),
    user: { id: 1, username: 'visual-admin' }
  };
}

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
app.get('/__visual/ready', (req, res) => res.type('text').send('ready'));
app.get('/audio/audio-browser/:fileName', (req, res) => {
  const fixture = AUDIO_FIXTURES_BY_FILE.get(req.params.fileName);
  if (!fixture) return res.sendStatus(404);
  const range = req.get('range');
  res.set('Content-Type', fixture.mimeType);
  res.set('Accept-Ranges', 'bytes');
  if (!range) {
    res.set('Content-Length', String(fixture.buffer.length));
    return res.send(fixture.buffer);
  }

  const match = /^bytes=(\d+)-(\d*)$/.exec(range);
  if (!match) {
    res.set('Content-Range', `bytes */${fixture.buffer.length}`);
    return res.status(416).end();
  }
  const start = Number(match[1]);
  const end = match[2] ? Number(match[2]) : fixture.buffer.length - 1;
  if (start > end || end >= fixture.buffer.length) {
    res.set('Content-Range', `bytes */${fixture.buffer.length}`);
    return res.status(416).end();
  }
  const chunk = fixture.buffer.subarray(start, end + 1);
  res.status(206);
  res.set('Content-Range', `bytes ${start}-${end}/${fixture.buffer.length}`);
  res.set('Content-Length', String(chunk.length));
  return res.send(chunk);
});
app.get('/__test/commenter-login', (req, res) => {
  res.cookie('comment_session', tokens.createSession({
    commenterId: commenter.id,
    csrfToken: 'visual-csrf-token-0123456789abcdef'
  }), sessionCookieOptions(false));
  res.redirect('/article/comments-browser-smoke');
});
app.get('/__test/admin-login', (req, res) => {
  res.cookie('token', jwt.sign({ id: 1, username: 'visual-admin' }, appConfig.jwtSecret, {
    expiresIn: '10m'
  }), {
    httpOnly: true,
    sameSite: 'strict',
    path: '/'
  });
  res.redirect('/admin/comments?status=pending');
});

app.use(commentsModule.authRouter);
app.use(commentsModule.publicRouter);
app.use(commentsModule.adminRouter);

app.get('/', (req, res) => renderHome(res, null));
app.get('/__visual/home-admin', (req, res) => renderHome(res, {
  id: 1,
  username: 'visual-admin'
}));
app.get('/article/comments-disabled', (req, res) => {
  const article = normalizeArticle(db.prepare('SELECT * FROM articles WHERE slug = ?').get('comments-disabled'));
  return res.render('article', { article, user: null, comments: { enabled: false } });
});
app.get('/__audio/article', (req, res) => res.render('article', {
  article: {
    id: 99,
    title: '一次 AI 歌曲实验：从过程到成品',
    slug: 'audio-browser',
    content: 'audio browser fixture',
    html: AUDIO_ARTICLE_HTML,
    tags: ['AI', '音乐', '创作过程'],
    created_at: '2026-07-17T08:00:00.000Z'
  },
  user: null,
  comments: { enabled: false }
}));
app.get('/article/:slug', (req, res) => {
  const row = db.prepare('SELECT * FROM articles WHERE slug = ?').get(req.params.slug);
  if (!row) return res.status(404).render('404', { user: null });
  const article = normalizeArticle(row);
  return res.render('article', {
    article,
    user: null,
    comments: commentsModule.getArticleCommentsViewModel(article.id, {
      commenter: req.commenter,
      csrfToken: req.commentSession?.csrfToken || null
    })
  });
});
app.get('/archive', (req, res) => {
  const archive = {};
  for (const article of allArticles()) {
    const date = new Date(article.created_at);
    const year = String(date.getFullYear());
    const month = String(date.getMonth() + 1);
    archive[year] ||= {};
    archive[year][month] ||= [];
    archive[year][month].push(article);
  }
  return res.render('archive', { archive, user: null });
});
app.get('/tags', (req, res) => res.render('tags', {
  tags: [
    { name: 'upgrade', count: 3 },
    { name: 'EJS', count: 2 },
    { name: '测试', count: 2 },
    { name: 'Node.js', count: 1 },
    { name: 'CSS', count: 1 },
    { name: '视觉回归', count: 1 }
  ],
  user: null
}));
app.get('/tag/upgrade', (req, res) => res.render('tag', {
  tag: 'upgrade',
  articles: allArticles().filter(article => article.tags.includes('upgrade')),
  user: null
}));
app.get('/about', (req, res) => res.render('about', { user: null }));
app.get('/admin/login', (req, res) => res.render('admin/login'));
app.get('/admin/upload', (req, res) => res.render('admin/upload', {
  user: { id: 1, username: 'visual-admin' }
}));
app.get('/admin/articles', (req, res) => res.render('admin/articles', {
  articles: allArticles(),
  user: { id: 1, username: 'visual-admin' }
}));
app.get('/admin/analytics', (req, res) => res.render('admin/analytics', analyticsViewModel()));
app.get('/visual-not-found', (req, res) => res.status(200).render('404', { user: null }));
app.use((req, res) => res.status(404).render('404', { user: null }));

const server = app.listen(PORT, '127.0.0.1', () => {
  console.log(`EJS_VISUAL_HARNESS_URL=http://127.0.0.1:${PORT}`);
});

function shutdown() {
  server.close(() => {
    db.close();
    process.exit(0);
  });
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

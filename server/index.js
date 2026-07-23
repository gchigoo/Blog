const express = require('express');
const path = require('path');
const cookieParser = require('cookie-parser');
const config = require('./config').loadRuntimeConfig(process.env);

const { createAnalyticsModule } = require('./analytics/module');
const { AUDIO_FORMATS } = require('./article-audio/formats');
const { db } = require('./db');
const { createPagesRouter } = require('./routes/pages');
const { createArticleService } = require('./services/articles');
const { assetUrl, formatDate, formatYear } = require('./utils/presentation');
const { validateRuntimePaths } = require('./utils/runtime-paths');

validateRuntimePaths(config);

const app = express();
app.set('trust proxy', 'loopback');
app.disable('x-powered-by');
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, '..', 'views'));
app.locals.commentsEnabled = config.comments.enabled;
app.locals.analyticsDetailsEnabled = config.analytics.detailsEnabled;
app.locals.assetUrl = assetUrl;
app.locals.formatDate = formatDate;
app.locals.formatYear = formatYear;
app.locals.site = config.site;

const articleService = createArticleService(db);
const analyticsModule = createAnalyticsModule({ db, config: config.analytics });
const articleAudioPath = new RegExp(
  `^/[a-z0-9]+(?:-[a-z0-9]+)*/[a-f0-9]{64}(${Object.keys(AUDIO_FORMATS)
    .map(extension => extension.replace('.', '\\.'))
    .join('|')})$`
);
const articleAudioStatic = express.static(path.resolve(__dirname, '..', config.audioDir), {
  setHeaders(res, filePath) {
    const format = AUDIO_FORMATS[path.extname(filePath)];
    if (format) res.setHeader('Content-Type', format.mimeType);
  }
});

app.use((req, res, next) => {
  res.set({
    'Content-Security-Policy': [
      "default-src 'self'",
      "base-uri 'self'",
      "connect-src 'self'",
      "font-src 'self' data:",
      "form-action 'self'",
      "frame-ancestors 'none'",
      "img-src 'self' data:",
      "media-src 'self'",
      "object-src 'none'",
      "script-src 'self' 'unsafe-inline'",
      "style-src 'self' 'unsafe-inline'"
    ].join('; '),
    'Permissions-Policy': 'camera=(), geolocation=(), microphone=()',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY'
  });
  if (config.isProduction) {
    res.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }
  next();
});
app.use(analyticsModule.publicContextRouter);
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

let commentsModule = null;
if (config.comments.enabled && 'googleClientId' in config.comments) {
  const { createGoogleIdentityClient } = require('./comments/google-identity');
  const { createCommentsModule } = require('./comments/module');
  const identityClient = createGoogleIdentityClient({
    clientId: config.comments.googleClientId,
    clientSecret: config.comments.googleClientSecret,
    redirectUri: config.comments.googleRedirectUri
  });
  commentsModule = createCommentsModule({ db, config: config.comments, identityClient });
  app.use(commentsModule.commenterSession);
  app.use(commentsModule.authRouter);
  app.use(commentsModule.publicRouter);
  app.use(commentsModule.adminRouter);
}

app.use('/api/auth', require('./routes/auth'));
app.use('/api/articles', require('./routes/articles').createArticlesRouter({ articleService }));
app.use('/api/admin/analytics', analyticsModule.adminApiRouter);
app.use('/api/admin', require('./routes/admin'));

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
app.use(createPagesRouter({ config, articleService, commentsModule }));

app.use((req, res) => {
  if (req.originalUrl.startsWith('/api/')) return res.status(404).json({ error: '接口不存在' });
  return res.status(404).render('404', { user: req.user || null, seo: null });
});

app.use((error, req, res, next) => {
  if (res.headersSent) return next(error);
  const status = Number.isInteger(error.status) && error.status >= 400 && error.status <= 599
    ? error.status
    : error.type === 'entity.parse.failed' ? 400 : 500;
  if (status >= 500) console.error(`[request-error] ${req.method} ${req.originalUrl}:`, error);
  if (req.originalUrl.startsWith('/api/')) {
    return res.status(status).json({ error: status >= 500 ? '服务器错误' : '请求无效' });
  }
  return res.status(status).type('text/plain').send(status >= 500 ? '服务器错误' : '请求无效');
});

let server = null;
let stopping = false;

async function stop() {
  if (stopping) return;
  stopping = true;
  if (server) await new Promise(resolve => server.close(resolve));
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
  process.once(signal, () => stop().finally(() => process.exit(0)));
}

start().catch(error => {
  console.error(`[startup] ${error.message}`);
  analyticsModule.lifecycle.stop();
  db.close();
  process.exitCode = 1;
});

const express = require('express');
const path = require('path');
const cookieParser = require('cookie-parser');
const config = require('./config').loadRuntimeConfig(process.env);

const { createAnalyticsModule } = require('./analytics/module');
const { AUDIO_FORMATS } = require('./article-audio/formats');
const { db } = require('./db');
const {
  createRootMetadataRouter,
  createRootNegotiatorRouter,
  createSlashCanonicalizerRouter,
  createLegacyRedirectRouter,
  createLocalizedPagesRouter,
  renderNotFound
} = require('./routes/pages');
const { createAdminPagesRouter } = require('./routes/admin-pages');
const { createArticleService } = require('./services/articles');
const { assetUrl, formatDate, formatYear } = require('./utils/presentation');
const { DEFAULT_LOCALE, SUPPORTED_LOCALES, isSupportedLocale } = require('./i18n/config');
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

const articleService = createArticleService(db);
const analyticsModule = createAnalyticsModule({ db, config: config.analytics });
const articleAudioPath = new RegExp(
  `^/(${SUPPORTED_LOCALES.join('|')})/[a-z0-9]+(?:-[a-z0-9]+)*/[a-f0-9]{64}(${Object.keys(AUDIO_FORMATS)
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
app.use('/api', (req, res, next) => {
  res.set('Cache-Control', 'no-store');
  res.removeHeader('Expires');
  next();
});

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
app.use('/api/:locale/articles', (req, res, next) => {
  if (!SUPPORTED_LOCALES.includes(req.params.locale)) {
    return res.status(404).json({ error: '接口不存在' });
  }
  req.locale = req.params.locale;
  next();
}, require('./routes/articles').createLocalizedArticlesRouter({ articleService }));

// Unmatched /api/* requests must stay JSON 404s. This explicit fallback mounts
// after every intended API/comment/admin API router and before the strict
// /:locale HTML router so paths like /api/zh/foo or /api/auth/missing can
// never be captured by the localized HTML 404.
app.use('/api', (req, res) => res.status(404).json({ error: '接口不存在' }));

// Root negotiation, slash canonicalizers, and legacy redirects mount before
// the Analytics collector so no redirect hop can ever be counted.
app.use(createRootNegotiatorRouter());
app.use('/zh', createSlashCanonicalizerRouter('zh'));
app.use('/en', createSlashCanonicalizerRouter('en'));
app.use(createLegacyRedirectRouter({ config, articleService }));

app.use(analyticsModule.collectorMiddleware);
app.use('/audio', (req, res, next) => {
  const sendNotFound = () => {
    res.set('Cache-Control', 'private, no-store');
    res.removeHeader('Expires');
    return res.sendStatus(404);
  };
  const match = articleAudioPath.exec(req.path);
  if (!match || !AUDIO_FORMATS[match[2]]) return sendNotFound();
  articleAudioStatic(req, res, error => {
    if (error) return next(error);
    return sendNotFound();
  });
});
app.use(express.static(path.join(__dirname, '..', 'public')));
app.use(analyticsModule.adminPageRouter);
app.use(createRootMetadataRouter({ config, articleService }));
app.use('/admin', createAdminPagesRouter({ articleService }));
// Strict localized public pages: admin, APIs, root sitemap/robots, and
// static/audio resources are all mounted before this, so `/:locale` cannot
// capture them.
app.use('/:locale', createLocalizedPagesRouter({ config, articleService, commentsModule }));

// App-level catch-all for HTML paths the localized router could not resolve
// (for example an unknown /zh/<path> or /en/<path>). Routing it through the
// exported renderNotFound contract keeps the localized status/lang/copy and
// overrides languageSwitch to the always-valid /zh/ and /en/ roots, so a 404
// never links to the same unknown path in the other locale. Unmatched /api/*
// requests keep their JSON 404 fallback and never reach the HTML 404.
app.use((req, res) => {
  if (req.originalUrl.startsWith('/api/')) return res.status(404).json({ error: '接口不存在' });
  return renderNotFound(req, res, config);
});

app.use((error, req, res, next) => {
  if (res.headersSent) return next(error);
  const status = Number.isInteger(error.status) && error.status >= 400 && error.status <= 599
    ? error.status
    : error.type === 'entity.parse.failed' ? 400 : 500;
  if (status >= 500) console.error(`[request-error] ${req.method} ${req.originalUrl}:`, error);
  res.set('Cache-Control', req.originalUrl.startsWith('/api/') ? 'no-store' : 'private, no-store');
  res.removeHeader('Expires');
  if (req.originalUrl.startsWith('/api/')) {
    return res.status(status).json({ error: status >= 500 ? '服务器错误' : '请求无效' });
  }
  const locale = isSupportedLocale(req.locale) ? req.locale : DEFAULT_LOCALE;
  const message = status >= 500
    ? (locale === 'en' ? 'Server error' : '服务器错误')
    : (locale === 'en' ? 'Invalid request' : '请求无效');
  return res.status(status).type('text/plain').send(message);
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
  server = app.listen(config.port, config.host, () => {
    const address = config.host === '::1' ? `[${config.host}]` : config.host;
    console.log(`博客服务器运行在 http://${address}:${config.port}`);
    console.log(`后台管理: http://${address}:${config.port}/admin`);
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

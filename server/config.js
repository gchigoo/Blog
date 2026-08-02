const crypto = require('node:crypto');
const { parseCommentsConfig } = require('./comments/config');
const { parseAnalyticsConfig } = require('./analytics/config');
const { SUPPORTED_LOCALES, DEFAULT_LOCALE } = require('./i18n/config');

const MIN_SECRET_BYTES = 32;

function parsePort(value) {
  if (value === undefined || value === '') return 3000;
  if (!/^\d+$/.test(value)) throw new Error('PORT must be an integer between 1 and 65535');
  const port = Number(value);
  if (port < 1 || port > 65535) throw new Error('PORT must be between 1 and 65535');
  return port;
}

function parseListenHost(value) {
  const host = typeof value === 'string' ? value.trim() : '';
  if (!host) return '127.0.0.1';
  if (!['127.0.0.1', '::1'].includes(host)) {
    throw new Error('BLOG_LISTEN_HOST must be a loopback address (127.0.0.1 or ::1)');
  }
  return host;
}

function parseJwtSecret(env) {
  const configuredSecret = typeof env.JWT_SECRET === 'string' ? env.JWT_SECRET.trim() : '';
  const isProduction = env.NODE_ENV === 'production';

  if (!configuredSecret) {
    if (isProduction) throw new Error('JWT_SECRET is required in production');
    return crypto.randomBytes(MIN_SECRET_BYTES).toString('base64url');
  }

  if (Buffer.byteLength(configuredSecret, 'utf8') < MIN_SECRET_BYTES) {
    throw new Error(`JWT_SECRET must be at least ${MIN_SECRET_BYTES} UTF-8 bytes`);
  }
  return configuredSecret;
}

function parsePublicOrigin(value) {
  if (value === undefined || value === '') return null;
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error('BLOG_PUBLIC_ORIGIN must be an absolute HTTP(S) origin');
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password
    || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('BLOG_PUBLIC_ORIGIN must be an absolute HTTP(S) origin without path, credentials, query, or fragment');
  }
  return url.origin;
}

function siteValue(envValue, fallback) {
  return typeof envValue === 'string' && envValue.trim() !== '' ? envValue.trim() : fallback;
}

function createBaseConfig(env) {
  const isProduction = env.NODE_ENV === 'production';
  const jwtSecret = parseJwtSecret(env);
  const publicOrigin = parsePublicOrigin(env.BLOG_PUBLIC_ORIGIN);
  if (isProduction && !publicOrigin) {
    throw new Error('BLOG_PUBLIC_ORIGIN is required in production');
  }
  const zhTitle = siteValue(env.BLOG_TITLE_ZH, siteValue(env.BLOG_TITLE, '我的博客'));
  const zhDescription = siteValue(env.BLOG_DESCRIPTION_ZH, siteValue(env.BLOG_DESCRIPTION, '技术文章、学习笔记与个人思考'));
  const enTitle = siteValue(env.BLOG_TITLE_EN, 'My Blog');
  const enDescription = siteValue(env.BLOG_DESCRIPTION_EN, 'Technical articles, study notes, and personal reflections');
  return {
    port: parsePort(env.PORT),
    host: parseListenHost(env.BLOG_LISTEN_HOST),
    jwtSecret,
    jwtExpire: '7d',
    secureCookies: isProduction,
    isProduction,
    uploadDir: 'uploads/temp',
    imagesDir: 'public/images',
    audioDir: 'public/audio',
    articlesDir: 'articles',
    imageQuality: 80,
    pageSize: 20,
    site: Object.freeze({
      title: zhTitle,
      description: zhDescription,
      publicOrigin
    }),
    siteLocales: Object.freeze({
      zh: Object.freeze({ title: zhTitle, description: zhDescription }),
      en: Object.freeze({ title: enTitle, description: enDescription })
    }),
    supportedLocales: SUPPORTED_LOCALES,
    defaultLocale: DEFAULT_LOCALE,
    aboutPaths: Object.freeze({
      zh: 'content/zh/about.md',
      en: 'content/en/about.md'
    }),
    taxonomyPath: 'content/taxonomy.json',
    operationsDir: 'var/operations',
    comments: parseCommentsConfig(env)
  };
}

const baseConfig = createBaseConfig(process.env);
const config = Object.assign({ ...baseConfig }, {
  loadRuntimeConfig: (env = process.env) => Object.freeze({
    ...(env === process.env ? baseConfig : createBaseConfig(env)),
    analytics: parseAnalyticsConfig(env)
  })
});

module.exports = config;

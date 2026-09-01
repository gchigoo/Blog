const assert = require('node:assert/strict');
const test = require('node:test');

const {
  SUPPORTED_LOCALES,
  DEFAULT_LOCALE,
  localeMetadata,
  isSupportedLocale,
  siteForLocale
} = require('../server/i18n/config');
const {
  negotiateLocale,
  localizedPath,
  encodePathSegment
} = require('../server/i18n/request');
const {
  createTranslator,
  messages,
  collectKeyPaths
} = require('../server/i18n/messages');
const {
  formatDate,
  formatLocalizedDate,
  formatLocalizedMonth,
  formatLocalizedYear,
  formatYear,
  groupArticlesByMonth
} = require('../server/utils/presentation');
const config = require('../server/config');

const baseEnv = {
  JWT_SECRET: 'test-only-jwt-secret-with-at-least-32-characters',
  ANALYTICS_HMAC_SECRET: Buffer.alloc(32, 7).toString('base64url')
};
const configFixture = config.loadRuntimeConfig(baseEnv);

test('locale contract exposes exactly zh and en with zh as the default', () => {
  assert.deepEqual(SUPPORTED_LOCALES, ['zh', 'en']);
  assert.equal(DEFAULT_LOCALE, 'zh');
  assert.equal(Object.isFrozen(SUPPORTED_LOCALES), true);
});

test('locale metadata maps html, Open Graph, and RSS attributes', () => {
  assert.deepEqual(localeMetadata('zh'), {
    htmlLang: 'zh-CN', ogLocale: 'zh_CN', rssLanguage: 'zh-CN'
  });
  assert.deepEqual(localeMetadata('en'), {
    htmlLang: 'en', ogLocale: 'en_US', rssLanguage: 'en'
  });
  assert.throws(() => localeMetadata('fr'), /unsupported locale/);
});

test('isSupportedLocale accepts only exact supported values', () => {
  assert.equal(isSupportedLocale('zh'), true);
  assert.equal(isSupportedLocale('en'), true);
  assert.equal(isSupportedLocale('ZH'), false);
  assert.equal(isSupportedLocale('zh-CN'), false);
  assert.equal(isSupportedLocale(''), false);
  assert.equal(isSupportedLocale(null), false);
  assert.equal(isSupportedLocale(42), false);
});

test('negotiateLocale prefers the cookie and parses Accept-Language by quality', () => {
  assert.equal(negotiateLocale({ cookieLocale: 'en', acceptLanguage: 'zh-CN' }), 'en');
  assert.equal(negotiateLocale({ cookieLocale: 'invalid', acceptLanguage: 'en-US,en;q=0.9' }), 'en');
  assert.equal(negotiateLocale({ cookieLocale: null, acceptLanguage: 'fr-FR,zh;q=0.8' }), 'zh');
  assert.equal(negotiateLocale({ cookieLocale: null, acceptLanguage: 'fr-FR;q=0.9,en-US;q=0.5,zh;q=0.4' }), 'en');
  assert.equal(negotiateLocale({ cookieLocale: null, acceptLanguage: 'en;q=0,zh;q=0.5' }), 'zh');
  assert.equal(negotiateLocale({ cookieLocale: null, acceptLanguage: '*' }), 'zh');
  assert.equal(negotiateLocale({ cookieLocale: null, acceptLanguage: 'fr;q=abc,en' }), 'en');
  assert.equal(negotiateLocale({ cookieLocale: null, acceptLanguage: '' }), 'zh');
  assert.equal(negotiateLocale({ cookieLocale: 'EN', acceptLanguage: 'zh-CN' }), 'zh');
  assert.equal(negotiateLocale({}), 'zh');
});

test('localizedPath adds exactly one locale prefix and preserves suffix text', () => {
  assert.equal(localizedPath('zh', '/'), '/zh/');
  assert.equal(localizedPath('en', '/article/example'), '/en/article/example');
  assert.equal(localizedPath('en', '/en/article/example'), '/en/article/example');
  assert.equal(localizedPath('zh', '/en/article/example'), '/zh/article/example');
  assert.equal(localizedPath('en', '/zh/'), '/en/');
  assert.equal(localizedPath('en', '/search?q=node#frag'), '/en/search?q=node#frag');
  assert.equal(localizedPath('zh', '/about'), '/zh/about');
  assert.throws(() => localizedPath('fr', '/'), /unsupported locale/);
  assert.throws(() => localizedPath('en', 'article/example'), /absolute/);
  assert.throws(() => localizedPath('en', null), /absolute/);
});

test('encodePathSegment encodes validated segments exactly once', () => {
  assert.equal(encodePathSegment('技术'), '%E6%8A%80%E6%9C%AF');
  assert.equal(encodePathSegment('Node.js'), 'Node.js');
  assert.equal(encodePathSegment('hello world'), 'hello%20world');
  assert.throws(() => encodePathSegment('foo%20bar'), /forbidden/);
  assert.throws(() => encodePathSegment('../up'), /forbidden/);
  assert.throws(() => encodePathSegment('a?b'), /forbidden/);
  assert.throws(() => encodePathSegment('a#b'), /forbidden/);
});

test('siteForLocale returns the localized site values', () => {
  assert.deepEqual(siteForLocale(configFixture, 'zh'), {
    title: '我的博客', description: '技术文章、学习笔记与个人思考'
  });
  assert.deepEqual(siteForLocale(configFixture, 'en'), {
    title: 'My Blog', description: 'Technical articles, study notes, and personal reflections'
  });
  assert.equal(siteForLocale(configFixture, 'zh').title, configFixture.site.title);
  assert.throws(() => siteForLocale(configFixture, 'fr'), /unsupported locale/);
});

test('runtime config wires locale, taxonomy, and about contracts', () => {
  assert.equal(configFixture.supportedLocales, SUPPORTED_LOCALES);
  assert.equal(configFixture.defaultLocale, DEFAULT_LOCALE);
  assert.deepEqual(configFixture.aboutPaths, { zh: 'content/zh/about.md', en: 'content/en/about.md' });
  assert.equal(configFixture.taxonomyPath, 'content/taxonomy.json');
  assert.equal(configFixture.operationsDir, 'var/operations');
  assert.equal(Object.isFrozen(configFixture.site), true);
  assert.equal(Object.isFrozen(configFixture.siteLocales), true);
  assert.equal(Object.isFrozen(configFixture.siteLocales.zh), true);
  assert.equal(Object.isFrozen(configFixture.aboutPaths), true);
});

test('runtime config accepts localized title and description env overrides', () => {
  const overridden = config.loadRuntimeConfig({
    ...baseEnv,
    BLOG_TITLE_ZH: '中文标题',
    BLOG_DESCRIPTION_ZH: '中文描述',
    BLOG_TITLE_EN: 'English Title',
    BLOG_DESCRIPTION_EN: 'English description'
  });
  assert.deepEqual(siteForLocale(overridden, 'zh'), { title: '中文标题', description: '中文描述' });
  assert.deepEqual(siteForLocale(overridden, 'en'), { title: 'English Title', description: 'English description' });
  assert.equal(overridden.site.title, '中文标题');
  assert.equal(overridden.site.description, '中文描述');
});

test('translator covers navigation, article, categories, comments, 404, pagination, search, and About keys', () => {
  const zh = createTranslator('zh');
  const en = createTranslator('en');
  const expectations = [
    ['navigation.home', '首页', 'Home'],
    ['navigation.archive', '归档', 'Archive'],
    ['navigation.tags', '标签', 'Tags'],
    ['navigation.search', '搜索', 'Search'],
    ['navigation.about', '关于', 'About'],
    ['article.published', '发布于 {date}', 'Published {date}'],
    ['article.tags', '标签：', 'Tags: '],
    ['article.backHome', '返回首页', 'Back to Home'],
    ['categories.title', '文章分类', 'Categories'],
    ['comments.title', '评论', 'Comments'],
    ['comments.submit', '提交评论', 'Submit Comment'],
    ['comments.empty', '还没有审核通过的评论。', 'No approved comments yet.'],
    ['notFound.title', '404 - 页面未找到', '404 - Page Not Found'],
    ['notFound.message', '页面未找到', 'Page Not Found'],
    ['notFound.backHome', '返回首页', 'Back to Home'],
    ['pagination.prev', '上一页', 'Previous'],
    ['pagination.next', '下一页', 'Next'],
    ['search.title', '搜索', 'Search'],
    ['search.resultsCount', '“{query}”共有 {count} 条结果。', '{count} results for “{query}”.'],
    ['search.empty', '没有找到相关文章。', 'No articles found.'],
    ['about.title', '关于', 'About'],
    ['about.fallback', '欢迎来到这个极简博客。', 'Welcome to this minimalist blog.']
  ];
  for (const [key, zhValue, enValue] of expectations) {
    assert.equal(zh(key), zhValue, `zh ${key}`);
    assert.equal(en(key), enValue, `en ${key}`);
  }
});

test('translator interpolates variables as strings', () => {
  const zh = createTranslator('zh');
  const en = createTranslator('en');
  assert.equal(zh('article.published', { date: '2026-08-01' }), '发布于 2026-08-01');
  assert.equal(zh('tags.tagTitle', { tag: 'Node' }), '标签: Node');
  assert.equal(zh('search.resultsCount', { query: 'node', count: 3 }), '“node”共有 3 条结果。');
  assert.equal(en('search.resultsCount', { query: 'node', count: 0 }), '0 results for “node”.');
});

test('unknown message keys throw instead of silently showing the key', () => {
  const zh = createTranslator('zh');
  assert.throws(() => zh('missing.key'), /missing message/);
  assert.throws(() => createTranslator('en')('navigation.missing'), /missing message/);
  assert.throws(() => createTranslator('fr'), /unsupported locale/);
});

test('Chinese and English message catalogs are parallel', () => {
  const zhKeys = collectKeyPaths(messages.zh);
  const enKeys = collectKeyPaths(messages.en);
  assert.ok(zhKeys.length >= 20, `expected at least 20 keys, got ${zhKeys.length}`);
  assert.deepEqual(enKeys, zhKeys);
});

// ---------------------------------------------------------------------------
// Task 9: locale-aware date formatting with locked compatibility helpers
// ---------------------------------------------------------------------------

test('formatLocalizedDate localizes the same timestamp while archive grouping keeps the Beijing boundary', () => {
  const timestamp = '2026-08-01T12:00:00.000Z';
  const zh = formatLocalizedDate(timestamp, 'zh', { year: 'numeric', month: 'long', day: 'numeric' });
  const en = formatLocalizedDate(timestamp, 'en', { year: 'numeric', month: 'long', day: 'numeric' });
  assert.equal(zh, '2026年8月1日');
  assert.equal(en, 'August 1, 2026');
  assert.notEqual(zh, en);

  // Archive grouping stays on the numeric en-CA Beijing calendar boundary.
  const grouped = groupArticlesByMonth([
    { id: 1, created_at: '2026-01-31T15:59:59.000Z' },
    { id: 2, created_at: '2026-01-31T16:00:00.000Z' }
  ]);
  assert.deepEqual(grouped['2026']['1'].map(article => article.id), [1]);
  assert.deepEqual(grouped['2026']['2'].map(article => article.id), [2]);
});

test('formatDate and formatYear stay Chinese/Beijing compatibility APIs', () => {
  // Admin view shape (views/admin/articles.ejs, comments, article page).
  assert.equal(
    formatDate('2026-01-31T16:00:00.000Z', { year: 'numeric', month: '2-digit', day: '2-digit' }),
    '2026/02/01'
  );
  // scripts/backup-db.js and scripts/query-db.js call shape.
  assert.equal(
    formatDate('2026-01-31T16:00:00.000Z', { dateStyle: 'medium', timeStyle: 'medium' }),
    '2026年2月1日 00:00:00'
  );
  // formatYear export used by server/admin footer locals.
  assert.equal(formatYear('2026-08-01T12:00:00.000Z'), '2026');
  assert.equal(formatYear(new Date('2026-08-01T12:00:00.000Z')), '2026');
});

test('formatLocalizedMonth and formatLocalizedYear localize via Intl and validate input', () => {
  assert.equal(formatLocalizedMonth(1, 'zh'), '一月');
  assert.equal(formatLocalizedMonth(1, 'en'), 'January');
  assert.equal(formatLocalizedMonth(12, 'zh'), '十二月');
  assert.equal(formatLocalizedMonth(12, 'en'), 'December');
  assert.throws(() => formatLocalizedMonth(0, 'zh'), /month/);
  assert.throws(() => formatLocalizedMonth(13, 'en'), /month/);
  assert.throws(() => formatLocalizedMonth(1, 'fr'), /unsupported locale/);
  assert.equal(formatLocalizedYear('2026-08-01T12:00:00.000Z', 'zh'), '2026年');
  assert.equal(formatLocalizedYear('2026-08-01T12:00:00.000Z', 'en'), '2026');
});

test('localized formatter caches key by locale and never share a zh/en formatter', () => {
  const timestamp = '2026-08-01T12:00:00.000Z';
  const options = { month: 'long' };
  // Warm the zh cache first: if the cache ignored locale, the en call would
  // reuse the zh formatter and emit Chinese text.
  assert.equal(formatLocalizedDate(timestamp, 'zh', options), '八月');
  assert.equal(formatLocalizedDate(timestamp, 'en', options), 'August');
  assert.equal(formatLocalizedDate(timestamp, 'zh', options), '八月');
  assert.equal(formatLocalizedDate(timestamp, 'en', options), 'August');

  // Distinct option sets stay distinct within one locale.
  assert.equal(formatLocalizedDate(timestamp, 'zh', { month: 'long', day: 'numeric' }), '8月1日');
  assert.equal(formatLocalizedDate(timestamp, 'en', { month: 'long', day: 'numeric' }), 'August 1');
  assert.equal(formatLocalizedDate(timestamp, 'zh', options), '八月');

  // The localized helpers do not disturb the compatibility wrappers.
  assert.equal(formatDate(timestamp, { year: 'numeric', month: '2-digit', day: '2-digit' }), '2026/08/01');
  assert.equal(formatYear(timestamp), '2026');
});

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
const { parseEventListQuery } = require('../../server/analytics/query/analytics-query');
const { renderMarkdown } = require('../../server/utils/markdown');
const { assetUrl, formatDate, formatYear } = require('../../server/utils/presentation');
const { createTranslator } = require('../../server/i18n/messages');
const { localeMetadata } = require('../../server/i18n/config');
const { localizedPath: localizedPathForLocale } = require('../../server/i18n/request');

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
    zhSrc: `/audio/zh/audio-browser/${hash}.${fixture.extension}`,
    enSrc: `/audio/en/audio-browser/${hash}.${fixture.extension}`
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
    src: fixture.zhSrc,
    mimeType: fixture.mimeType
  }))
});
// English audio article: the stored HTML is rendered with the en locale so the
// audio fallback UI (article.audioFallback) is English in the baseline.
const AUDIO_ARTICLE_HTML_EN = renderMarkdown(`## From First Idea to Final Mix

I documented the lyrics, melody, and sound experiments before placing the final version in the article.

${AUDIO_FIXTURES.map(fixture => `:::audio
title: ${fixture.title}
artist: AI Voice Experiment
src: ./audio/tone.${fixture.extension}
caption: ${fixture.extension.toUpperCase()} synthesized audio playback verification
:::`).join('\n\n')}`, {
  resolvedAudioBlocks: AUDIO_FIXTURES.map(fixture => ({
    src: fixture.enSrc,
    mimeType: fixture.mimeType
  })),
  locale: 'en'
});

db.pragma('foreign_keys = ON');
db.exec(`
  CREATE TABLE articles (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    slug TEXT NOT NULL UNIQUE,
    locale TEXT NOT NULL DEFAULT 'zh',
    content TEXT NOT NULL,
    html TEXT NOT NULL,
    tags TEXT,
    comments_enabled INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL
  );
  CREATE TABLE users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL UNIQUE
  );
  INSERT INTO users (username) VALUES ('visual-admin');
`);

const insertArticle = db.prepare(`
  INSERT INTO articles (title, slug, locale, content, html, tags, comments_enabled, created_at)
  VALUES (@title, @slug, @locale, @content, @html, @tags, @comments_enabled, @created_at)
`);

const articleFixtures = [
  {
    title: '从 EJS 3 升级到 EJS 6：保持页面像素级一致的实践记录',
    slug: 'comments-browser-smoke',
    locale: 'zh',
    content: 'visual fixture',
    html: '<h2>升级目标</h2><p>依赖升级前后保持完全一致的 HTML、布局和样式。</p><blockquote>先冻结行为，再替换依赖。</blockquote><h3>验证清单</h3><ul><li>HTML 快照</li><li>六档设备截图</li><li>人工目视确认</li></ul><pre><code>npm run test:visual</code></pre>',
    tags: JSON.stringify(['EJS', 'upgrade', '视觉回归']),
    comments_enabled: 1,
    created_at: '2026-07-16T01:30:00.000Z'
  },
  {
    title: 'A Comprehensive Practice Record of Upgrading Server-Side Template Rendering from EJS 3 to EJS 6 While Keeping the Rendered Pages Pixel-Level Identical on Every Device',
    slug: 'comments-browser-smoke-en',
    locale: 'en',
    content: 'visual fixture',
    html: '<h2>Upgrade Goals</h2><p>Keep the rendered HTML, layout, and computed styles byte-identical before and after the dependency upgrade.</p><blockquote>Freeze the behavior first, then replace the dependency.</blockquote><h3>Verification Checklist</h3><ul><li>HTML snapshots</li><li>Six device screenshot classes</li><li>Manual visual confirmation of every fixture</li></ul><pre><code>npm run test:visual</code></pre>',
    tags: JSON.stringify(['EJS', 'upgrade', 'Visual Regression']),
    comments_enabled: 1,
    created_at: '2026-07-16T01:30:00.000Z'
  },
  {
    title: '暂无评论的文章',
    slug: 'comments-empty',
    locale: 'zh',
    content: 'visual fixture',
    html: '<h2>空状态</h2><p>这个页面用于固定评论区尚无公开评论时的布局。</p>',
    tags: JSON.stringify(['测试']),
    comments_enabled: 1,
    created_at: '2026-07-15T03:00:00.000Z'
  },
  {
    title: '评论功能关闭时的文章详情',
    slug: 'comments-disabled',
    locale: 'zh',
    content: 'visual fixture',
    html: '<h2>正文保持不变</h2><p>评论功能关闭时，文章页不渲染评论区域。</p><table><thead><tr><th>版本</th><th>状态</th></tr></thead><tbody><tr><td>EJS 3</td><td>基线</td></tr><tr><td>EJS 6</td><td>待验证</td></tr></tbody></table>',
    tags: JSON.stringify(['EJS', 'upgrade']),
    comments_enabled: 0,
    created_at: '2026-07-14T05:20:00.000Z'
  },
  {
    title: 'Node.js 24 下的服务端模板测试策略',
    slug: 'node-24-template-tests',
    locale: 'zh',
    content: 'visual fixture',
    html: '<p>用于首页、归档和标签页面的固定数据。</p>',
    tags: JSON.stringify(['Node.js', '测试']),
    comments_enabled: 1,
    created_at: '2026-06-20T08:00:00.000Z'
  },
  {
    title: '把外部样式与字体固定到本地测试资源',
    slug: 'pin-browser-assets',
    locale: 'zh',
    content: 'visual fixture',
    html: '<p>消除 CDN 和字体响应漂移。</p>',
    tags: JSON.stringify(['CSS', 'upgrade']),
    comments_enabled: 1,
    created_at: '2025-12-08T09:00:00.000Z'
  },
  {
    title: '业界新闻速览：2026 年前端工具链观察',
    slug: 'industry-news',
    locale: 'zh',
    content: 'visual fixture',
    html: '<p>新闻分类下的固定数据，用于验证跨分类的标签/分类页面。</p>',
    tags: JSON.stringify(['业界新闻']),
    comments_enabled: 1,
    created_at: '2026-05-11T02:00:00.000Z'
  },
  {
    title: 'Frontend Toolchain Observations for 2026',
    slug: 'industry-news-en',
    locale: 'en',
    content: 'visual fixture',
    html: '<p>Fixed news-category data used to verify taxonomy and category pages across locales.</p>',
    tags: JSON.stringify(['Industry News']),
    comments_enabled: 1,
    created_at: '2026-05-11T02:00:00.000Z'
  },
  {
    title: '早年技术笔记（Legacy 内容归档）',
    slug: 'legacy-notes',
    locale: 'zh',
    content: 'visual fixture',
    html: '<p>归档到“其他”分类的旧内容，用于固定 legacy 分类的展示。</p>',
    tags: JSON.stringify(['旧内容']),
    comments_enabled: 1,
    created_at: '2024-03-02T09:00:00.000Z'
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

// The public templates render category badges and fine-tag links from the
// localized taxonomy projection that production attaches per article; the
// legacy harness rows get a deterministic fixture mapping instead. Every
// category/tag projection is resolved per locale so the English pages show
// English names and slugs.
const VISUAL_CATEGORY_BY_TAG = {
  zh: {
    EJS: 'technology',
    upgrade: 'technology',
    'Node.js': 'technology',
    CSS: 'technology',
    测试: 'life',
    视觉回归: 'life',
    业界新闻: 'news',
    旧内容: 'uncategorized'
  },
  en: {
    EJS: 'technology',
    upgrade: 'technology',
    'Node.js': 'technology',
    CSS: 'technology',
    Testing: 'life',
    'Visual Regression': 'life',
    'Industry News': 'news',
    Legacy: 'uncategorized'
  }
};

const VISUAL_TAXONOMY = {
  zh: {
    categories: [
      { id: 'technology', name: '技术', slug: '技术', count: 4 },
      { id: 'life', name: '生活', slug: '生活', count: 3 },
      { id: 'news', name: '新闻', slug: '新闻', count: 1 },
      { id: 'uncategorized', name: '其他', slug: '其他', count: 1 }
    ],
    tags: [
      { id: 'legacy-ejs', categoryId: 'technology', name: 'EJS', slug: 'EJS', count: 2 },
      { id: 'legacy-upgrade', categoryId: 'technology', name: 'upgrade', slug: 'upgrade', count: 3 },
      { id: 'legacy-nodejs', categoryId: 'technology', name: 'Node.js', slug: 'Node.js', count: 1 },
      { id: 'legacy-css', categoryId: 'technology', name: 'CSS', slug: 'CSS', count: 1 },
      { id: 'legacy-testing', categoryId: 'life', name: '测试', slug: '测试', count: 2 },
      { id: 'legacy-visual', categoryId: 'life', name: '视觉回归', slug: '视觉回归', count: 1 },
      { id: 'legacy-news', categoryId: 'news', name: '业界新闻', slug: '业界新闻', count: 1 },
      { id: 'legacy-old', categoryId: 'uncategorized', name: '旧内容', slug: '旧内容', count: 1 }
    ]
  },
  en: {
    categories: [
      { id: 'technology', name: 'Technology', slug: 'technology', count: 1 },
      { id: 'life', name: 'Life', slug: 'life', count: 1 },
      { id: 'news', name: 'News', slug: 'news', count: 1 },
      { id: 'uncategorized', name: 'Other', slug: 'other', count: 0 }
    ],
    tags: [
      { id: 'legacy-ejs', categoryId: 'technology', name: 'EJS', slug: 'EJS', count: 1 },
      { id: 'legacy-upgrade', categoryId: 'technology', name: 'upgrade', slug: 'upgrade', count: 1 },
      { id: 'legacy-nodejs', categoryId: 'technology', name: 'Node.js', slug: 'Node.js', count: 0 },
      { id: 'legacy-css', categoryId: 'technology', name: 'CSS', slug: 'CSS', count: 0 },
      { id: 'legacy-testing', categoryId: 'life', name: 'Testing', slug: 'testing', count: 0 },
      { id: 'legacy-visual', categoryId: 'life', name: 'Visual Regression', slug: 'visual-regression', count: 1 },
      { id: 'legacy-news', categoryId: 'news', name: 'Industry News', slug: 'industry-news', count: 1 },
      { id: 'legacy-old', categoryId: 'uncategorized', name: 'Legacy', slug: 'legacy', count: 0 }
    ]
  }
};

function normalizeArticle(row, locale) {
  const article = { ...row, tags: JSON.parse(row.tags || '[]') };
  const taxonomy = VISUAL_TAXONOMY[locale];
  const categoryByTag = VISUAL_CATEGORY_BY_TAG[locale];
  const categories = [];
  const seenCategories = new Set();
  const taxonomyTags = [];
  for (const tagName of article.tags) {
    const categoryId = categoryByTag[tagName] || 'uncategorized';
    const categoryDef = taxonomy.categories.find(entry => entry.id === categoryId);
    const categoryName = categoryDef ? categoryDef.name : '其他';
    const categorySlug = categoryDef ? categoryDef.slug : '其他';
    if (!seenCategories.has(categoryId)) {
      seenCategories.add(categoryId);
      categories.push({ id: categoryId, name: categoryName, slug: categorySlug });
    }
    const tagDef = taxonomy.tags.find(entry => entry.name === tagName);
    taxonomyTags.push({
      id: tagDef ? tagDef.id : `legacy-${tagName}`,
      categoryId,
      name: tagName,
      slug: tagDef ? tagDef.slug : tagName
    });
  }
  article.taxonomy = { categories, tags: taxonomyTags };
  return article;
}

function allArticles(locale) {
  return db.prepare('SELECT * FROM articles WHERE locale = ? ORDER BY created_at DESC, id DESC')
    .all(locale)
    .map(row => normalizeArticle(row, locale));
}

function renderHome(res, user, locale) {
  return res.render('index', {
    articles: allArticles(locale),
    page: 1,
    totalPages: 3,
    user
  });
}

function dimension(items) {
  return {
    items,
    distinctCount: items.length,
    truncated: false,
    otherPageViews: 0
  };
}

const ANALYTICS_FIXTURE_ROWS = [
  { position: 1, observedAtUtc: '2026-07-17T08:30:00.000Z', metricId: 601 },
  { position: 2, observedAtUtc: '2026-07-17T07:10:00.000Z', metricId: 602 },
  { position: 3, observedAtUtc: '2026-07-17T06:30:00.000Z', metricId: 603 },
  { position: 4, observedAtUtc: '2026-07-17T05:10:00.000Z', metricId: 604 },
  { position: 5, observedAtUtc: '2026-07-17T04:30:00.000Z', metricId: 605 },
  { position: 6, observedAtUtc: '2026-07-17T03:10:00.000Z', metricId: 606 }
];
const ANALYTICS_FIXTURE_SIZE = ANALYTICS_FIXTURE_ROWS.length;

function encodeAnalyticsFixtureCursor(row) {
  return Buffer.from(JSON.stringify({
    observedAtUtc: row.observedAtUtc,
    metricId: row.metricId
  })).toString('base64url');
}

function decodeAnalyticsFixtureCursor(value) {
  if (value === undefined) return null;
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/.test(value)) return undefined;
  try {
    const decoded = Buffer.from(value, 'base64url');
    if (decoded.toString('base64url') !== value) return undefined;
    const cursor = JSON.parse(decoded.toString('utf8'));
    if (!cursor || Object.keys(cursor).join(',') !== 'observedAtUtc,metricId'
      || typeof cursor.observedAtUtc !== 'string'
      || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(cursor.observedAtUtc)
      || !Number.isFinite(Date.parse(cursor.observedAtUtc))
      || new Date(cursor.observedAtUtc).toISOString() !== cursor.observedAtUtc
      || !Number.isSafeInteger(cursor.metricId) || cursor.metricId <= 0) return undefined;
    return cursor;
  } catch {
    return undefined;
  }
}

function fixtureTupleBelow(row, cursor) {
  return row.observedAtUtc < cursor.observedAtUtc
    || (row.observedAtUtc === cursor.observedAtUtc && row.metricId < cursor.metricId);
}

function fixtureRowForEvent(event) {
  return ANALYTICS_FIXTURE_ROWS.find(row => row.position === Number.parseInt(event.id, 16));
}

function analyticsFixtureEvent(position, traffic, search) {
  const fixtureRow = ANALYTICS_FIXTURE_ROWS.find(row => row.position === position);
  const forcedTraffic = traffic === 'human' || traffic === 'bot' ? traffic : null;
  const trafficKind = forcedTraffic || (position % 2 === 1 ? 'human' : 'bot');
  const marker = search || `Fixture event ${position}`;
  const longValue = '长'.repeat(5000);
  const displayPath = search === 'long-valid' ? `/fixture/${longValue}` : `/fixture/event-${position}`;
  return {
    id: position.toString(16).padStart(32, '0'),
    observedAtUtc: fixtureRow.observedAtUtc,
    requestPath: displayPath,
    displayPath,
    displayPathStatus: 'unchanged',
    trafficKind,
    botName: trafficKind === 'bot' ? 'Googlebot' : null,
    page: {
      kind: 'other',
      title: search === 'long-valid' ? longValue : `${marker}`,
      displayPath
    },
    fullUrl: `https://blog.example.test/fixture/event-${position}`,
    referrer: position === 1 ? 'https://private-referrer.example.test/detail-only' : null,
    statusCode: 200,
    durationMs: 10 + position,
    responseBytes: 2048 + position,
    ipAddress: `203.0.113.${10 + position}`,
    location: {
      continent: { code: 'AS', name: search === 'long-valid' ? null : '亚洲' },
      country: { code: 'CN', name: search === 'long-valid' ? null : '中国' },
      subdivision: { code: null, name: search === 'long-valid' ? null : '北京' },
      city: search === 'long-valid' ? null : '北京',
      postalCode: null,
      timezone: null,
      coordinates: null,
      accuracyRadiusKm: null
    },
    client: {
      deviceType: search === 'long-valid' ? null : (position % 2 ? 'desktop' : 'mobile'),
      vendor: null,
      model: null,
      os: { name: search === 'long-valid' ? longValue : (position % 2 ? 'Windows' : 'iOS'), version: null },
      browser: { name: search === 'long-valid' ? null : (position % 2 ? 'Chrome' : 'Safari'), version: search === 'long-valid' ? longValue : '126' },
      engine: { name: null, version: null },
      cpuArchitecture: null,
      contextAvailable: true,
      sources: ['server', 'client-fetch']
    }
  };
}

function analyticsFixturePage(query = {}) {
  const traffic = typeof query.traffic === 'string' ? query.traffic : 'all';
  const search = typeof query.search === 'string' ? query.search : '';
  const requestedLimit = Number(query.limit);
  const limit = Number.isInteger(requestedLimit) && requestedLimit >= 1 && requestedLimit <= 100
    ? requestedLimit
    : 2;
  const cursor = decodeAnalyticsFixtureCursor(query.cursor);
  if (cursor === undefined) throw new Error('invalid_fixture_cursor');
  const dataset = ANALYTICS_FIXTURE_ROWS
    .map(row => analyticsFixtureEvent(row.position, traffic, search))
    .sort((left, right) => {
      const leftRow = fixtureRowForEvent(left);
      const rightRow = fixtureRowForEvent(right);
      return right.observedAtUtc.localeCompare(left.observedAtUtc) || rightRow.metricId - leftRow.metricId;
    });
  const selectedDataset = cursor === null
    ? dataset
    : dataset.filter(item => fixtureTupleBelow(fixtureRowForEvent(item), cursor));
  const items = search === 'empty' ? [] : selectedDataset.slice(0, limit);
  let nextCursor = items.length > 0 && selectedDataset.length > items.length
    ? encodeAnalyticsFixtureCursor(fixtureRowForEvent(items.at(-1)))
    : null;
  if (search === 'same-cursor' && query.cursor) nextCursor = query.cursor;
  return {
    days: Number(query.days) || 7,
    items,
    nextCursor
  };
}

const ANALYTICS_ADVANCED_FILTERS = [
  ['ip', '完整 IP'],
  ['country', '国家代码'],
  ['subdivision', '一级行政区'],
  ['city', '城市'],
  ['browser', '浏览器'],
  ['os', '操作系统'],
  ['device', '设备类别'],
  ['pathPrefix', '路径前缀'],
  ['referrerHost', '来源域']
];
const ANALYTICS_FILTER_REMOVAL_DEPENDENCIES = {
  country: ['country', 'subdivision', 'city']
};

function analyticsRemovedFilterNames(name) {
  return new Set(ANALYTICS_FILTER_REMOVAL_DEPENDENCIES[name] || (name ? [name] : []));
}

function analyticsFilters(query, days) {
  const names = [
    'search', 'traffic', ...ANALYTICS_ADVANCED_FILTERS.map(([name]) => name)
  ];
  const filters = { days: String(days) };
  for (const name of names) filters[name] = typeof query[name] === 'string' ? query[name] : '';
  if (!filters.traffic) filters.traffic = 'all';
  return filters;
}

function analyticsFilterUrl(filters, limit, removedName = null, cursor = null) {
  const params = new URLSearchParams();
  const removedNames = analyticsRemovedFilterNames(removedName);
  for (const [name, value] of Object.entries(filters)) {
    if (!removedNames.has(name) && value) params.set(name, value);
  }
  if (limit !== 2) params.set('limit', String(limit));
  if (cursor) params.set('cursor', cursor);
  return `/admin/analytics?${params.toString()}#event-list`;
}

function analyticsAppliedFilters(filters, limit) {
  const items = [];
  if (filters.search) items.push({ name: 'search', label: '搜索', value: filters.search });
  if (filters.traffic && filters.traffic !== 'all') {
    items.push({
      name: 'traffic', label: '访问类型',
      value: filters.traffic === 'human' ? '仅真人' : '仅爬虫'
    });
  }
  for (const [name, label] of ANALYTICS_ADVANCED_FILTERS) {
    if (filters[name]) items.push({ name, label, value: filters[name] });
  }
  return items.map(item => ({
    ...item,
    removeNames: [...analyticsRemovedFilterNames(item.name)],
    removeUrl: analyticsFilterUrl(filters, limit, item.name)
  }));
}

function analyticsQueryIsValid(query) {
  const duplicateSensitive = [
    'days', 'search', 'traffic', 'ip', 'country', 'subdivision', 'city', 'browser', 'os',
    'device', 'pathPrefix', 'referrerHost', 'limit', 'cursor'
  ];
  if (duplicateSensitive.some(name => Array.isArray(query[name]))) return false;
  try {
    parseEventListQuery(query, 30);
    return true;
  } catch {
    return false;
  }
}

function analyticsViewModel(query = {}) {
  const overview = {
    days: 7,
    todayActiveVisitors: 18,
    uniqueHumanIps: 41,
    humanPageViews: 128,
    botPageViews: 37,
    detailsAvailable: true,
    detailsComplete: false,
    pageViews: 128,
    anonymousVisitors: 46,
    detailCoverage: { pageViews: 116, humanPageViews: 116, complete: false },
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
  const validQuery = analyticsQueryIsValid(query);
  overview.days = typeof query.days === 'string' && /^\d+$/.test(query.days) ? Number(query.days) : 7;
  const filters = analyticsFilters(query, overview.days);
  const requestedLimit = Number(query.limit);
  const limit = Number.isInteger(requestedLimit) && requestedLimit >= 1 && requestedLimit <= 100 ? requestedLimit : 2;
  const events = validQuery
    ? { available: true, ...analyticsFixturePage(query) }
    : { available: true, days: overview.days, items: [], nextCursor: null };
  return {
    overview,
    events,
    filters,
    appliedFilters: analyticsAppliedFilters(filters, limit),
    advancedFilterCount: ANALYTICS_ADVANCED_FILTERS.filter(([name]) => filters[name]).length,
    eventPreviousUrl: null,
    eventNextUrl: validQuery && events.nextCursor
      ? analyticsFilterUrl(filters, limit, null, events.nextCursor)
      : null,
    pageError: validQuery ? null : '筛选条件无效，请检查输入后重试。',
    analyticsEnhancementEnabled: validQuery,
    rangeOptions: [1, 7, 30],
    systemStatus: {
      detailsEnabled: true,
      geoData: overview.geoData,
      warning: null
    },
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
app.locals.assetUrl = assetUrl;
app.locals.formatDate = formatDate;
app.locals.formatYear = formatYear;
app.locals.site = { title: '我的博客', description: '视觉回归测试博客' };
app.locals.commentsEnabled = true;
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());
app.use(express.static(path.resolve(__dirname, '..', '..', 'public')));
app.use(commentsModule.commenterSession);

const tokens = createTokenService(SESSION_SECRET, clock);
app.get('/__visual/ready', (req, res) => res.type('text').send('ready'));
function audioFixtureHandler(req, res) {
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
}
app.get('/audio/zh/audio-browser/:fileName', audioFixtureHandler);
app.get('/audio/en/audio-browser/:fileName', audioFixtureHandler);
app.get('/__test/commenter-login', (req, res) => {
  res.cookie('comment_session', tokens.createSession({
    commenterId: commenter.id,
    csrfToken: 'visual-csrf-token-0123456789abcdef'
  }), sessionCookieOptions(false));
  res.redirect('/zh/article/comments-browser-smoke');
});
app.get('/zh/__test/commenter-login', (req, res) => {
  res.cookie('comment_session', tokens.createSession({
    commenterId: commenter.id,
    csrfToken: 'visual-csrf-token-0123456789abcdef'
  }), sessionCookieOptions(false));
  res.redirect('/zh/article/comments-browser-smoke');
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

// Public locale locals: the template contract (i18n, locale, localizedPath,
// localeMeta, site) matches a localized production request. The locale is
// derived from the request path so /en/* renders the English surface while
// everything else (including the admin UI, which stays Chinese) renders zh.
// Every route below overrides languageSwitch so a switch target is only
// offered when the endpoint exists.
app.use((req, res, next) => {
  const locale = req.path.startsWith('/en') ? 'en' : 'zh';
  res.locals.locale = locale;
  res.locals.i18n = createTranslator(locale);
  res.locals.localizedPath = pathname => localizedPathForLocale(locale, pathname);
  res.locals.localeMeta = localeMetadata(locale);
  res.locals.site = locale === 'en'
    ? { title: 'My Blog', description: 'Visual regression test blog' }
    : { title: '我的博客', description: '视觉回归测试博客' };
  res.locals.availableLocales = ['zh', 'en'];
  res.locals.languageSwitch = [
    { locale: 'zh', path: '/zh/' },
    { locale: 'en', path: '/en/' }
  ];
  next();
});

// Translation siblings for the bilingual fixture posts. An article only offers
// a switch target to a locale whose endpoint actually exists.
const ARTICLE_TRANSLATION = {
  'comments-browser-smoke': { en: 'comments-browser-smoke-en' },
  'comments-browser-smoke-en': { zh: 'comments-browser-smoke' },
  'industry-news': { en: 'industry-news-en' },
  'industry-news-en': { zh: 'industry-news' }
};

function articleLanguageSwitch(locale, slug) {
  const entry = ARTICLE_TRANSLATION[slug] || {};
  const otherSlug = entry[locale === 'zh' ? 'en' : 'zh'];
  if (!otherSlug) {
    return [{ locale, path: `/${locale}/article/${encodeURIComponent(slug)}` }];
  }
  const otherLocale = locale === 'zh' ? 'en' : 'zh';
  const current = { locale, path: `/${locale}/article/${encodeURIComponent(slug)}` };
  const other = { locale: otherLocale, path: `/${otherLocale}/article/${encodeURIComponent(otherSlug)}` };
  return locale === 'zh' ? [current, other] : [other, current];
}

app.get('/', (req, res) => renderHome(res, null, 'zh'));
app.get('/zh/', (req, res) => renderHome(res, null, 'zh'));
app.get('/en/', (req, res) => renderHome(res, null, 'en'));
app.get('/__visual/home-admin', (req, res) => renderHome(res, {
  id: 1,
  username: 'visual-admin'
}, 'zh'));
app.get('/zh/__visual/home-admin', (req, res) => renderHome(res, {
  id: 1,
  username: 'visual-admin'
}, 'zh'));

function renderAudioArticle(req, res, locale) {
  res.locals.languageSwitch = locale === 'en'
    ? [{ locale: 'en', path: '/en/__audio/article' }]
    : [{ locale: 'zh', path: '/zh/__audio/article' }];
  return res.render('article', {
    article: {
      id: locale === 'en' ? 100 : 99,
      title: locale === 'en' ? 'An AI Song Experiment: From Process to Final Mix' : '一次 AI 歌曲实验：从过程到成品',
      slug: 'audio-browser',
      content: 'audio browser fixture',
      html: locale === 'en' ? AUDIO_ARTICLE_HTML_EN : AUDIO_ARTICLE_HTML,
      tags: locale === 'en' ? ['EJS', 'upgrade'] : ['AI', '音乐', '创作过程'],
      created_at: '2026-07-17T08:00:00.000Z'
    },
    user: null,
    comments: { enabled: false }
  });
}

function renderArticle(req, res, locale) {
  const row = db.prepare('SELECT * FROM articles WHERE slug = ? AND locale = ?').get(req.params.slug, locale);
  if (!row) return res.status(404).render('404', { user: null });
  const article = normalizeArticle(row, locale);
  res.locals.languageSwitch = articleLanguageSwitch(locale, article.slug);
  const comments = row.comments_enabled
    ? commentsModule.getArticleCommentsViewModel(article.id, {
        commenter: req.commenter,
        csrfToken: req.commentSession?.csrfToken || null
      })
    : { enabled: false };
  return res.render('article', { article, user: null, comments });
}

app.get('/article/:slug', (req, res) => renderArticle(req, res, 'zh'));
app.get('/zh/article/:slug', (req, res) => renderArticle(req, res, 'zh'));
app.get('/en/article/:slug', (req, res) => renderArticle(req, res, 'en'));
app.get('/__audio/article', (req, res) => renderAudioArticle(req, res, 'zh'));
app.get('/zh/__audio/article', (req, res) => renderAudioArticle(req, res, 'zh'));
app.get('/en/__audio/article', (req, res) => renderAudioArticle(req, res, 'en'));

function renderArchive(req, res, locale) {
  const archive = {};
  for (const article of allArticles(locale)) {
    const date = new Date(article.created_at);
    const year = String(date.getFullYear());
    const month = String(date.getMonth() + 1);
    archive[year] ||= {};
    archive[year][month] ||= [];
    archive[year][month].push(article);
  }
  return res.render('archive', { archive, user: null });
}
app.get('/archive', (req, res) => renderArchive(req, res, 'zh'));
app.get('/zh/archive', (req, res) => renderArchive(req, res, 'zh'));

app.get('/tags', (req, res) => res.render('tags', { taxonomy: VISUAL_TAXONOMY.zh, user: null }));
app.get('/zh/tags', (req, res) => res.render('tags', { taxonomy: VISUAL_TAXONOMY.zh, user: null }));
app.get('/en/tags', (req, res) => res.render('tags', { taxonomy: VISUAL_TAXONOMY.en, user: null }));

app.get('/tag/upgrade', (req, res) => res.render('tag', {
  tag: 'upgrade',
  category: { name: '技术', slug: '技术' },
  articles: allArticles('zh').filter(article => article.tags.includes('upgrade')),
  user: null
}));
app.get('/zh/tag/upgrade', (req, res) => res.render('tag', {
  tag: 'upgrade',
  category: { name: '技术', slug: '技术' },
  articles: allArticles('zh').filter(article => article.tags.includes('upgrade')),
  user: null
}));

function renderCategory(req, res, locale) {
  const taxonomy = VISUAL_TAXONOMY[locale];
  const category = taxonomy.categories.find(candidate => candidate.slug === req.params.slug);
  if (!category || category.count === 0) return res.status(404).render('404', { user: null });
  const articles = allArticles(locale).filter(article =>
    article.taxonomy.categories.some(entry => entry.id === category.id)
  );
  return res.render('category', { category, articles, user: null });
}
app.get('/category/:slug', (req, res) => renderCategory(req, res, 'zh'));
app.get('/zh/category/:slug', (req, res) => renderCategory(req, res, 'zh'));
app.get('/en/category/:slug', (req, res) => renderCategory(req, res, 'en'));

app.get('/search', (req, res) => res.render('search', {
  query: 'EJS',
  articles: allArticles('zh').slice(0, 2),
  user: null,
  seo: { title: '搜索', description: '搜索文章', canonical: 'https://example.test/zh/search', type: 'website', noindex: true }
}));
app.get('/zh/search', (req, res) => res.render('search', {
  query: 'EJS',
  articles: allArticles('zh').slice(0, 2),
  user: null,
  seo: { title: '搜索', description: '搜索文章', canonical: 'https://example.test/zh/search', type: 'website', noindex: true }
}));

app.get('/about', (req, res) => res.render('about', {
  aboutHtml: renderMarkdown(fs.readFileSync(path.resolve(__dirname, '..', '..', 'content', 'zh', 'about.md'), 'utf8'), { locale: 'zh' }),
  title: '关于',
  user: null,
  seo: { title: '关于', description: '关于本站', canonical: 'https://example.test/zh/about', type: 'website' }
}));
app.get('/zh/about', (req, res) => res.render('about', {
  aboutHtml: renderMarkdown(fs.readFileSync(path.resolve(__dirname, '..', '..', 'content', 'zh', 'about.md'), 'utf8'), { locale: 'zh' }),
  title: '关于',
  user: null,
  seo: { title: '关于', description: '关于本站', canonical: 'https://example.test/zh/about', type: 'website' }
}));
app.get('/en/about', (req, res) => res.render('about', {
  aboutHtml: renderMarkdown(fs.readFileSync(path.resolve(__dirname, '..', '..', 'content', 'en', 'about.md'), 'utf8'), { locale: 'en' }),
  title: 'About',
  user: null,
  seo: { title: 'About', description: 'About this site', canonical: 'https://example.test/en/about', type: 'website' }
}));

app.get('/visual-not-found', (req, res) => res.status(200).render('404', { user: null }));
app.get('/zh/__visual/not-found', (req, res) => res.status(200).render('404', { user: null }));
app.get('/admin/login', (req, res) => res.render('admin/login'));
app.get('/admin/upload', (req, res) => res.render('admin/upload', {
  user: { id: 1, username: 'visual-admin' }
}));
app.get('/admin/articles', (req, res) => res.render('admin/articles', {
  articles: db.prepare('SELECT * FROM articles ORDER BY created_at DESC, id DESC').all()
    .map(row => normalizeArticle(row, row.locale)),
  user: { id: 1, username: 'visual-admin' }
}));
let analyticsRetryPending = true;
let analyticsPopFailurePending = false;
let analyticsSlowCompleted = 0;
let analyticsDetailSlowCompleted = 0;
const analyticsSlowWaiters = new Set();
const analyticsDetailSlowWaiters = new Set();

function finishWaiters(waiters, completed) {
  for (const waiter of waiters) {
    if (completed > waiter.after) {
      clearTimeout(waiter.timeout);
      waiters.delete(waiter);
      waiter.resolve();
    }
  }
}

function finishAnalyticsSlowRequest() {
  analyticsSlowCompleted += 1;
  finishWaiters(analyticsSlowWaiters, analyticsSlowCompleted);
}

function finishAnalyticsDetailSlowRequest() {
  analyticsDetailSlowCompleted += 1;
  finishWaiters(analyticsDetailSlowWaiters, analyticsDetailSlowCompleted);
}

function waitForCompletion(waiters, completed, after) {
  if (completed > after) return Promise.resolve();
  return new Promise(resolve => {
    const waiter = {
      after,
      resolve,
      timeout: setTimeout(() => {
        waiters.delete(waiter);
        resolve();
      }, 5_000)
    };
    waiters.add(waiter);
  });
}

app.post('/__test/analytics-reset', (req, res) => {
  analyticsRetryPending = true;
  analyticsPopFailurePending = false;
  return res.sendStatus(204);
});
app.post('/__test/analytics-fail-next-pop', (req, res) => {
  analyticsPopFailurePending = true;
  return res.sendStatus(204);
});
app.get('/__test/analytics-slow-state', (req, res) => res.json({ completed: analyticsSlowCompleted }));
app.get('/__test/analytics-wait-slow', async (req, res) => {
  const after = Number(req.query.after) || 0;
  await waitForCompletion(analyticsSlowWaiters, analyticsSlowCompleted, after);
  return res.json({ completed: analyticsSlowCompleted });
});
app.get('/__test/analytics-detail-slow-state', (req, res) => res.json({ completed: analyticsDetailSlowCompleted }));
app.get('/__test/analytics-wait-detail-slow', async (req, res) => {
  const after = Number(req.query.after) || 0;
  await waitForCompletion(analyticsDetailSlowWaiters, analyticsDetailSlowCompleted, after);
  return res.json({ completed: analyticsDetailSlowCompleted });
});
app.get('/api/admin/analytics/events', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  if (!analyticsQueryIsValid(req.query)) {
    return res.status(400).json({ error: 'invalid_filter', field: 'cursor', reason: 'invalid_value' });
  }
  if (analyticsPopFailurePending) {
    analyticsPopFailurePending = false;
    return res.status(500).json({ error: 'analytics_query_failed' });
  }
  if (req.query.search === 'invalid') {
    return res.status(400).json({ error: 'invalid_filter', field: 'search', reason: 'too_long' });
  }
  if (
    analyticsRetryPending &&
    (req.query.search === 'retry'
      || req.query.search === 'retry-remove'
      || (req.query.search === 'retry-next' && req.query.cursor))
  ) {
    analyticsRetryPending = false;
    return res.status(500).json({ error: 'analytics_query_failed' });
  }
  if (req.query.search === 'slow') {
    await new Promise(resolve => setTimeout(resolve, 350));
    finishAnalyticsSlowRequest();
  }
  if (req.query.search === 'non-json') return res.type('text').send('not json');
  if (req.query.search === 'json-text') {
    return res.type('text').send(JSON.stringify(analyticsFixturePage(req.query)));
  }
  if (req.query.search === 'bad-shape') return res.json({ days: 7, items: 'invalid', nextCursor: null });
  if (req.query.search === 'bad-item') {
    return res.json({ days: 7, items: [{ id: 'bad' }], nextCursor: null });
  }
  if (req.query.search === 'bad-next-cursor') {
    return res.json({ ...analyticsFixturePage(req.query), nextCursor: { malformed: true } });
  }
  if (req.query.search === 'oversized-list') {
    const item = analyticsFixtureEvent(1, 'all', 'oversized-list');
    return res.json({ days: 7, items: Array.from({ length: 101 }, () => item), nextCursor: null });
  }
  return res.json(analyticsFixturePage(req.query));
});
app.get('/api/admin/analytics/events/:eventId', async (req, res) => {
  const position = Number.parseInt(req.params.eventId, 16);
  if (!Number.isInteger(position) || position < 1 || position > ANALYTICS_FIXTURE_SIZE) return res.sendStatus(404);
  if (position === 1) {
    await new Promise(resolve => setTimeout(resolve, 350));
    finishAnalyticsDetailSlowRequest();
  }
  const detail = analyticsFixtureEvent(position, position % 2 === 0 ? 'bot' : 'human', '');
  const bot = detail.trafficKind === 'bot';
  if (position === 3) {
    detail.page = {
      kind: 'other',
      title: '<img data-hostile-title src=x onerror=alert(1)>',
      displayPath: '/fixture/<script>alert(2)</script>'
    };
    detail.requestPath = '/fixture/%3Cscript%3Ealert(2)%3C/script%3E';
    detail.referrer = '"><svg data-hostile-referrer onload=alert(3)>';
    detail.client.contextAvailable = false;
  }
  if (bot) detail.client.contextAvailable = false;
  return res.json({
    ...detail,
    raw: {
      userAgent: position === 3
        ? '<iframe data-hostile-ua src=javascript:alert(4)>'
        : bot ? 'Googlebot/2.1' : 'FixtureBrowser/1.0',
      requestClientHints: {},
      browserClientContext: detail.client.contextAvailable ? {} : null
    },
    screen: { width: 1920, height: 1080 },
    viewport: { width: 1440, height: 900 },
    hardware: { concurrency: 8, deviceMemoryGb: 8, cpuArchitecture: 'x86' },
    touch: { maxTouchPoints: 0 },
    network: { effectiveType: '4g', downlinkMbps: 10, rttMs: 20, saveData: false },
    browserContext: { language: 'zh-CN', languages: ['zh-CN'], timezone: 'Asia/Shanghai' },
    collection: {
      sources: detail.client.sources,
      contextCollectedAt: detail.client.contextAvailable ? detail.observedAtUtc : null,
      geoDatasetDate: '2026-07-15T00:00:00.000Z',
      geoStatus: 'resolved',
      clientParseStatus: position === 3 ? 'error' : 'parsed'
    }
  });
});
app.get('/admin/analytics', (req, res) => {
  const viewModel = analyticsViewModel(req.query);
  if (viewModel.pageError) res.status(400);
  return res.render('admin/analytics', viewModel);
});
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

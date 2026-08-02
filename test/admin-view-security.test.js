const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const ejs = require('ejs');
const { REPO_ROOT } = require('./helpers/project-fixture');
const { createTranslator } = require('../server/i18n/messages');
const { localeMetadata } = require('../server/i18n/config');
const { localizedPath: localizedPathFor } = require('../server/i18n/request');
const { renderMarkdown } = require('../server/utils/markdown');

/**
 * The locale request locals every localized public page receives from
 * `setLocaleLocals` plus the resolved language-switch entries. Overrides let a
 * test simulate an article without a translation sibling, an asymmetric
 * pagination page, or a static page whose both-locale endpoints always exist.
 */
function publicLocals(locale, overrides = {}) {
  const defaults = {
    locale,
    i18n: createTranslator(locale),
    localizedPath: pathname => localizedPathFor(locale, pathname),
    localeMeta: localeMetadata(locale),
    site: { title: locale === 'zh' ? '我的博客' : 'My Blog', description: 'desc' },
    availableLocales: ['zh', 'en'],
    languageSwitch: ['zh', 'en'].map(candidate => ({
      locale: candidate,
      path: localizedPathFor(candidate, '/')
    }))
  };
  return { ...defaults, ...overrides };
}

const ZX_ARTICLE = {
  id: 7,
  title: '测试文章',
  slug: 'test-article',
  created_at: '2026-07-17T00:00:00.000Z',
  tags: ['Node.js'],
  taxonomy: {
    categories: [{ id: 'technology', name: '技术', slug: '技术' }],
    tags: [{ id: 'nodejs', categoryId: 'technology', name: 'Node.js', slug: 'nodejs' }]
  }
};

const EN_ARTICLE = {
  id: 8,
  title: 'Test Article',
  slug: 'test-article',
  created_at: '2026-07-17T00:00:00.000Z',
  tags: ['Node.js'],
  taxonomy: {
    categories: [{ id: 'technology', name: 'Technology', slug: 'technology' }],
    tags: [{ id: 'nodejs', categoryId: 'technology', name: 'Node.js', slug: 'nodejs' }]
  }
};

test('zh home renders the locale html lang, keeps every internal href locale-prefixed, and shows the localized heading', async () => {
  const template = path.join(REPO_ROOT, 'views', 'index.ejs');
  const html = await ejs.renderFile(template, publicLocals('zh', {
    articles: [ZX_ARTICLE],
    page: 1,
    totalPages: 1,
    user: null,
    seo: null
  }));

  assert.match(html, /<html lang="zh-CN"/);
  assert.match(html, /最新文章/);
  assert.match(html, /href="\/zh\/article\/test-article"/);
  assert.match(html, /href="\/zh\/category\/%E6%8A%80%E6%9C%AF"/);
  assert.match(html, /href="\/zh\/tag\/nodejs"/);
  assert.match(html, /href="\/zh\/"/);
  assert.match(html, /href="\/zh\/archive"/);
  assert.match(html, /href="\/zh\/tags"/);
  assert.match(html, /href="\/zh\/search"/);
  assert.match(html, /href="\/zh\/about"/);
  assert.match(html, /href="\/zh\/feed\.xml"/);
  for (const unprefixed of [
    'href="/article/',
    'href="/archive"',
    'href="/tags"',
    'href="/search"',
    'href="/about"',
    'href="/feed.xml"',
    'href="/">首页'
  ]) {
    assert.ok(!html.includes(unprefixed), `legacy unprefixed internal link leaked: ${unprefixed}`);
  }
});

test('en home renders English UI with no Chinese labels and an en html lang', async () => {
  const template = path.join(REPO_ROOT, 'views', 'index.ejs');
  const html = await ejs.renderFile(template, publicLocals('en', {
    articles: [EN_ARTICLE],
    page: 1,
    totalPages: 1,
    user: null,
    seo: null
  }));

  assert.match(html, /<html lang="en"/);
  assert.match(html, />Home</);
  assert.match(html, /Latest Articles/);
  for (const chineseLabel of ['首页', '归档', '标签', '搜索', '关于', '最新文章', '上一页', '下一页']) {
    assert.ok(!html.includes(chineseLabel), `Chinese UI label leaked onto the English page: ${chineseLabel}`);
  }
  assert.match(html, /href="\/en\/article\/test-article"/);
});

test('language switcher marks the current language and links only the existing alternate', async () => {
  const template = path.join(REPO_ROOT, 'views', 'index.ejs');
  const html = await ejs.renderFile(template, publicLocals('zh', {
    articles: [ZX_ARTICLE],
    page: 1,
    totalPages: 1,
    user: null,
    seo: null,
    languageSwitch: [
      { locale: 'zh', path: '/zh/' },
      { locale: 'en', path: '/en/' }
    ]
  }));

  assert.match(html, /class="language-switcher-current"[^>]*aria-current="true"[^>]*>中文</);
  assert.match(html, /href="\/en\/"[^>]*lang="en"/);
  assert.doesNotMatch(html, /aria-current="false"/);
});

test('article without a translation sibling renders no dead English switch link', async () => {
  const template = path.join(REPO_ROOT, 'views', 'article.ejs');
  const html = await ejs.renderFile(template, publicLocals('zh', {
    article: { ...ZX_ARTICLE, title: '仅中文文章' },
    comments: { enabled: false },
    navigation: { previous: null, next: null },
    relatedArticles: [],
    languageSwitch: [{ locale: 'zh', path: '/zh/article/test-article' }],
    user: null,
    seo: null
  }));

  assert.ok(html.includes('aria-current="true"'));
  assert.doesNotMatch(html, /href="\/en\//);
});

test('paginated home without a target-locale page renders no dead English switch', async () => {
  const template = path.join(REPO_ROOT, 'views', 'index.ejs');
  const html = await ejs.renderFile(template, publicLocals('zh', {
    articles: [ZX_ARTICLE],
    page: 3,
    totalPages: 3,
    user: null,
    seo: null,
    languageSwitch: [{ locale: 'zh', path: '/zh/?page=3' }]
  }));

  assert.ok(html.includes('aria-current="true"'));
  assert.doesNotMatch(html, /href="\/en\//);
});

test('taxonomy category and tag names are HTML-escaped on the tags page', async () => {
  const template = path.join(REPO_ROOT, 'views', 'tags.ejs');
  const html = await ejs.renderFile(template, publicLocals('zh', {
    tags: [],
    taxonomy: {
      categories: [
        { id: 'hostile', name: '<script>alert(1)</script>', slug: 'hostile-cat', count: 1 }
      ],
      tags: [
        { id: 'hostile-tag', categoryId: 'hostile', name: '<img src=x onerror=alert(2)>', slug: 'hostile-tag', count: 1 }
      ]
    },
    user: null,
    seo: null
  }));

  assert.doesNotMatch(html, /<script>alert\(1\)<\/script>/);
  assert.doesNotMatch(html, /<img src=x onerror=/);
  assert.doesNotMatch(html, /onclick\s*=/i);
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.match(html, /&lt;img src=x onerror=alert\(2\)&gt;/);
});

test('tags page groups fine tags under their category with counts and hides zero-count categories', async () => {
  const template = path.join(REPO_ROOT, 'views', 'tags.ejs');
  const html = await ejs.renderFile(template, publicLocals('zh', {
    tags: [],
    taxonomy: {
      categories: [
        { id: 'technology', name: '技术', slug: '技术', count: 2 },
        { id: 'uncategorized', name: '其他', slug: '其他', count: 0 }
      ],
      tags: [
        { id: 'nodejs', categoryId: 'technology', name: 'Node.js', slug: 'nodejs', count: 2 },
        { id: 'other', categoryId: 'uncategorized', name: '未分类', slug: 'uncategorized', count: 0 }
      ]
    },
    user: null,
    seo: null
  }));

  assert.match(html, /href="\/zh\/category\/%E6%8A%80%E6%9C%AF">技术<\/a>/);
  assert.match(html, /\(2\)/);
  assert.match(html, /href="\/zh\/tag\/nodejs"/);
  assert.ok(!html.includes('/zh/tag/uncategorized'));
  assert.ok(!html.includes('/zh/category/%E5%85%B6%E4%BB%96'));
});

test('tag page shows its parent category breadcrumb with locale-prefixed links', async () => {
  const template = path.join(REPO_ROOT, 'views', 'tag.ejs');
  const html = await ejs.renderFile(template, publicLocals('zh', {
    tag: 'Node.js',
    category: { name: '技术', slug: '技术' },
    articles: [ZX_ARTICLE],
    user: null,
    seo: null
  }));

  assert.match(html, /href="\/zh\/tags"/);
  assert.match(html, /href="\/zh\/category\/%E6%8A%80%E6%9C%AF">技术<\/a>/);
  assert.match(html, /href="\/zh\/article\/test-article"/);
});

test('category page lists distinct articles and links back to the taxonomy overview', async () => {
  const template = path.join(REPO_ROOT, 'views', 'category.ejs');
  const html = await ejs.renderFile(template, publicLocals('zh', {
    category: { id: 'technology', name: '技术', slug: '技术', count: 1 },
    articles: [ZX_ARTICLE],
    user: null,
    seo: null
  }));

  assert.match(html, /<h2[^>]*>技术<\/h2>/);
  assert.match(html, /href="\/zh\/article\/test-article"/);
  assert.match(html, /href="\/zh\/tags"/);
});

test('about page renders the exact X contact URL with the noopener rel', async () => {
  const template = path.join(REPO_ROOT, 'views', 'about.ejs');
  const markdown = fs.readFileSync(path.join(REPO_ROOT, 'content', 'zh', 'about.md'), 'utf8');
  const html = await ejs.renderFile(template, publicLocals('zh', {
    aboutHtml: renderMarkdown(markdown, { locale: 'zh' }),
    title: '关于',
    user: null,
    seo: null
  }));

  assert.match(html, /href="https:\/\/x\.com\/Sugar_Haaaat"/);
  assert.match(html, /rel="noopener noreferrer"/);
  assert.doesNotMatch(html, /target="_blank"/);
});

test('long English labels and hostile search input stay escaped and never enter inline JavaScript', async () => {
  const template = path.join(REPO_ROOT, 'views', 'search.ejs');
  const hostile = `x');alert(1);//<img src=x onerror=alert(2)>`;
  const html = await ejs.renderFile(template, publicLocals('en', {
    query: hostile,
    articles: [],
    user: null,
    seo: null
  }));

  assert.doesNotMatch(html, /onclick\s*=/i);
  assert.doesNotMatch(html, /<script>alert/);
  assert.doesNotMatch(html, /<img src=x onerror=/);
  assert.match(html, /x&#39;\);alert\(1\);\/\/&lt;img src=x onerror=alert\(2\)&gt;/);
});

test('admin article titles never enter inline handlers or JavaScript strings', async () => {
  const template = path.join(REPO_ROOT, 'views', 'admin', 'articles.ejs');
  const title = `Bad');alert(1);//<img src=x onerror=alert(2)>`;
  const html = await ejs.renderFile(template, {
    articles: [{
      id: 7,
      title,
      slug: 'safe-slug',
      tags: [],
      created_at: '2026-07-15T00:00:00.000Z'
    }],
    user: { username: 'admin' }
  });

  assert.doesNotMatch(html, /onclick\s*=/i);
  assert.doesNotMatch(html, /deleteArticle\([^)]*Bad/);
  assert.match(html, /Bad&#39;\);alert\(1\);\/\/&lt;img src=x onerror=alert\(2\)&gt;/);
});

test('admin upload feedback does not inject article metadata through innerHTML', async () => {
  const template = path.join(REPO_ROOT, 'views', 'admin', 'upload.ejs');
  const html = await ejs.renderFile(template, { user: { username: 'admin' } });

  assert.doesNotMatch(html, /\.innerHTML\s*=/);
  assert.doesNotMatch(html, /\$\{data\.article\.title\}/);
  assert.match(html, /textContent/);
  assert.match(html, /sandbox="allow-same-origin"/);
  assert.doesNotMatch(html, /sandbox="[^"]*allow-scripts/);
  assert.match(html, /previewFrame\.srcdoc/);
  // The preview panel displays the localized language and grouped taxonomy via
  // textContent, never through interpolated HTML.
  assert.match(html, /previewLocale/);
  assert.match(html, /previewTranslationKey/);
  assert.match(html, /previewCategories/);
  assert.match(html, /preview\.categories/);
});

test('admin article list escapes locale, translation group, categories, and tags', async () => {  const template = path.join(REPO_ROOT, 'views', 'admin', 'articles.ejs');
  const hostile = `"><script>alert(1)</script>`;
  const html = await ejs.renderFile(template, {
    articles: [{
      id: 1,
      title: 'Safe Title',
      slug: 'safe-slug',
      locale: 'zh',
      translationKey: hostile,
      categories: ['<img src=x onerror=alert(2)>', '技术'],
      tags: ['<script>alert(3)</script>', 'Node.js'],
      created_at: '2026-07-15T00:00:00.000Z'
    }, {
      id: 2,
      title: 'English Row',
      slug: 'en-safe',
      locale: 'en',
      translationKey: 'shared-key',
      categories: ['Technology'],
      tags: ['Tutorial'],
      created_at: '2026-07-16T00:00:00.000Z'
    }],
    user: { username: 'admin' }
  });

  assert.doesNotMatch(html, /<script>alert\(1\)<\/script>/);
  assert.doesNotMatch(html, /<script>alert\(3\)<\/script>/);
  assert.doesNotMatch(html, /<img src=x onerror=/);
  assert.match(html, /&#34;&gt;&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.match(html, /&lt;img src=x onerror=alert\(2\)&gt;/);
  assert.match(html, /&lt;script&gt;alert\(3\)&lt;\/script&gt;/);
  // The new localized columns render for both locales.
  assert.match(html, /中文/);
  assert.match(html, /English/);
  assert.match(html, /shared-key/);
  assert.match(html, /Technology/);
  assert.match(html, /Tutorial/);
});

test('admin header public links point directly at the Chinese site without negotiator or legacy hops', async () => {
  const template = path.join(REPO_ROOT, 'views', 'partials', 'admin-header.ejs');
  const html = await ejs.renderFile(template, {});

  assert.match(html, /href="\/zh\/"/);
  assert.match(html, /href="\/zh\/about"/);
  assert.doesNotMatch(html, /href="\/">首页|href="\/about">关于|href="\/en\//);
});

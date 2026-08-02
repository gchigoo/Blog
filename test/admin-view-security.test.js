const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');
const ejs = require('ejs');
const { REPO_ROOT } = require('./helpers/project-fixture');

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

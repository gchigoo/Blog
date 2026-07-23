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
});

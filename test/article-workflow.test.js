const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { performance } = require('node:perf_hooks');
const test = require('node:test');
const Database = require('better-sqlite3');
const jwt = require('jsonwebtoken');
const { CommentStoreError, createCommentStore } = require('../server/comments/store');
const { migrateDatabase } = require('../server/migrations');
const { createArticleService } = require('../server/services/articles');
const { groupArticlesByMonth } = require('../server/utils/presentation');
const { createProjectFixture, runNode, startServer } = require('./helpers/project-fixture');

const INITIAL_PASSWORD = 'S3cure!Node24';
const JWT_SECRET = 'test-only-jwt-secret-with-at-least-32-characters';

function cookie() {
  return `token=${jwt.sign({ id: 1, username: 'admin' }, JWT_SECRET, { expiresIn: '5m' })}`;
}

async function harness(t) {
  const root = await createProjectFixture(t);
  const init = runNode(root, 'server/scripts/init-db.js', [], { INITIAL_ADMIN_PASSWORD: INITIAL_PASSWORD });
  assert.equal(init.status, 0, init.stderr);
  const server = await startServer(t, root, {
    JWT_SECRET,
    BLOG_PUBLIC_ORIGIN: 'https://blog.example.test'
  });
  return { root, ...server };
}

async function submit(baseUrl, endpoint, name, markdown, fields = {}) {
  const form = new FormData();
  form.append('file', new Blob([markdown]), name);
  for (const [key, value] of Object.entries(fields)) form.append(key, value);
  return fetch(`${baseUrl}${endpoint}`, {
    method: 'POST',
    headers: { cookie: cookie() },
    body: form
  });
}

function markdown({ title, slug, status = 'published', body = 'searchable body', description = 'summary', tags = '[node]' }) {
  return `---\ntitle: ${title}\nslug: ${slug}\ndescription: ${description}\ntags: ${tags}\nstatus: ${status}\n---\n\n${body}\n`;
}

test('versioned migration backfills published status, tags, and FTS search', () => {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE articles (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL, slug TEXT UNIQUE NOT NULL, content TEXT NOT NULL,
      html TEXT NOT NULL, tags TEXT, created_at TEXT, updated_at TEXT
    );
    INSERT INTO articles(title, slug, content, html, tags, created_at, updated_at)
    VALUES ('Legacy Node', 'legacy-node', 'sqlite search body', '<p>body</p>', '["node"]',
            '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
  `);
  migrateDatabase(db);
  migrateDatabase(db);
  const service = createArticleService(db);

  assert.equal(db.pragma('user_version', { simple: true }), 0);
  assert.equal(db.prepare('SELECT status FROM articles').get().status, 'published');
  assert.equal(service.listByTag('node').length, 1);
  assert.equal(service.search('sqlite').length, 1);
  assert.equal(db.prepare('SELECT version FROM schema_migrations').get().version, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM schema_migrations').get().count, 1);
  db.close();
});

test('archive grouping uses the Beijing calendar boundary', () => {
  const grouped = groupArticlesByMonth([
    { id: 1, created_at: '2026-01-31T15:59:59.000Z' },
    { id: 2, created_at: '2026-01-31T16:00:00.000Z' }
  ]);
  assert.deepEqual(grouped['2026']['1'].map(article => article.id), [1]);
  assert.deepEqual(grouped['2026']['2'].map(article => article.id), [2]);
});

test('draft article IDs cannot receive public comments', () => {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE articles (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL, slug TEXT UNIQUE NOT NULL, content TEXT NOT NULL,
      html TEXT NOT NULL, tags TEXT, created_at TEXT, updated_at TEXT
    );
    CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT);
  `);
  migrateDatabase(db);
  const articleId = Number(db.prepare(`
    INSERT INTO articles(title, slug, content, html, tags, status, created_at, updated_at)
    VALUES ('Draft', 'draft', 'body', '<p>body</p>', '[]', 'draft', ?, ?)
  `).run('2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z').lastInsertRowid);
  const store = createCommentStore(db);
  const commenter = store.upsertIdentity(
    { provider: 'google', subject: 'draft-commenter', displayName: 'Draft Commenter' },
    '2026-01-01T00:00:00.000Z'
  );
  assert.throws(() => store.createPendingComment({
    articleId,
    commenterId: commenter.id,
    content: 'must stay private',
    createdAt: '2026-01-01T00:01:00.000Z'
  }), error => error instanceof CommentStoreError && error.code === 'article_not_found');
  db.close();
});

test('10k published articles keep indexed tag and FTS queries within local budgets', t => {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE articles (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL, slug TEXT UNIQUE NOT NULL, content TEXT NOT NULL,
      html TEXT NOT NULL, tags TEXT, created_at TEXT, updated_at TEXT
    )
  `);
  migrateDatabase(db);
  const insert = db.prepare(`
    INSERT INTO articles(title, slug, content, html, tags, created_at, updated_at)
    VALUES (?, ?, ?, '<p>body</p>', ?, ?, ?)
  `);
  db.transaction(() => {
    for (let index = 0; index < 10_000; index += 1) {
      const date = new Date(Date.UTC(2026, 0, 1) + index * 1000).toISOString();
      insert.run(
        `Article ${index}`, `article-${index}`,
        `full text performance needle ${index}`,
        JSON.stringify(['node', `group-${index % 20}`]), date, date
      );
    }
  })();
  const service = createArticleService(db);
  const searchDurations = [];
  const tagDurations = [];
  for (let sample = 0; sample < 20; sample += 1) {
    let started = performance.now();
    assert.ok(service.search('performance needle').length > 0);
    searchDurations.push(performance.now() - started);
    started = performance.now();
    assert.equal(service.listByTag('group-1').length, 500);
    tagDurations.push(performance.now() - started);
  }
  const p95 = values => values.sort((a, b) => a - b)[Math.ceil(values.length * 0.95) - 1];
  const searchP95 = p95(searchDurations);
  const tagP95 = p95(tagDurations);
  assert.ok(searchP95 < 250, `search p95=${searchP95}ms`);
  assert.ok(tagP95 < 250, `tag p95=${tagP95}ms`);
  t.diagnostic(`10k local search p95=${searchP95.toFixed(2)}ms, tag p95=${tagP95.toFixed(2)}ms`);
  db.close();
});

test('drafts stay private while search, feed, sitemap, replacement, and preview work', async t => {
  const { root, baseUrl } = await harness(t);
  const publishedResponse = await submit(
    baseUrl,
    '/api/admin/upload',
    'published.md',
    markdown({
      title: 'Published Node Guide',
      slug: 'published-node',
      body: 'unique full text needle\n\n```js\nconst answer = 42;\n```'
    })
  );
  const published = await publishedResponse.json();
  assert.equal(publishedResponse.status, 200, JSON.stringify(published));

  const draftResponse = await submit(
    baseUrl,
    '/api/admin/upload',
    'draft.md',
    markdown({ title: 'Secret Draft', slug: 'secret-draft', status: 'draft', body: 'private needle' })
  );
  const draft = await draftResponse.json();
  assert.equal(draftResponse.status, 200, JSON.stringify(draft));
  assert.equal(draft.article.status, 'draft');

  const homeHtml = await (await fetch(`${baseUrl}/`)).text();
  assert.match(homeHtml, /https:\/\/blog\.example\.test\//);
  assert.match(homeHtml, /\/vendor\/inter\.css\?v=[a-f0-9]{12}/);
  assert.doesNotMatch(homeHtml, /fonts\.xz\.style|cdn\.jsdelivr\.net/);
  assert.match(await (await fetch(`${baseUrl}/about`)).text(), /可配置|极简博客/);
  assert.match(await (await fetch(`${baseUrl}/article/published-node`)).text(), /hljs-keyword/);
  assert.match(await (await fetch(`${baseUrl}/robots.txt`)).text(), /Sitemap: https:\/\/blog\.example\.test\/sitemap\.xml/);

  assert.equal((await fetch(`${baseUrl}/article/secret-draft`)).status, 404);
  assert.equal((await fetch(`${baseUrl}/api/articles/secret-draft`)).status, 404);
  assert.match(await (await fetch(`${baseUrl}/search?q=unique`)).text(), /Published Node Guide/);
  assert.doesNotMatch(await (await fetch(`${baseUrl}/search?q=private`)).text(), /Secret Draft/);
  const feed = await (await fetch(`${baseUrl}/feed.xml`)).text();
  const sitemap = await (await fetch(`${baseUrl}/sitemap.xml`)).text();
  assert.match(feed, /Published Node Guide/);
  assert.doesNotMatch(feed, /Secret Draft/);
  assert.match(sitemap, /published-node/);
  assert.doesNotMatch(sitemap, /secret-draft/);

  const previewResponse = await submit(
    baseUrl,
    '/api/admin/preview',
    'preview.md',
    markdown({ title: 'Preview Only', slug: 'preview-only', body: '**rendered preview**' })
  );
  const preview = await previewResponse.json();
  assert.equal(previewResponse.status, 200, JSON.stringify(preview));
  assert.match(preview.html, /<strong>rendered preview<\/strong>/);

  const replacementResponse = await submit(
    baseUrl,
    '/api/admin/upload',
    'replacement.md',
    markdown({ title: 'Updated Node Guide', slug: 'published-node', body: 'replacement search phrase' }),
    { replaceId: String(published.article.id) }
  );
  const replacement = await replacementResponse.json();
  assert.equal(replacementResponse.status, 200, JSON.stringify(replacement));
  assert.equal(replacement.article.id, published.article.id);
  assert.equal(replacement.article.replaced, true);

  const db = new Database(path.join(root, 'blog.db'), { readonly: true });
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM articles WHERE slug = ?').get('published-node').count, 1);
  assert.equal(db.prepare('SELECT title FROM articles WHERE id = ?').get(published.article.id).title, 'Updated Node Guide');
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM articles WHERE slug = ?').get('preview-only').count, 0);
  db.close();
  const saved = await fs.readFile(path.join(root, 'articles', 'published-node.md'), 'utf8');
  assert.match(saved, /Updated Node Guide/);
});

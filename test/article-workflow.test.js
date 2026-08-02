const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { performance } = require('node:perf_hooks');
const test = require('node:test');
const Database = require('better-sqlite3');
const jwt = require('jsonwebtoken');
const { CommentStoreError, createCommentStore } = require('../server/comments/store');
const { LATEST_SCHEMA_VERSION, migrateDatabase } = require('../server/migrations');
const { createArticleService } = require('../server/services/articles');
const {
  buildArticleSearchDocument,
  deleteArticleSearchDocument,
  rebuildArticleSearchIndex,
  searchArticleIds,
  upsertArticleSearchDocument
} = require('../server/articles/search-index');
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

function legacySchemaSql() {
  return `
    CREATE TABLE articles (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL, slug TEXT UNIQUE NOT NULL, content TEXT NOT NULL,
      html TEXT NOT NULL, tags TEXT, status TEXT, created_at TEXT, updated_at TEXT
    );
  `;
}

function writeTaxonomyCatalog(catalog) {
  const directory = fsSync.mkdtempSync(path.join(os.tmpdir(), 'blog-taxonomy-'));
  const file = path.join(directory, 'taxonomy.json');
  fsSync.writeFileSync(file, JSON.stringify(catalog));
  return file;
}

function baseCatalog({ extraTags = [], extraCategories = [] } = {}) {
  return {
    version: 1,
    categories: [
      {
        id: 'technology',
        sortOrder: 30,
        labels: {
          zh: { name: '技术', slug: '技术' },
          en: { name: 'Technology', slug: 'technology' }
        },
        tags: [
          {
            id: 'nodejs',
            sortOrder: 10,
            labels: {
              zh: { name: 'Node.js', slug: 'Node.js' },
              en: { name: 'Node.js', slug: 'nodejs' }
            },
            legacyNames: ['Node.js']
          },
          ...extraTags
        ]
      },
      ...extraCategories,
      {
        id: 'uncategorized',
        sortOrder: 90,
        labels: {
          zh: { name: '其他', slug: '其他' },
          en: { name: 'Other', slug: 'other' }
        },
        tags: [
          {
            id: 'other',
            sortOrder: 10,
            labels: {
              zh: { name: '未分类', slug: '未分类' },
              en: { name: 'Uncategorized', slug: 'uncategorized' }
            },
            legacyNames: []
          }
        ]
      }
    ]
  };
}

function insertLegacyArticle(db, {
  title,
  slug,
  tags,
  content = 'body',
  status = 'published',
  created = '2026-01-01T00:00:00.000Z',
  updated = null
}) {
  return db.prepare(`
    INSERT INTO articles (title, slug, content, html, tags, status, created_at, updated_at)
    VALUES (?, ?, ?, '<p>body</p>', ?, ?, ?, ?)
  `).run(title, slug, content, JSON.stringify(tags), status, created, updated || created).lastInsertRowid;
}

test('schema v3 migration rebuilds articles with posts and preserves comments', t => {
  const taxonomyPath = writeTaxonomyCatalog(baseCatalog());
  t.after(() => fsSync.rmSync(path.dirname(taxonomyPath), { recursive: true, force: true }));
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(legacySchemaSql());
  insertLegacyArticle(db, {
    title: 'Legacy Node', slug: 'legacy-node', tags: ['Node.js', '教程'],
    created: '2026-01-01T00:00:00.000Z', updated: '2026-01-05T00:00:00.000Z'
  });
  insertLegacyArticle(db, {
    title: 'Secret Draft', slug: 'secret-draft', tags: [], status: 'draft',
    created: '2026-02-01T00:00:00.000Z'
  });
  db.exec('CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT NOT NULL UNIQUE)');
  const store = createCommentStore(db);
  const commenter = store.upsertIdentity(
    { provider: 'google', subject: 'migration-commenter', displayName: 'Migration Commenter' },
    '2026-03-01T00:00:00.000Z'
  );
  const comment = store.createPendingComment({
    articleId: 1,
    commenterId: commenter.id,
    content: 'keep this comment',
    createdAt: '2026-03-01T00:00:00.000Z'
  });

  migrateDatabase(db, { taxonomyPath });
  migrateDatabase(db, { taxonomyPath });

  assert.equal(LATEST_SCHEMA_VERSION, 3);
  assert.deepEqual(
    db.prepare('SELECT version FROM schema_migrations ORDER BY version').all().map(row => row.version),
    [1, 2, 3]
  );
  assert.deepEqual(
    db.prepare('SELECT id, locale, slug, status FROM articles ORDER BY id').all(),
    [
      { id: 1, locale: 'zh', slug: 'legacy-node', status: 'published' },
      { id: 2, locale: 'zh', slug: 'secret-draft', status: 'draft' }
    ]
  );
  assert.equal(db.prepare('SELECT article_id FROM comments WHERE id = ?').get(comment.id).article_id, 1);
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);

  const article = db.prepare('SELECT post_id, created_at, updated_at FROM articles WHERE id = 1').get();
  assert.ok(article.post_id);
  const post = db.prepare('SELECT translation_key, created_at, updated_at FROM posts WHERE id = ?').get(article.post_id);
  assert.equal(post.translation_key, 'legacy-node');
  assert.equal(post.created_at, article.created_at);
  assert.equal(post.updated_at, article.updated_at);

  // A second locale may reuse the same slug; a second zh row may not.
  const enPostId = Number(db.prepare(`
    INSERT INTO posts (translation_key, created_at, updated_at)
    VALUES ('en-post', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')
  `).run().lastInsertRowid);
  db.prepare(`
    INSERT INTO articles (post_id, locale, title, slug, content, html, status, created_at, updated_at)
    VALUES (?, 'en', 'Legacy Node EN', 'legacy-node', 'body', '<p>body</p>', 'published',
            '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')
  `).run(enPostId);
  assert.throws(() => db.prepare(`
    INSERT INTO articles (post_id, locale, title, slug, content, html, status, created_at, updated_at)
    VALUES (?, 'zh', 'Legacy Node ZH', 'legacy-node', 'body', '<p>body</p>', 'published',
            '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')
  `).run(enPostId));

  db.close();
});

test('schema v3 migration allocates deterministic legacy tags and sanitizes slugs', t => {
  const taxonomyPath = writeTaxonomyCatalog(baseCatalog());
  t.after(() => fsSync.rmSync(path.dirname(taxonomyPath), { recursive: true, force: true }));
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(legacySchemaSql());
  insertLegacyArticle(db, {
    title: 'Tagged',
    slug: 'tagged',
    tags: ['Node.js', '教程', ' 教程 ', 'ＮｏｄｅＪｓ', 'NodeJs', 'bad/name', 'line\nbreak', '!!!', '未分类', 'nodejs']
  });
  insertLegacyArticle(db, { title: 'Untagged', slug: 'untagged', tags: [] });
  migrateDatabase(db, { taxonomyPath });

  const articleTags = db.prepare('SELECT tag_id FROM article_tags WHERE article_id = 1 ORDER BY tag_id').all()
    .map(row => row.tag_id);
  assert.ok(articleTags.includes('nodejs'), JSON.stringify(articleTags));
  assert.ok(articleTags.includes('other'), JSON.stringify(articleTags));

  const digest = value => createHash('sha256').update(value).digest('hex');
  const expectedLegacy = [
    `legacy-${digest('教程').slice(0, 12)}`,
    `legacy-${digest('NodeJs').slice(0, 12)}`,
    `legacy-${digest('nodejs').slice(0, 12)}`,
    `legacy-${digest('bad/name').slice(0, 12)}`,
    `legacy-${digest('line\nbreak').slice(0, 12)}`,
    `legacy-${digest('!!!').slice(0, 12)}`
  ].sort();
  const actualLegacy = articleTags.filter(tagId => tagId.startsWith('legacy-')).sort();
  assert.deepEqual(actualLegacy, expectedLegacy);

  for (const tagId of actualLegacy) {
    for (const locale of ['zh', 'en']) {
      const label = db.prepare('SELECT name, slug FROM tag_labels WHERE tag_id = ? AND locale = ?').get(tagId, locale);
      assert.equal(label.slug, tagId, `${tagId}/${locale} uses the safe legacy id as slug`);
    }
  }
  assert.equal(
    db.prepare("SELECT name FROM tag_labels WHERE tag_id = ? AND locale = 'zh'").get(`legacy-${digest('教程').slice(0, 12)}`).name,
    '教程'
  );
  assert.equal(
    db.prepare("SELECT name FROM tag_labels WHERE tag_id = ? AND locale = 'en'").get(`legacy-${digest('教程').slice(0, 12)}`).name,
    '教程'
  );
  assert.equal(
    db.prepare("SELECT name FROM tag_labels WHERE tag_id = ? AND locale = 'zh'").get(`legacy-${digest('NodeJs').slice(0, 12)}`).name,
    'NodeJs'
  );
  assert.equal(
    db.prepare("SELECT name FROM tag_labels WHERE tag_id = ? AND locale = 'zh'").get(`legacy-${digest('nodejs').slice(0, 12)}`).name,
    'nodejs'
  );
  assert.equal(
    db.prepare("SELECT name FROM tag_labels WHERE tag_id = ? AND locale = 'zh'").get(`legacy-${digest('bad/name').slice(0, 12)}`).name,
    'bad/name'
  );
  assert.equal(
    db.prepare("SELECT name FROM tag_labels WHERE tag_id = ? AND locale = 'zh'").get(`legacy-${digest('line\nbreak').slice(0, 12)}`).name,
    'line\nbreak'
  );
  assert.equal(
    db.prepare("SELECT name FROM tag_labels WHERE tag_id = ? AND locale = 'zh'").get(`legacy-${digest('!!!').slice(0, 12)}`).name,
    '!!!'
  );

  const legacyRows = db.prepare("SELECT category_id, origin, is_system FROM tags WHERE id LIKE 'legacy-%'").all();
  assert.ok(legacyRows.length >= 6, `expected legacy tags, got ${legacyRows.length}`);
  for (const row of legacyRows) {
    assert.equal(row.category_id, 'uncategorized');
    assert.equal(row.origin, 'legacy');
    assert.equal(row.is_system, 0);
  }

  assert.deepEqual(
    db.prepare('SELECT tag_id FROM article_tags WHERE article_id = 2').all().map(row => row.tag_id),
    ['other']
  );

  const configOther = db.prepare("SELECT category_id, origin, is_system FROM tags WHERE id = 'other'").get();
  assert.deepEqual(configOther, { category_id: 'uncategorized', origin: 'config', is_system: 1 });

  db.close();
});

test('schema v3 migration resolves ID and slug prefix collisions deterministically', t => {
  const digestJiao = createHash('sha256').update('教程').digest('hex');
  const digestJiShu = createHash('sha256').update('技术').digest('hex');
  const catalog = baseCatalog({
    extraTags: [
      {
        id: `legacy-${digestJiao.slice(0, 12)}`,
        sortOrder: 20,
        labels: {
          zh: { name: 'Collision A', slug: 'collision-a' },
          en: { name: 'Collision A', slug: 'collision-a' }
        },
        legacyNames: []
      },
      {
        id: 'collision-b',
        sortOrder: 30,
        labels: {
          zh: { name: 'Collision B', slug: `legacy-${digestJiShu.slice(0, 12)}` },
          en: { name: 'Collision B', slug: 'collision-b-en' }
        },
        legacyNames: []
      }
    ]
  });
  const taxonomyPath = writeTaxonomyCatalog(catalog);
  t.after(() => fsSync.rmSync(path.dirname(taxonomyPath), { recursive: true, force: true }));
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(legacySchemaSql());
  insertLegacyArticle(db, { title: 'Collisions', slug: 'collisions', tags: ['教程', '技术'] });
  migrateDatabase(db, { taxonomyPath });

  const jiaoTagId = `legacy-${digestJiao.slice(0, 20)}`;
  const jishuTagId = `legacy-${digestJiShu.slice(0, 20)}`;
  const legacyIds = db.prepare("SELECT id FROM tags WHERE id LIKE 'legacy-%' AND origin = 'legacy' ORDER BY id").all()
    .map(row => row.id);
  assert.deepEqual(legacyIds, [jiaoTagId, jishuTagId].sort());
  for (const tagId of [jiaoTagId, jishuTagId]) {
    const label = db.prepare("SELECT name, slug FROM tag_labels WHERE tag_id = ? AND locale = 'zh'").get(tagId);
    assert.equal(label.slug, tagId);
  }
  assert.equal(db.prepare("SELECT name FROM tag_labels WHERE tag_id = ? AND locale = 'zh'").get(jiaoTagId).name, '教程');
  assert.equal(db.prepare("SELECT name FROM tag_labels WHERE tag_id = ? AND locale = 'zh'").get(jishuTagId).name, '技术');
  db.close();
});

test('search index documents are locale-scoped and stay fresh on update and delete', t => {
  const taxonomyPath = writeTaxonomyCatalog(baseCatalog());
  t.after(() => fsSync.rmSync(path.dirname(taxonomyPath), { recursive: true, force: true }));
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(legacySchemaSql());
  insertLegacyArticle(db, {
    title: 'Chinese Post', slug: 'chinese-post', tags: ['Node.js'], content: '中文正文',
    created: '2026-01-01T00:00:00.000Z'
  });
  migrateDatabase(db, { taxonomyPath });

  const chinese = db.prepare("SELECT id, post_id FROM articles WHERE slug = 'chinese-post'").get();
  db.prepare(`
    INSERT INTO articles (post_id, locale, title, slug, content, html, status, created_at, updated_at)
    VALUES (?, 'en', 'English Post', 'english-post', 'English body', '<p>English body</p>', 'published',
            '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')
  `).run(chinese.post_id);
  const english = db.prepare("SELECT id FROM articles WHERE slug = 'english-post'").get();
  db.prepare('INSERT INTO article_tags (article_id, tag_id) VALUES (?, ?)').run(english.id, 'nodejs');

  db.transaction(() => rebuildArticleSearchIndex(db))();
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM article_fts').get().count, 2);

  const zhDocument = buildArticleSearchDocument(db, chinese.id);
  assert.equal(zhDocument.title, 'Chinese Post');
  assert.equal(zhDocument.content, '中文正文');
  assert.match(zhDocument.taxonomy, /技术/);
  assert.match(zhDocument.taxonomy, /Node\.js/);

  assert.deepEqual(searchArticleIds(db, 'zh', '技术'), [chinese.id]);
  assert.deepEqual(searchArticleIds(db, 'en', 'Technology'), [english.id]);
  assert.deepEqual(searchArticleIds(db, 'en', '中文正文'), []);

  db.prepare('UPDATE articles SET content = ?, updated_at = ? WHERE id = ?')
    .run('replacement zh body', '2026-02-01T00:00:00.000Z', chinese.id);
  upsertArticleSearchDocument(db, chinese.id);
  assert.deepEqual(searchArticleIds(db, 'zh', '中文正文'), []);
  assert.deepEqual(searchArticleIds(db, 'zh', 'replacement'), [chinese.id]);

  assert.equal(upsertArticleSearchDocument(db, 999), undefined);

  deleteArticleSearchDocument(db, english.id);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM article_fts').get().count, 1);
  assert.deepEqual(searchArticleIds(db, 'en', 'Technology'), []);
  db.close();
});

test('draft article IDs cannot receive public comments', () => {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec('CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT NOT NULL UNIQUE)');
  migrateDatabase(db);
  const postId = Number(db.prepare(`
    INSERT INTO posts (translation_key, created_at, updated_at)
    VALUES ('draft-post', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')
  `).run().lastInsertRowid);
  const articleId = Number(db.prepare(`
    INSERT INTO articles (post_id, locale, title, slug, content, html, status, created_at, updated_at)
    VALUES (?, 'zh', 'Draft', 'draft', 'body', '<p>body</p>', 'draft',
            '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')
  `).run(postId).lastInsertRowid);
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
  db.pragma('foreign_keys = ON');
  migrateDatabase(db);
  const { createTagResolver } = require('../server/articles/schema');
  const resolveTagId = createTagResolver(db, { acceptTagIds: true });
  const insertPost = db.prepare('INSERT INTO posts (translation_key, created_at, updated_at) VALUES (?, ?, ?)');
  const insertArticle = db.prepare(`
    INSERT INTO articles (post_id, locale, title, slug, content, html, status, created_at, updated_at)
    VALUES (?, 'zh', ?, ?, ?, '<p>body</p>', 'published', ?, ?)
  `);
  const insertArticleTag = db.prepare('INSERT INTO article_tags (article_id, tag_id) VALUES (?, ?)');
  db.transaction(() => {
    for (let index = 0; index < 10_000; index += 1) {
      const date = new Date(Date.UTC(2026, 0, 1) + index * 1000).toISOString();
      const postId = Number(insertPost.run(`article-${index}`, date, date).lastInsertRowid);
      const articleId = Number(insertArticle.run(
        postId, `Article ${index}`, `article-${index}`,
        `full text performance needle ${index}`, date, date
      ).lastInsertRowid);
      const tagIds = new Set(['node', `group-${index % 20}`].map(resolveTagId));
      for (const tagId of tagIds) insertArticleTag.run(articleId, tagId);
      upsertArticleSearchDocument(db, articleId);
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

test('archive grouping uses the Beijing calendar boundary', () => {
  const grouped = groupArticlesByMonth([
    { id: 1, created_at: '2026-01-31T15:59:59.000Z' },
    { id: 2, created_at: '2026-01-31T16:00:00.000Z' }
  ]);
  assert.deepEqual(grouped['2026']['1'].map(article => article.id), [1]);
  assert.deepEqual(grouped['2026']['2'].map(article => article.id), [2]);
});

test('concurrent Chinese uploads sharing a requested slug both succeed with serialized allocation', async t => {
  const { root, baseUrl } = await harness(t);
  const [firstResponse, secondResponse] = await Promise.all([
    submit(baseUrl, '/api/admin/upload', 'first.md',
      markdown({ title: 'Concurrent First', slug: 'concurrent-slug', tags: '[工具]' })),
    submit(baseUrl, '/api/admin/upload', 'second.md',
      markdown({ title: 'Concurrent Second', slug: 'concurrent-slug', tags: '[生活]' }))
  ]);
  const first = await firstResponse.json();
  const second = await secondResponse.json();
  assert.equal(firstResponse.status, 200, JSON.stringify(first));
  assert.equal(secondResponse.status, 200, JSON.stringify(second));

  const slugs = [first.article.slug, second.article.slug].sort();
  assert.equal(slugs[0], 'concurrent-slug');
  assert.match(slugs[1], /^concurrent-slug-\d+$/);

  const db = new Database(path.join(root, 'blog.db'));
  const keys = db.prepare('SELECT translation_key FROM posts ORDER BY translation_key').all()
    .map(row => row.translation_key);
  assert.deepEqual(keys, slugs);
  db.close();
});

test('scripts/query-db.js reports normalized tags after migration', async t => {
  const { root, baseUrl } = await harness(t);
  const response = await submit(baseUrl, '/api/admin/upload', 'query-db.md',
    markdown({ title: 'Query DB Article', slug: 'query-db-article', tags: '[工具]' }));
  const body = await response.json();
  assert.equal(response.status, 200, JSON.stringify(body));

  const result = runNode(root, 'scripts/query-db.js');
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /Query DB Article/);
  assert.match(result.stdout, /query-db-article/);
  assert.match(result.stdout, /工具/);
  assert.match(result.stdout, /文章总数: 1/);
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

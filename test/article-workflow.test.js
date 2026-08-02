const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { performance } = require('node:perf_hooks');
const test = require('node:test');
const Database = require('better-sqlite3');
const AdmZip = require('adm-zip');
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
const { validMp3 } = require('./helpers/article-audio-fixtures');

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

const TUTORIAL_TAG = Object.freeze({
  id: 'tutorial',
  sortOrder: 20,
  labels: {
    zh: { name: '教程', slug: '教程' },
    en: { name: 'Tutorial', slug: 'tutorial' }
  },
  legacyNames: []
});

function seededCatalog() {
  return baseCatalog({ extraTags: [TUTORIAL_TAG] });
}

function writeFixtureCatalog(root, catalog) {
  const contentDir = path.join(root, 'content');
  fsSync.mkdirSync(contentDir, { recursive: true });
  fsSync.writeFileSync(path.join(contentDir, 'taxonomy.json'), JSON.stringify(catalog));
}

async function seededHarness(t) {
  const root = await createProjectFixture(t);
  writeFixtureCatalog(root, seededCatalog());
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

function audioZip(markdownName, markdown, mp3) {
  const zip = new AdmZip();
  zip.addFile(markdownName, Buffer.from(markdown));
  zip.addFile('audio/final.mp3', mp3);
  return zip.toBuffer();
}

function markdown({ title, slug, status = 'published', body = 'searchable body', description = 'summary', tags = '[other]', locale, translationKey }) {
  const extras = [
    ...(locale ? [`locale: ${locale}`] : []),
    ...(translationKey ? [`translationKey: ${translationKey}`] : [])
  ].join('\n');
  return `---\ntitle: ${title}\nslug: ${slug}\ndescription: ${description}\ntags: ${tags}\nstatus: ${status}${extras ? `\n${extras}` : ''}\n---\n\n${body}\n`;
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

test('legacy resolver adopts a cross-run tag only when the stored label is equivalent', () => {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  migrateDatabase(db);
  const digest = value => createHash('sha256').update(value).digest('hex');
  const { createTagResolver } = require('../server/articles/schema');

  // Simulate a previous resolver run: a legacy tag whose id equals another
  // label's base digest prefix but whose stored visible label differs. A fresh
  // resolver run must not adopt it for the distinct label.
  const collisionLabel = '教程';
  const collisionId = `legacy-${digest(collisionLabel).slice(0, 12)}`;
  const extendedId = `legacy-${digest(collisionLabel).slice(0, 20)}`;
  db.prepare(`
    INSERT INTO tags (id, category_id, sort_order, origin, is_system)
    VALUES (?, 'uncategorized', 0, 'legacy', 0)
  `).run(collisionId);
  db.prepare(`
    INSERT INTO tag_labels (tag_id, locale, name, slug) VALUES (?, 'zh', ?, ?), (?, 'en', ?, ?)
  `).run(collisionId, '别的标签', collisionId, collisionId, 'Another Label', collisionId);

  // A pre-existing legacy tag whose stored label IS equivalent to an incoming
  // NFKC variant must be adopted (cross-run dedupe).
  const nodeLabel = 'NodeJs';
  const nodeId = `legacy-${digest(nodeLabel).slice(0, 12)}`;
  db.prepare(`
    INSERT INTO tags (id, category_id, sort_order, origin, is_system)
    VALUES (?, 'uncategorized', 0, 'legacy', 0)
  `).run(nodeId);
  db.prepare(`
    INSERT INTO tag_labels (tag_id, locale, name, slug) VALUES (?, 'zh', ?, ?), (?, 'en', ?, ?)
  `).run(nodeId, 'NodeJs', nodeId, nodeId, 'NodeJs', nodeId);

  const resolveTagId = createTagResolver(db, { acceptTagIds: true });

  // The distinct incoming label extends the digest instead of adopting the
  // pre-existing tag, and the pre-existing tag stays untouched.
  assert.equal(resolveTagId(collisionLabel), extendedId);
  assert.equal(
    db.prepare("SELECT name FROM tag_labels WHERE tag_id = ? AND locale = 'zh'").get(extendedId).name,
    collisionLabel
  );
  assert.equal(
    db.prepare("SELECT name FROM tag_labels WHERE tag_id = ? AND locale = 'zh'").get(collisionId).name,
    '别的标签'
  );
  assert.equal(db.prepare("SELECT origin FROM tags WHERE id = ?").get(collisionId).origin, 'legacy');

  // An equivalent (NFKC) incoming label is adopted from the previous run.
  assert.equal(resolveTagId('ＮｏｄｅＪｓ'), nodeId);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM tags WHERE id = ?').get(nodeId).count, 1);

  // After the extended allocation, the same label dedupes to the extended tag.
  assert.equal(resolveTagId(' 教程 '), extendedId);
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
      markdown({ title: 'Concurrent First', slug: 'concurrent-slug', tags: '[other]' })),
    submit(baseUrl, '/api/admin/upload', 'second.md',
      markdown({ title: 'Concurrent Second', slug: 'concurrent-slug', tags: '[other]' }))
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
    markdown({ title: 'Query DB Article', slug: 'query-db-article', tags: '[other]' }));
  const body = await response.json();
  assert.equal(response.status, 200, JSON.stringify(body));

  const result = runNode(root, 'scripts/query-db.js');
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /Query DB Article/);
  assert.match(result.stdout, /query-db-article/);
  assert.match(result.stdout, /工具/);
  assert.match(result.stdout, /文章总数: 1/);
});

test('admin delete reports failure and preserves files when the article row vanishes', async t => {
  const { root, baseUrl } = await harness(t);
  const uploadResponse = await submit(baseUrl, '/api/admin/upload', 'race.md',
    markdown({ title: 'Delete Race', slug: 'delete-race', tags: '[other]' }));
  const uploaded = await uploadResponse.json();
  assert.equal(uploadResponse.status, 200, JSON.stringify(uploaded));

  const markdownPath = path.join(root, 'articles', 'zh', 'delete-race.md');
  const originalMarkdown = await fs.readFile(markdownPath, 'utf8');
  assert.ok(originalMarkdown.length > 0);

  // Simulate the row disappearing between the route's lookup and its commit:
  // a BEFORE DELETE trigger makes the DELETE match zero rows.
  const raceDb = new Database(path.join(root, 'blog.db'));
  raceDb.exec('CREATE TRIGGER block_delete BEFORE DELETE ON articles BEGIN SELECT RAISE(IGNORE); END;');
  raceDb.close();

  const response = await fetch(`${baseUrl}/api/admin/articles/${uploaded.article.id}`, {
    method: 'DELETE',
    headers: { cookie: cookie() }
  });

  // No silent success: the publication helper sees changes === 0 and restores
  // the tombstones, so the route reports a server error.
  assert.equal(response.status, 500, await response.text());
  assert.equal(await fs.readFile(markdownPath, 'utf8'), originalMarkdown);

  const verify = new Database(path.join(root, 'blog.db'));
  const surviving = verify.prepare('SELECT id, post_id FROM articles WHERE id = ?').get(uploaded.article.id);
  assert.ok(surviving);
  assert.ok(verify.prepare('SELECT id FROM posts WHERE id = ?').get(surviving.post_id));
  verify.close();
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
  const saved = await fs.readFile(path.join(root, 'articles', 'zh', 'published-node.md'), 'utf8');
  assert.match(saved, /Updated Node Guide/);
});

test('explicit Chinese and English uploads share translationKey, slug, and locale-scoped files', async t => {
  const { root, baseUrl } = await seededHarness(t);
  const mp3 = validMp3();
  const hash = createHash('sha256').update(mp3).digest('hex');
  const zhMarkdown = `---
title: 双语文章
slug: dual-post
locale: zh
translationKey: dual-post
tags: [nodejs, tutorial]
---

:::audio
title: 中文音频
src: ./audio/final.mp3
:::`;
  const enMarkdown = `---
title: Bilingual Post
slug: dual-post
locale: en
translationKey: dual-post
tags: [nodejs, tutorial]
---

:::audio
title: English Audio
src: ./audio/final.mp3
:::`;

  const [zhResponse, enResponse] = await Promise.all([
    submit(baseUrl, '/api/admin/upload', 'zh.zip', audioZip('zh.md', zhMarkdown, mp3)),
    submit(baseUrl, '/api/admin/upload', 'en.zip', audioZip('en.md', enMarkdown, mp3))
  ]);
  const zhBody = await zhResponse.json();
  const enBody = await enResponse.json();
  assert.equal(zhResponse.status, 200, JSON.stringify(zhBody));
  assert.equal(enResponse.status, 200, JSON.stringify(enBody));

  const db = new Database(path.join(root, 'blog.db'));
  const articles = db.prepare('SELECT id, locale, slug, post_id FROM articles WHERE slug = ? ORDER BY locale').all('dual-post');
  assert.deepEqual(articles.map(article => article.locale), ['en', 'zh']);
  assert.equal(articles.length, 2);
  assert.equal(articles[0].post_id, articles[1].post_id);
  assert.equal(
    db.prepare('SELECT translation_key FROM posts WHERE id = ?').get(articles[0].post_id).translation_key,
    'dual-post'
  );
  const tagRows = db.prepare(`
    SELECT tag_id FROM article_tags WHERE article_id = ? ORDER BY tag_id
  `).all(articles.find(article => article.locale === 'zh').id).map(row => row.tag_id);
  assert.deepEqual(tagRows, ['nodejs', 'tutorial']);
  db.close();

  await assert.doesNotReject(() => fs.access(path.join(root, 'articles', 'zh', 'dual-post.md')));
  await assert.doesNotReject(() => fs.access(path.join(root, 'articles', 'en', 'dual-post.md')));
  await assert.doesNotReject(() => fs.access(path.join(root, 'public', 'audio', 'zh', 'dual-post', `${hash}.mp3`)));
  await assert.doesNotReject(() => fs.access(path.join(root, 'public', 'audio', 'en', 'dual-post', `${hash}.mp3`)));

  const zhFile = await fs.readFile(path.join(root, 'articles', 'zh', 'dual-post.md'), 'utf8');
  const enFile = await fs.readFile(path.join(root, 'articles', 'en', 'dual-post.md'), 'utf8');
  assert.match(zhFile, /locale: zh/);
  assert.match(zhFile, /translationKey: dual-post/);
  assert.match(enFile, /locale: en/);
  assert.match(enFile, /translationKey: dual-post/);
});

test('same-locale explicit translationKey upload returns translation_locale_exists', async t => {
  const { root, baseUrl } = await seededHarness(t);
  const firstResponse = await submit(baseUrl, '/api/admin/upload', 'first.md',
    markdown({ title: 'First Conflict', slug: 'conflict-post', locale: 'zh', translationKey: 'conflict-post', tags: '[nodejs]' }));
  assert.equal(firstResponse.status, 200, await firstResponse.text());

  const secondResponse = await submit(baseUrl, '/api/admin/upload', 'second.md',
    markdown({ title: 'Second Conflict', slug: 'conflict-other', locale: 'zh', translationKey: 'conflict-post', tags: '[nodejs]' }));
  const secondBody = await secondResponse.json();
  assert.equal(secondResponse.status, 409, JSON.stringify(secondBody));
  assert.equal(secondBody.code, 'translation_locale_exists');

  const db = new Database(path.join(root, 'blog.db'));
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM articles').get().count, 1);
  db.close();
  await assert.rejects(fs.access(path.join(root, 'articles', 'zh', 'conflict-other.md')), { code: 'ENOENT' });
});

test('a locale slug belonging to another post returns locale_slug_exists', async t => {
  const { root, baseUrl } = await seededHarness(t);
  const firstResponse = await submit(baseUrl, '/api/admin/upload', 'first.md',
    markdown({ title: 'First Owner', slug: 'shared-slug', locale: 'en', translationKey: 'owner-post', tags: '[nodejs]' }));
  assert.equal(firstResponse.status, 200, await firstResponse.text());

  const secondResponse = await submit(baseUrl, '/api/admin/upload', 'second.md',
    markdown({ title: 'Second Owner', slug: 'shared-slug', locale: 'en', translationKey: 'other-post', tags: '[nodejs]' }));
  const secondBody = await secondResponse.json();
  assert.equal(secondResponse.status, 409, JSON.stringify(secondBody));
  assert.equal(secondBody.code, 'locale_slug_exists');

  const db = new Database(path.join(root, 'blog.db'));
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM articles').get().count, 1);
  db.close();
});

test('rejects unknown stable tag IDs before staging any publication files', async t => {
  const { root, baseUrl } = await seededHarness(t);
  const response = await submit(baseUrl, '/api/admin/upload', 'unknown-tag.md',
    markdown({ title: 'Unknown Tag', slug: 'unknown-tag', tags: '[not-a-stable-id]' }));
  const body = await response.json();
  assert.equal(response.status, 400, JSON.stringify(body));
  assert.equal(body.code, 'unknown_taxonomy_tag');

  const db = new Database(path.join(root, 'blog.db'));
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM articles').get().count, 0);
  db.close();
  await assert.rejects(fs.access(path.join(root, 'articles', 'zh', 'unknown-tag.md')), { code: 'ENOENT' });
});

test('English uploads cannot reference legacy-origin tags while Chinese uploads may', async t => {
  const { root, baseUrl } = await seededHarness(t);

  const db = new Database(path.join(root, 'blog.db'));
  db.prepare(`
    INSERT INTO tags (id, category_id, sort_order, origin, is_system)
    VALUES ('legacy-old-label', 'uncategorized', 0, 'legacy', 0)
  `).run();
  db.prepare(`
    INSERT INTO tag_labels (tag_id, locale, name, slug)
    VALUES ('legacy-old-label', 'zh', '旧标签', 'legacy-old-label'),
           ('legacy-old-label', 'en', '旧标签', 'legacy-old-label')
  `).run();
  db.close();

  const zhResponse = await submit(baseUrl, '/api/admin/upload', 'zh-legacy.md',
    markdown({ title: '中文旧标签', slug: 'zh-legacy', locale: 'zh', tags: '[legacy-old-label]' }));
  assert.equal(zhResponse.status, 200, await zhResponse.text());

  const enResponse = await submit(baseUrl, '/api/admin/upload', 'en-legacy.md',
    markdown({ title: 'English Legacy', slug: 'en-legacy', locale: 'en', tags: '[legacy-old-label]' }));
  const enBody = await enResponse.json();
  assert.equal(enResponse.status, 400, JSON.stringify(enBody));
  assert.equal(enBody.code, 'unlocalized_taxonomy_tag');

  const verify = new Database(path.join(root, 'blog.db'));
  assert.equal(verify.prepare("SELECT COUNT(*) AS count FROM articles WHERE locale = 'en'").get().count, 0);
  verify.close();
});

test('omitted translationKey compatibility allocation attaches cross-locale to the logical post', async t => {
  const { root, baseUrl } = await seededHarness(t);
  const zhResponse = await submit(baseUrl, '/api/admin/upload', 'zh.md',
    markdown({ title: '中文文章', slug: 'attach-post', tags: '[nodejs]' }));
  assert.equal(zhResponse.status, 200, await zhResponse.text());

  const enResponse = await submit(baseUrl, '/api/admin/upload', 'en.md',
    markdown({ title: 'English Article', slug: 'attach-post', locale: 'en', tags: '[nodejs]' }));
  const enBody = await enResponse.json();
  assert.equal(enResponse.status, 200, JSON.stringify(enBody));

  const db = new Database(path.join(root, 'blog.db'));
  const articles = db.prepare('SELECT locale, slug, post_id FROM articles WHERE slug = ? ORDER BY locale').all('attach-post');
  assert.deepEqual(articles.map(article => article.locale), ['en', 'zh']);
  assert.equal(articles[0].post_id, articles[1].post_id);
  assert.equal(
    db.prepare('SELECT translation_key FROM posts WHERE id = ?').get(articles[0].post_id).translation_key,
    'attach-post'
  );
  db.close();
});

test('replacement keeps locale, translationKey, and slug immutable', async t => {
  const { root, baseUrl } = await seededHarness(t);
  const uploadedResponse = await submit(baseUrl, '/api/admin/upload', 'immutable.md',
    markdown({ title: 'Immutable Original', slug: 'immutable-post', locale: 'zh', translationKey: 'immutable-post', tags: '[nodejs]' }));
  const uploaded = await uploadedResponse.json();
  assert.equal(uploadedResponse.status, 200, JSON.stringify(uploaded));

  const wrongLocaleResponse = await submit(baseUrl, '/api/admin/upload', 'wrong-locale.md',
    markdown({ title: 'Wrong Locale', slug: 'immutable-post', locale: 'en', translationKey: 'immutable-post', tags: '[nodejs]' }),
    { replaceId: String(uploaded.article.id) });
  const wrongLocaleBody = await wrongLocaleResponse.json();
  assert.equal(wrongLocaleResponse.status, 400, JSON.stringify(wrongLocaleBody));
  assert.equal(wrongLocaleBody.code, 'article_replace_locale_mismatch');

  const wrongKeyResponse = await submit(baseUrl, '/api/admin/upload', 'wrong-key.md',
    markdown({ title: 'Wrong Key', slug: 'immutable-post', locale: 'zh', translationKey: 'other-key', tags: '[nodejs]' }),
    { replaceId: String(uploaded.article.id) });
  const wrongKeyBody = await wrongKeyResponse.json();
  assert.equal(wrongKeyResponse.status, 400, JSON.stringify(wrongKeyBody));
  assert.equal(wrongKeyBody.code, 'article_replace_translation_key_mismatch');

  const db = new Database(path.join(root, 'blog.db'));
  const article = db.prepare('SELECT locale, slug, title FROM articles WHERE id = ?').get(uploaded.article.id);
  assert.equal(article.locale, 'zh');
  assert.equal(article.slug, 'immutable-post');
  assert.equal(article.title, 'Immutable Original');
  db.close();
});

test('concurrent omitted-translationKey uploads keep distinct locale-scoped audio paths', async t => {
  const { root, baseUrl } = await seededHarness(t);
  const mp3 = validMp3();
  const markdownBody = `---
title: Concurrent Song
slug: concurrent-song
---

:::audio
title: Concurrent
src: ./audio/final.mp3
:::`;
  const responses = await Promise.all([
    submit(baseUrl, '/api/admin/upload', 'one.zip', audioZip('one.md', markdownBody, mp3)),
    submit(baseUrl, '/api/admin/upload', 'two.zip', audioZip('two.md', markdownBody, mp3))
  ]);
  const bodies = await Promise.all(responses.map(response => response.json()));
  assert.deepEqual(responses.map(response => response.status), [200, 200], JSON.stringify(bodies));

  const slugs = bodies.map(body => body.article.slug).sort();
  assert.equal(new Set(slugs).size, 2);
  assert.ok(slugs.includes('concurrent-song'));
  assert.ok(slugs.some(slug => /^concurrent-song-\d+$/.test(slug)));

  const db = new Database(path.join(root, 'blog.db'));
  const keys = db.prepare('SELECT translation_key FROM posts ORDER BY translation_key').all()
    .map(row => row.translation_key);
  assert.deepEqual(keys, slugs);
  db.close();
  for (const slug of slugs) {
    await assert.doesNotReject(() => fs.access(path.join(root, 'articles', 'zh', `${slug}.md`)));
    const audioFiles = await fs.readdir(path.join(root, 'public', 'audio', 'zh', slug));
    assert.equal(audioFiles.length, 1);
  }
});

test('content migration leaves localized publications alone and the page serves localized audio with ranges', async t => {
  const { root, baseUrl } = await seededHarness(t);
  const mp3 = validMp3();
  const hash = createHash('sha256').update(mp3).digest('hex');
  const markdownBody = `---
title: Range Song
slug: range-song
tags: [nodejs]
---

:::audio
title: Range
src: ./audio/final.mp3
:::`;
  const zip = new AdmZip();
  zip.addFile('article.md', Buffer.from(markdownBody));
  zip.addFile('audio/final.mp3', mp3);

  const response = await submit(baseUrl, '/api/admin/upload', 'range-song.zip', zip.toBuffer());
  const body = await response.json();
  assert.equal(response.status, 200, JSON.stringify(body));

  const result = runNode(root, 'scripts/migrate-localized-content.js');
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  const output = JSON.parse(result.stdout);
  assert.equal(output.applied, true);
  assert.deepEqual(output.plan.markdownMoves, []);
  assert.deepEqual(output.plan.audioMoves, []);
  assert.deepEqual(output.plan.metadataRewrites, []);

  const page = await (await fetch(`${baseUrl}/article/range-song`)).text();
  assert.match(page, new RegExp(`/audio/zh/range-song/${hash}\\.mp3`));
  assert.doesNotMatch(page, /\/audio\/range-song\//, 'page must not contain legacy audio URLs');

  const audioUrl = `${baseUrl}/audio/zh/range-song/${hash}.mp3`;
  const rangeResponse = await fetch(audioUrl, { headers: { range: 'bytes=0-3' } });
  assert.equal(rangeResponse.status, 206);
  assert.equal(rangeResponse.headers.get('content-range'), `bytes 0-3/${mp3.length}`);
  assert.deepEqual(Buffer.from(await rangeResponse.arrayBuffer()), mp3.subarray(0, 4));
});

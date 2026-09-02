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

// The zh display name and legacy names deliberately differ from the safe zh
// slug so legacy /tag/ resolution proves it maps through the catalog instead
// of echoing the incoming display string.
const DESIGN_TAG = Object.freeze({
  id: 'design',
  sortOrder: 25,
  labels: {
    zh: { name: '界面设计', slug: 'ui-zh' },
    en: { name: 'UI Design', slug: 'ui-design' }
  },
  legacyNames: ['design', 'UI设计']
});

function seededCatalog() {
  return baseCatalog({ extraTags: [TUTORIAL_TAG, DESIGN_TAG] });
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

/**
 * Task 9 SEO/feed harness: seeds localized posts directly into the fixture
 * database (after init-db applies the v3 schema) so asymmetric pagination and
 * translation fixtures stay fast, then boots the real server.
 */
async function seoSeededHarness(t, seed) {
  const root = await createProjectFixture(t);
  writeFixtureCatalog(root, seededCatalog());
  const init = runNode(root, 'server/scripts/init-db.js', [], { INITIAL_ADMIN_PASSWORD: INITIAL_PASSWORD });
  assert.equal(init.status, 0, init.stderr);
  const db = new Database(path.join(root, 'blog.db'));
  db.pragma('foreign_keys = ON');
  const created = day => new Date(Date.UTC(2026, 0, day)).toISOString();
  seed(db, created);
  db.close();
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

function insertLocalizedPost(db, {
  translationKey,
  locale,
  slug,
  title,
  status = 'published',
  body = 'body',
  description = null,
  created = '2026-01-01T00:00:00.000Z'
}) {
  let post = db.prepare('SELECT id FROM posts WHERE translation_key = ?').get(translationKey);
  const postId = post ? post.id : Number(db.prepare(
    'INSERT INTO posts (translation_key, created_at, updated_at) VALUES (?, ?, ?)'
  ).run(translationKey, created, created).lastInsertRowid);
  const articleId = Number(db.prepare(`
    INSERT INTO articles (post_id, locale, title, slug, content, html, status, description, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, '<p>body</p>', ?, ?, ?, ?)
  `).run(postId, locale, title, slug, body, status, description, created, created).lastInsertRowid);
  return { postId, articleId };
}

function attachTags(db, articleId, tagIds) {
  const statement = db.prepare('INSERT INTO article_tags (article_id, tag_id) VALUES (?, ?)');
  for (const tagId of tagIds) statement.run(articleId, tagId);
}

function insertTagLabels(db, { id, categoryId = 'uncategorized', zhName, zhSlug, enName, enSlug, sortOrder = 5 }) {
  db.prepare(`
    INSERT INTO tags (id, category_id, sort_order, origin, is_system) VALUES (?, ?, ?, 'config', 0)
  `).run(id, categoryId, sortOrder);
  db.prepare(`
    INSERT INTO tag_labels (tag_id, locale, name, slug) VALUES (?, 'zh', ?, ?), (?, 'en', ?, ?)
  `).run(id, zhName, zhSlug, id, enName, enSlug);
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
  // resolver run must not adopt it for the distinct label. The collision label
  // must stay outside the catalog: '教程' is now a stable tag name (tutorials),
  // so use a deterministic unknown label to exercise the digest-collision path.
  const collisionLabel = '游戏';
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
  assert.equal(resolveTagId(' 游戏 '), extendedId);
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

test('10k published articles keep indexed search, tag, and category queries within local budgets', t => {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  migrateDatabase(db);
  const insertPost = db.prepare('INSERT INTO posts (translation_key, created_at, updated_at) VALUES (?, ?, ?)');
  const insertArticle = db.prepare(`
    INSERT INTO articles (post_id, locale, title, slug, content, html, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, '<p>body</p>', 'published', ?, ?)
  `);
  const insertArticleTag = db.prepare('INSERT INTO article_tags (article_id, tag_id) VALUES (?, ?)');
  const insertTag = db.prepare(`
    INSERT INTO tags (id, category_id, sort_order, origin, is_system) VALUES (?, 'uncategorized', 0, 'legacy', 0)
  `);
  const insertTagLabel = db.prepare(`
    INSERT INTO tag_labels (tag_id, locale, name, slug) VALUES (?, ?, ?, ?)
  `);
  // 20 group tags with localized labels and real slugs, plus a tag in the
  // config-owned technology category.
  for (let group = 0; group < 20; group += 1) {
    insertTag.run(`perf-group-${group}`);
    for (const locale of ['zh', 'en']) {
      insertTagLabel.run(`perf-group-${group}`, locale, `Group ${group}`, `group-${group}`);
    }
  }
  db.prepare(`
    INSERT INTO tags (id, category_id, sort_order, origin, is_system) VALUES ('perf-node', 'technology', 5, 'config', 0)
  `).run();
  for (const locale of ['zh', 'en']) {
    insertTagLabel.run('perf-node', locale, 'Node', 'node');
  }
  // 5000 posts with published zh + en siblings = 10,000 published articles.
  db.transaction(() => {
    for (let index = 0; index < 5_000; index += 1) {
      const date = new Date(Date.UTC(2026, 0, 1) + index * 1000).toISOString();
      const postId = Number(insertPost.run(`article-${index}`, date, date).lastInsertRowid);
      const groupTag = `perf-group-${index % 20}`;
      for (const locale of ['zh', 'en']) {
        const articleId = Number(insertArticle.run(
          postId, locale, `Article ${index} ${locale}`, `article-${index}`,
          `full text performance needle ${index} ${locale}`, date, date
        ).lastInsertRowid);
        insertArticleTag.run(articleId, 'perf-node');
        insertArticleTag.run(articleId, groupTag);
        upsertArticleSearchDocument(db, articleId);
      }
    }
  })();
  const service = createArticleService(db);
  const searchDurations = [];
  const tagDurations = [];
  const categoryDurations = [];
  for (let sample = 0; sample < 20; sample += 1) {
    let started = performance.now();
    assert.ok(service.search('zh', 'performance needle').length > 0);
    searchDurations.push(performance.now() - started);
    started = performance.now();
    assert.equal(service.listByTag('zh', 'group-1').length, 250);
    tagDurations.push(performance.now() - started);
    started = performance.now();
    assert.equal(service.listByCategory('zh', '技术').length, 5000);
    categoryDurations.push(performance.now() - started);
  }
  const p95 = values => values.sort((a, b) => a - b)[Math.ceil(values.length * 0.95) - 1];
  const searchP95 = p95(searchDurations);
  const tagP95 = p95(tagDurations);
  const categoryP95 = p95(categoryDurations);
  assert.ok(searchP95 < 250, `search p95=${searchP95}ms`);
  assert.ok(tagP95 < 250, `tag p95=${tagP95}ms`);
  assert.ok(categoryP95 < 250, `category p95=${categoryP95}ms`);
  t.diagnostic(`10k local search p95=${searchP95.toFixed(2)}ms, tag p95=${tagP95.toFixed(2)}ms, category p95=${categoryP95.toFixed(2)}ms`);
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
  // The FTS row must survive too: the transaction deletes it only after the
  // article row actually vanished, so a zero-change DELETE cannot strand a
  // stale search document.
  assert.equal(verify.prepare('SELECT COUNT(*) AS count FROM article_fts WHERE rowid = ?').get(uploaded.article.id).count, 1);
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
  assert.equal(wrongLocaleBody.code, 'translation_identity_mismatch');
  assert.equal(wrongLocaleBody.reason, 'locale');

  const wrongKeyResponse = await submit(baseUrl, '/api/admin/upload', 'wrong-key.md',
    markdown({ title: 'Wrong Key', slug: 'immutable-post', locale: 'zh', translationKey: 'other-key', tags: '[nodejs]' }),
    { replaceId: String(uploaded.article.id) });
  const wrongKeyBody = await wrongKeyResponse.json();
  assert.equal(wrongKeyResponse.status, 400, JSON.stringify(wrongKeyBody));
  assert.equal(wrongKeyBody.code, 'translation_identity_mismatch');
  assert.equal(wrongKeyBody.reason, 'translation_key');

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

test('preview and upload responses carry locale, translationKey, postId, and localized taxonomy summaries', async t => {
  const { baseUrl } = await seededHarness(t);

  const previewResponse = await submit(baseUrl, '/api/admin/preview', 'summary.md',
    markdown({ title: 'Summary Post', slug: 'summary-post', locale: 'zh', translationKey: 'summary-post', tags: '[nodejs, tutorial]' }));
  const preview = await previewResponse.json();
  assert.equal(previewResponse.status, 200, JSON.stringify(preview));
  assert.equal(preview.locale, 'zh');
  assert.equal(preview.translationKey, 'summary-post');
  assert.deepEqual(preview.categories, [{ name: '技术', tags: ['Node.js', '教程'] }]);
  assert.deepEqual(preview.tags, ['Node.js', '教程']);

  const uploadResponse = await submit(baseUrl, '/api/admin/upload', 'summary.md',
    markdown({ title: 'Summary Post', slug: 'summary-post', locale: 'zh', translationKey: 'summary-post', tags: '[nodejs, tutorial]' }));
  const uploaded = await uploadResponse.json();
  assert.equal(uploadResponse.status, 200, JSON.stringify(uploaded));
  assert.equal(uploaded.article.locale, 'zh');
  assert.equal(uploaded.article.translationKey, 'summary-post');
  assert.ok(uploaded.article.postId);
  assert.deepEqual(uploaded.article.tags, ['nodejs', 'tutorial']);
  assert.deepEqual(uploaded.article.categories, [{ name: '技术', tags: ['Node.js', '教程'] }]);

  // An English sibling summarizes in its own locale without leaking Chinese data.
  const enUploadResponse = await submit(baseUrl, '/api/admin/upload', 'summary-en.md',
    markdown({ title: 'Summary EN', slug: 'summary-post', locale: 'en', translationKey: 'summary-post', tags: '[tutorial]' }));
  const enUploaded = await enUploadResponse.json();
  assert.equal(enUploadResponse.status, 200, JSON.stringify(enUploaded));
  assert.equal(enUploaded.article.locale, 'en');
  assert.equal(enUploaded.article.postId, uploaded.article.postId);
  assert.equal(enUploaded.article.translationKey, 'summary-post');
  assert.deepEqual(enUploaded.article.categories, [{ name: 'Technology', tags: ['Tutorial'] }]);
  assert.deepEqual(enUploaded.article.tags, ['tutorial']);

  // The earlier zh summaries still show only zh taxonomy.
  assert.deepEqual(preview.categories, [{ name: '技术', tags: ['Node.js', '教程'] }]);
  assert.deepEqual(uploaded.article.categories, [{ name: '技术', tags: ['Node.js', '教程'] }]);
});

test('a draft English sibling stays out of public discovery while the Chinese post is published', async t => {
  const { root, baseUrl } = await seededHarness(t);
  const zhResponse = await submit(baseUrl, '/api/admin/upload', 'zh.md',
    markdown({ title: '公开中文', slug: 'twin-post', locale: 'zh', translationKey: 'twin-post', tags: '[nodejs]', body: '公开中文正文' }));
  const zhBody = await zhResponse.json();
  assert.equal(zhResponse.status, 200, JSON.stringify(zhBody));

  const enResponse = await submit(baseUrl, '/api/admin/upload', 'en.md',
    markdown({ title: 'Secret Draft EN', slug: 'twin-post', locale: 'en', translationKey: 'twin-post', status: 'draft', tags: '[tutorial]', body: 'secret english needle' }));
  const enBody = await enResponse.json();
  assert.equal(enResponse.status, 200, JSON.stringify(enBody));
  assert.equal(enBody.article.status, 'draft');

  const db = new Database(path.join(root, 'blog.db'), { readonly: true });
  const enArticle = db.prepare('SELECT id, status FROM articles WHERE locale = ? AND slug = ?').get('en', 'twin-post');
  assert.equal(enArticle.status, 'draft');
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM articles WHERE locale = ? AND status = ?').get('en', 'published').count, 0);
  db.close();

  const api = await (await fetch(`${baseUrl}/api/articles/twin-post`)).json();
  assert.equal(api.title, '公开中文');
  assert.doesNotMatch(JSON.stringify(api), /Secret Draft EN/);

  const pageHtml = await (await fetch(`${baseUrl}/article/twin-post`)).text();
  assert.match(pageHtml, /公开中文/);
  assert.doesNotMatch(pageHtml, /Secret Draft EN/);

  const searchHtml = await (await fetch(`${baseUrl}/search?q=needle`)).text();
  assert.doesNotMatch(searchHtml, /Secret Draft EN/);
  const sitemap = await (await fetch(`${baseUrl}/sitemap.xml`)).text();
  assert.doesNotMatch(sitemap, /Secret Draft EN/);
});

test('replacement keeps id, post_id, locale, slug, and comments and refreshes only its own locale FTS and files', async t => {
  const { root, baseUrl } = await seededHarness(t);
  const zhResponse = await submit(baseUrl, '/api/admin/upload', 'zh.md',
    markdown({ title: 'Original ZH', slug: 'pair-post', locale: 'zh', translationKey: 'pair-post', tags: '[nodejs]', body: 'zh original needle' }));
  const zh = await zhResponse.json();
  assert.equal(zhResponse.status, 200, JSON.stringify(zh));

  const enResponse = await submit(baseUrl, '/api/admin/upload', 'en.md',
    markdown({ title: 'Original EN', slug: 'pair-post', locale: 'en', translationKey: 'pair-post', tags: '[nodejs]', body: 'en original needle' }));
  const en = await enResponse.json();
  assert.equal(enResponse.status, 200, JSON.stringify(en));

  const db = new Database(path.join(root, 'blog.db'));
  const store = createCommentStore(db);
  const commenter = store.upsertIdentity(
    { provider: 'google', subject: 'replace-commenter', displayName: 'Replace Commenter' },
    '2026-07-16T00:00:00.000Z'
  );
  const comment = store.createPendingComment({
    articleId: zh.article.id,
    commenterId: commenter.id,
    content: 'keep this comment',
    createdAt: '2026-07-16T00:01:00.000Z'
  });
  const oldPost = db.prepare('SELECT updated_at FROM posts WHERE id = ?').get(zh.article.postId);

  const replaceResponse = await submit(baseUrl, '/api/admin/upload', 'replace.md',
    markdown({ title: 'Replaced ZH', slug: 'pair-post', locale: 'zh', translationKey: 'pair-post', tags: '[tutorial]', body: 'zh replacement needle' }),
    { replaceId: String(zh.article.id) });
  const replaced = await replaceResponse.json();
  assert.equal(replaceResponse.status, 200, JSON.stringify(replaced));
  assert.equal(replaced.article.id, zh.article.id);
  assert.equal(replaced.article.postId, zh.article.postId);
  assert.equal(replaced.article.locale, 'zh');
  assert.equal(replaced.article.translationKey, 'pair-post');
  assert.equal(replaced.article.replaced, true);

  const post = db.prepare('SELECT updated_at FROM posts WHERE id = ?').get(zh.article.postId);
  assert.ok(post.updated_at >= oldPost.updated_at, 'posts.updated_at must advance on replacement');

  const zhRow = db.prepare('SELECT id, post_id, locale, slug, title FROM articles WHERE id = ?').get(zh.article.id);
  assert.equal(zhRow.post_id, zh.article.postId);
  assert.equal(zhRow.locale, 'zh');
  assert.equal(zhRow.slug, 'pair-post');
  assert.equal(zhRow.title, 'Replaced ZH');
  assert.equal(db.prepare('SELECT id FROM comments WHERE id = ?').get(comment.id).id, comment.id);
  assert.deepEqual(
    db.prepare('SELECT tag_id FROM article_tags WHERE article_id = ? ORDER BY tag_id').all(zh.article.id).map(row => row.tag_id),
    ['tutorial']
  );

  // Only the zh FTS row and files changed; the en sibling is untouched.
  assert.deepEqual(searchArticleIds(db, 'zh', 'replacement'), [zh.article.id]);
  assert.deepEqual(searchArticleIds(db, 'zh', 'original'), []);
  const enRow = db.prepare('SELECT title, content, updated_at FROM articles WHERE id = ?').get(en.article.id);
  assert.equal(enRow.title, 'Original EN');
  assert.match(enRow.content, /en original needle/);
  assert.deepEqual(searchArticleIds(db, 'en', 'original'), [en.article.id]);
  assert.deepEqual(
    db.prepare('SELECT tag_id FROM article_tags WHERE article_id = ? ORDER BY tag_id').all(en.article.id).map(row => row.tag_id),
    ['nodejs']
  );
  const enMarkdown = await fs.readFile(path.join(root, 'articles', 'en', 'pair-post.md'), 'utf8');
  assert.match(enMarkdown, /Original EN/);
  db.close();
});

test('deleting one sibling preserves the other locale, comments, and files and recalculates posts.updated_at', async t => {
  const { root, baseUrl } = await seededHarness(t);
  const zhResponse = await submit(baseUrl, '/api/admin/upload', 'zh.md',
    markdown({ title: '中文版本', slug: 'delete-pair', locale: 'zh', translationKey: 'delete-pair', tags: '[nodejs]' }));
  const zh = await zhResponse.json();
  assert.equal(zhResponse.status, 200, JSON.stringify(zh));
  const enResponse = await submit(baseUrl, '/api/admin/upload', 'en.md',
    markdown({ title: 'English Version', slug: 'delete-pair', locale: 'en', translationKey: 'delete-pair', tags: '[nodejs]' }));
  const en = await enResponse.json();
  assert.equal(enResponse.status, 200, JSON.stringify(en));

  const db = new Database(path.join(root, 'blog.db'));
  const store = createCommentStore(db);
  const commenter = store.upsertIdentity(
    { provider: 'google', subject: 'delete-commenter', displayName: 'Delete Commenter' },
    '2026-07-16T00:00:00.000Z'
  );
  store.createPendingComment({ articleId: zh.article.id, commenterId: commenter.id, content: 'zh comment', createdAt: '2026-07-16T00:01:00.000Z' });
  store.createPendingComment({ articleId: en.article.id, commenterId: commenter.id, content: 'en comment', createdAt: '2026-07-16T00:02:00.000Z' });

  const deleteResponse = await fetch(`${baseUrl}/api/admin/articles/${zh.article.id}`, {
    method: 'DELETE',
    headers: { cookie: cookie() }
  });
  assert.equal(deleteResponse.status, 200, await deleteResponse.text());

  const post = db.prepare('SELECT id, updated_at FROM posts WHERE id = ?').get(zh.article.postId);
  assert.ok(post, 'post must survive while a sibling remains');
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM articles WHERE id = ?').get(zh.article.id).count, 0);
  assert.ok(db.prepare('SELECT id FROM articles WHERE id = ?').get(en.article.id));
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM comments WHERE content = ?').get('zh comment').count, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM comments WHERE content = ?').get('en comment').count, 1);
  const maxSibling = db.prepare('SELECT MAX(updated_at) AS max FROM articles WHERE post_id = ?').get(zh.article.postId).max;
  assert.equal(post.updated_at, maxSibling, 'posts.updated_at must reflect the surviving sibling');
  await assert.rejects(fs.access(path.join(root, 'articles', 'zh', 'delete-pair.md')), { code: 'ENOENT' });
  await assert.doesNotReject(() => fs.access(path.join(root, 'articles', 'en', 'delete-pair.md')));

  // Deleting the final sibling removes the empty post and every file.
  const finalDelete = await fetch(`${baseUrl}/api/admin/articles/${en.article.id}`, {
    method: 'DELETE',
    headers: { cookie: cookie() }
  });
  assert.equal(finalDelete.status, 200, await finalDelete.text());
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM posts WHERE id = ?').get(zh.article.postId).count, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM articles').get().count, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM article_fts').get().count, 0);
  db.close();
  await assert.rejects(fs.access(path.join(root, 'articles', 'en', 'delete-pair.md')), { code: 'ENOENT' });
});

test('injected failures after post, article, tag, and FTS writes roll back the new post and keep the sibling untouched', async t => {
  const { root, baseUrl } = await seededHarness(t);
  const keeperResponse = await submit(baseUrl, '/api/admin/upload', 'keeper.md',
    markdown({ title: 'Keeper', slug: 'keeper-post', tags: '[nodejs]', body: 'keeper needle' }));
  const keeper = await keeperResponse.json();
  assert.equal(keeperResponse.status, 200, JSON.stringify(keeper));

  const injectionCases = [
    {
      name: 'posts-write',
      create: `CREATE TRIGGER injected_post AFTER INSERT ON posts BEGIN SELECT RAISE(ABORT, 'injected'); END;`,
      drop: 'DROP TRIGGER injected_post'
    },
    {
      name: 'article-write',
      create: `CREATE TRIGGER injected_article AFTER INSERT ON articles BEGIN SELECT RAISE(ABORT, 'injected'); END;`,
      drop: 'DROP TRIGGER injected_article'
    },
    {
      name: 'tag-write',
      create: `CREATE TRIGGER injected_tag AFTER INSERT ON article_tags BEGIN SELECT RAISE(ABORT, 'injected'); END;`,
      drop: 'DROP TRIGGER injected_tag'
    },
    {
      name: 'fts-refresh',
      create: `CREATE TRIGGER injected_fts AFTER UPDATE ON posts BEGIN SELECT RAISE(ABORT, 'injected'); END;`,
      drop: 'DROP TRIGGER injected_fts'
    }
  ];

  for (const injection of injectionCases) {
    const db = new Database(path.join(root, 'blog.db'));
    db.exec(injection.create);
    db.close();

    const response = await submit(baseUrl, '/api/admin/upload', 'doomed.md',
      markdown({ title: 'Doomed', slug: 'doomed-post', tags: '[nodejs]', body: 'doomed needle' }));
    const body = await response.json();
    assert.equal(response.status, 500, `${injection.name}: ${JSON.stringify(body)}`);
    assert.equal(response.headers.get('cache-control'), 'no-store', injection.name);
    assert.equal(response.headers.get('expires'), null, injection.name);
    assert.match(response.headers.get('content-type') || '', /application\/json/, injection.name);
    assert.equal(body.code, 'audio_publish_failed', injection.name);

    const verify = new Database(path.join(root, 'blog.db'));
    assert.equal(verify.prepare('SELECT COUNT(*) AS count FROM posts WHERE translation_key = ?').get('doomed-post').count, 0, injection.name);
    assert.equal(verify.prepare('SELECT COUNT(*) AS count FROM articles WHERE slug = ?').get('doomed-post').count, 0, injection.name);
    assert.equal(verify.prepare('SELECT COUNT(*) AS count FROM articles WHERE post_id IN (SELECT id FROM posts WHERE translation_key = ?)').get('doomed-post').count, 0, injection.name);
    assert.equal(verify.prepare('SELECT COUNT(*) AS count FROM article_fts').get().count, 1, injection.name);
    assert.equal(verify.prepare('SELECT title FROM articles WHERE id = ?').get(keeper.article.id).title, 'Keeper', injection.name);
    assert.deepEqual(searchArticleIds(verify, 'zh', 'keeper'), [keeper.article.id], injection.name);
    assert.deepEqual(searchArticleIds(verify, 'zh', 'doomed'), [], injection.name);
    verify.exec(injection.drop);
    verify.close();

    await assert.rejects(fs.access(path.join(root, 'articles', 'zh', 'doomed-post.md')), { code: 'ENOENT' }, injection.name);
  }
});

test('markdown and audio promotion failures leave no post, article, or files and keep the sibling intact', async t => {
  const { root, baseUrl } = await seededHarness(t);
  const mp3 = validMp3();
  const keeperResponse = await submit(baseUrl, '/api/admin/upload', 'keeper.md',
    markdown({ title: 'Keeper', slug: 'keeper-post', tags: '[nodejs]' }));
  const keeper = await keeperResponse.json();
  assert.equal(keeperResponse.status, 200, JSON.stringify(keeper));

  // Markdown promotion fails when the destination exists as a directory.
  await fs.mkdir(path.join(root, 'articles', 'zh', 'doomed-md.md'), { recursive: true });
  const mdResponse = await submit(baseUrl, '/api/admin/upload', 'doomed.md',
    markdown({ title: 'Doomed MD', slug: 'doomed-md', tags: '[nodejs]' }));
  const mdBody = await mdResponse.json();
  assert.equal(mdResponse.status, 500, JSON.stringify(mdBody));
  assert.equal(mdBody.code, 'audio_publish_failed');
  await fs.rm(path.join(root, 'articles', 'zh', 'doomed-md.md'), { recursive: true, force: true });

  // Audio promotion fails when the final audio directory exists as a file.
  await fs.mkdir(path.join(root, 'public', 'audio', 'zh'), { recursive: true });
  await fs.writeFile(path.join(root, 'public', 'audio', 'zh', 'doomed-audio'), 'blocker');
  const audioMarkdown = `---
title: Doomed Audio
slug: doomed-audio
tags: [nodejs]
---

:::audio
title: Doomed
src: ./audio/final.mp3
:::`;
  const audioResponse = await submit(baseUrl, '/api/admin/upload', 'doomed.zip', audioZip('doomed.md', audioMarkdown, mp3));
  const audioBody = await audioResponse.json();
  assert.equal(audioResponse.status, 500, JSON.stringify(audioBody));
  assert.equal(audioBody.code, 'audio_publish_failed');
  await fs.rm(path.join(root, 'public', 'audio', 'zh', 'doomed-audio'), { force: true });

  const db = new Database(path.join(root, 'blog.db'));
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM posts').get().count, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM articles').get().count, 1);
  assert.equal(db.prepare('SELECT title FROM articles WHERE id = ?').get(keeper.article.id).title, 'Keeper');
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM article_fts').get().count, 1);
  db.close();
  await assert.rejects(fs.access(path.join(root, 'articles', 'zh', 'doomed-md.md')), { code: 'ENOENT' });
  await assert.rejects(fs.access(path.join(root, 'articles', 'zh', 'doomed-audio.md')), { code: 'ENOENT' });
});

test('replacement with a changed slug returns 400 and preserves the original row and file', async t => {
  const { root, baseUrl } = await seededHarness(t);
  const uploadedResponse = await submit(baseUrl, '/api/admin/upload', 'orig.md',
    markdown({ title: 'Slug Original', slug: 'slug-original', locale: 'zh', translationKey: 'slug-original', tags: '[nodejs]' }));
  const uploaded = await uploadedResponse.json();
  assert.equal(uploadedResponse.status, 200, JSON.stringify(uploaded));

  const wrongSlugResponse = await submit(baseUrl, '/api/admin/upload', 'wrong.md',
    markdown({ title: 'Wrong Slug', slug: 'slug-changed', locale: 'zh', translationKey: 'slug-original', tags: '[nodejs]' }),
    { replaceId: String(uploaded.article.id) });
  const wrongSlugBody = await wrongSlugResponse.json();
  assert.equal(wrongSlugResponse.status, 400, JSON.stringify(wrongSlugBody));
  assert.equal(wrongSlugBody.code, 'translation_identity_mismatch');
  assert.equal(wrongSlugBody.reason, 'slug');

  const db = new Database(path.join(root, 'blog.db'));
  const article = db.prepare('SELECT slug, title, locale, post_id FROM articles WHERE id = ?').get(uploaded.article.id);
  assert.equal(article.slug, 'slug-original');
  assert.equal(article.title, 'Slug Original');
  assert.equal(article.locale, 'zh');
  assert.equal(article.post_id, uploaded.article.postId);
  db.close();
  const saved = await fs.readFile(path.join(root, 'articles', 'zh', 'slug-original.md'), 'utf8');
  assert.match(saved, /Slug Original/);
  await assert.rejects(fs.access(path.join(root, 'articles', 'zh', 'slug-changed.md')), { code: 'ENOENT' });
});

test('the admin article list exposes locale, translationKey, categories, and tags for both locales', async t => {
  const { baseUrl } = await seededHarness(t);
  const zhResponse = await submit(baseUrl, '/api/admin/upload', 'zh.md',
    markdown({ title: '管理列表中文', slug: 'dual-admin', locale: 'zh', translationKey: 'dual-admin', tags: '[nodejs]' }));
  assert.equal(zhResponse.status, 200, await zhResponse.text());
  const enResponse = await submit(baseUrl, '/api/admin/upload', 'en.md',
    markdown({ title: 'Admin List EN', slug: 'dual-admin', locale: 'en', translationKey: 'dual-admin', tags: '[nodejs]' }));
  assert.equal(enResponse.status, 200, await enResponse.text());

  const response = await fetch(`${baseUrl}/api/admin/articles`, { headers: { cookie: cookie() } });
  const body = await response.json();
  assert.equal(response.status, 200);
  const zh = body.find(article => article.locale === 'zh');
  const en = body.find(article => article.locale === 'en');
  assert.ok(zh && en, JSON.stringify(body));
  assert.equal(zh.translationKey, 'dual-admin');
  assert.equal(en.translationKey, 'dual-admin');
  assert.deepEqual(zh.categories, ['技术']);
  assert.deepEqual(zh.tags, ['Node.js']);
  assert.deepEqual(en.categories, ['Technology']);
  assert.deepEqual(en.tags, ['Node.js']);
});

test('replacement injected failures after article update, tag write, and FTS refresh preserve both siblings', async t => {
  const { root, baseUrl } = await seededHarness(t);
  const mp3 = validMp3();
  const hash = createHash('sha256').update(mp3).digest('hex');

  const zhMarkdown = `---
title: Target ZH
slug: replace-pair
locale: zh
translationKey: replace-pair
tags: [nodejs]
---

zh original needle

:::audio
title: ZH Audio
src: ./audio/final.mp3
:::`;
  const enMarkdown = `---
title: Target EN
slug: replace-pair
locale: en
translationKey: replace-pair
tags: [nodejs]
---

en original needle

:::audio
title: EN Audio
src: ./audio/final.mp3
:::`;

  const [zhResponse, enResponse] = await Promise.all([
    submit(baseUrl, '/api/admin/upload', 'zh.zip', audioZip('zh.md', zhMarkdown, mp3)),
    submit(baseUrl, '/api/admin/upload', 'en.zip', audioZip('en.md', enMarkdown, mp3))
  ]);
  const zh = await zhResponse.json();
  const en = await enResponse.json();
  assert.equal(zhResponse.status, 200, JSON.stringify(zh));
  assert.equal(enResponse.status, 200, JSON.stringify(en));

  const db = new Database(path.join(root, 'blog.db'));
  const store = createCommentStore(db);
  const commenter = store.upsertIdentity(
    { provider: 'google', subject: 'replace-failure-commenter', displayName: 'Replace Failure Commenter' },
    '2026-07-16T00:00:00.000Z'
  );
  store.createPendingComment({ articleId: zh.article.id, commenterId: commenter.id, content: 'zh comment stays', createdAt: '2026-07-16T00:01:00.000Z' });
  store.createPendingComment({ articleId: en.article.id, commenterId: commenter.id, content: 'en comment stays', createdAt: '2026-07-16T00:02:00.000Z' });
  const originalZhUpdatedAt = db.prepare('SELECT updated_at FROM articles WHERE id = ?').get(zh.article.id).updated_at;
  const originalEnUpdatedAt = db.prepare('SELECT updated_at FROM articles WHERE id = ?').get(en.article.id).updated_at;
  const originalPostUpdatedAt = db.prepare('SELECT updated_at FROM posts WHERE id = ?').get(zh.article.postId).updated_at;
  db.close();

  const injectionCases = [
    {
      name: 'article-update',
      create: `CREATE TRIGGER injected_replace_article AFTER UPDATE ON articles BEGIN SELECT RAISE(ABORT, 'injected'); END;`,
      drop: 'DROP TRIGGER injected_replace_article'
    },
    {
      name: 'tag-write',
      create: `CREATE TRIGGER injected_replace_tag AFTER INSERT ON article_tags BEGIN SELECT RAISE(ABORT, 'injected'); END;`,
      drop: 'DROP TRIGGER injected_replace_tag'
    },
    {
      name: 'fts-refresh',
      create: `CREATE TRIGGER injected_replace_fts AFTER UPDATE ON posts BEGIN SELECT RAISE(ABORT, 'injected'); END;`,
      drop: 'DROP TRIGGER injected_replace_fts'
    }
  ];

  for (const injection of injectionCases) {
    const triggerDb = new Database(path.join(root, 'blog.db'));
    triggerDb.exec(injection.create);
    triggerDb.close();

    const response = await submit(baseUrl, '/api/admin/upload', 'replace.md',
      markdown({ title: 'Replaced ZH', slug: 'replace-pair', locale: 'zh', translationKey: 'replace-pair', tags: '[tutorial]', body: 'zh replacement needle' }),
      { replaceId: String(zh.article.id) });
    const body = await response.json();
    assert.equal(response.status, 500, `${injection.name}: ${JSON.stringify(body)}`);
    assert.equal(body.code, 'audio_publish_failed', injection.name);

    const verify = new Database(path.join(root, 'blog.db'));
    // The replaced target row is byte-identical to the original.
    const target = verify.prepare('SELECT id, post_id, locale, slug, title, content, status, updated_at FROM articles WHERE id = ?').get(zh.article.id);
    assert.equal(target.id, zh.article.id, injection.name);
    assert.equal(target.post_id, zh.article.postId, injection.name);
    assert.equal(target.locale, 'zh', injection.name);
    assert.equal(target.slug, 'replace-pair', injection.name);
    assert.equal(target.title, 'Target ZH', injection.name);
    assert.match(target.content, /zh original needle/, injection.name);
    assert.equal(target.updated_at, originalZhUpdatedAt, injection.name);
    assert.deepEqual(
      verify.prepare('SELECT tag_id FROM article_tags WHERE article_id = ? ORDER BY tag_id').all(zh.article.id).map(row => row.tag_id),
      ['nodejs'], injection.name
    );
    assert.deepEqual(searchArticleIds(verify, 'zh', 'original'), [zh.article.id], injection.name);
    assert.deepEqual(searchArticleIds(verify, 'zh', 'replacement'), [], injection.name);
    assert.equal(verify.prepare('SELECT COUNT(*) AS count FROM comments WHERE content = ?').get('zh comment stays').count, 1, injection.name);
    // The unrelated locale sibling is untouched.
    const enRow = verify.prepare('SELECT id, title, content, updated_at FROM articles WHERE id = ?').get(en.article.id);
    assert.equal(enRow.title, 'Target EN', injection.name);
    assert.match(enRow.content, /en original needle/, injection.name);
    assert.equal(enRow.updated_at, originalEnUpdatedAt, injection.name);
    assert.deepEqual(
      verify.prepare('SELECT tag_id FROM article_tags WHERE article_id = ? ORDER BY tag_id').all(en.article.id).map(row => row.tag_id),
      ['nodejs'], injection.name
    );
    assert.deepEqual(searchArticleIds(verify, 'en', 'original'), [en.article.id], injection.name);
    assert.equal(verify.prepare('SELECT COUNT(*) AS count FROM comments WHERE content = ?').get('en comment stays').count, 1, injection.name);
    // The rolled-back transaction leaves posts.updated_at untouched.
    assert.equal(verify.prepare('SELECT updated_at FROM posts WHERE id = ?').get(zh.article.postId).updated_at, originalPostUpdatedAt, injection.name);
    verify.exec(injection.drop);
    verify.close();

    // Files: the old Markdown is restored and both audio directories survive.
    const zhFile = await fs.readFile(path.join(root, 'articles', 'zh', 'replace-pair.md'), 'utf8');
    assert.match(zhFile, /Target ZH/, injection.name);
    const enFile = await fs.readFile(path.join(root, 'articles', 'en', 'replace-pair.md'), 'utf8');
    assert.match(enFile, /Target EN/, injection.name);
    await assert.doesNotReject(() => fs.access(path.join(root, 'public', 'audio', 'zh', 'replace-pair', `${hash}.mp3`)), injection.name);
    await assert.doesNotReject(() => fs.access(path.join(root, 'public', 'audio', 'en', 'replace-pair', `${hash}.mp3`)), injection.name);
    assert.equal(
      (await fs.readdir(path.join(root, 'articles', 'zh'))).some(name => name.startsWith('.replacing-')),
      false,
      injection.name
    );
  }
});

test('localized article service isolates locale, status, and translation siblings', t => {
  const taxonomyPath = writeTaxonomyCatalog(seededCatalog());
  t.after(() => fsSync.rmSync(path.dirname(taxonomyPath), { recursive: true, force: true }));
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  migrateDatabase(db, { taxonomyPath });

  const created = day => new Date(Date.UTC(2026, 0, day)).toISOString();

  // alpha: zh + en published twins sharing normalized tags.
  const alphaZh = insertLocalizedPost(db, {
    translationKey: 'alpha', locale: 'zh', slug: 'alpha', title: '中文甲',
    body: 'alpha zh needle', created: created(1)
  });
  insertLocalizedPost(db, {
    translationKey: 'alpha', locale: 'en', slug: 'alpha', title: 'English Alpha',
    body: 'alpha en needle', created: created(1)
  });
  // beta: zh published, en draft.
  insertLocalizedPost(db, {
    translationKey: 'beta', locale: 'zh', slug: 'beta', title: '中文乙',
    body: 'beta zh needle', created: created(2)
  });
  const betaEn = insertLocalizedPost(db, {
    translationKey: 'beta', locale: 'en', slug: 'beta', title: 'Secret Beta EN', status: 'draft',
    body: 'beta en secret needle', created: created(2)
  });
  // gamma: zh draft, en published.
  insertLocalizedPost(db, {
    translationKey: 'gamma', locale: 'zh', slug: 'gamma', title: 'Secret Gamma ZH', status: 'draft',
    body: 'gamma zh secret needle', created: created(3)
  });
  const gammaEn = insertLocalizedPost(db, {
    translationKey: 'gamma', locale: 'en', slug: 'gamma', title: 'English Gamma',
    body: 'gamma en needle', created: created(3)
  });

  attachTags(db, alphaZh.articleId, ['nodejs', 'tutorial']);
  attachTags(db, betaEn.articleId, ['tutorial']);
  attachTags(db, gammaEn.articleId, ['nodejs']);
  const alphaEnId = db.prepare('SELECT id FROM articles WHERE locale = ? AND slug = ?').get('en', 'alpha').id;
  attachTags(db, alphaEnId, ['nodejs']);
  const betaZhId = db.prepare('SELECT id FROM articles WHERE locale = ? AND slug = ?').get('zh', 'beta').id;
  attachTags(db, betaZhId, ['nodejs']);

  db.transaction(() => rebuildArticleSearchIndex(db))();
  const service = createArticleService(db);

  // Per-locale published lists and totals.
  assert.deepEqual(service.listPublished('zh', 1, 20).articles.map(article => article.slug), ['beta', 'alpha']);
  assert.equal(service.listPublished('zh', 1, 20).total, 2);
  assert.deepEqual(service.listPublished('en', 1, 20).articles.map(article => article.slug), ['gamma', 'alpha']);
  assert.equal(service.listPublished('en', 1, 20).total, 2);

  // Pagination totals stay per locale.
  const zhPageTwo = service.listPublished('zh', 2, 1);
  assert.equal(zhPageTwo.total, 2);
  assert.deepEqual(zhPageTwo.articles.map(article => article.slug), ['alpha']);
  const enPageOne = service.listPublished('en', 1, 1);
  assert.equal(enPageOne.total, 2);
  assert.deepEqual(enPageOne.articles.map(article => article.slug), ['gamma']);

  // Same slugs resolve independently per locale.
  assert.equal(service.getPublishedBySlug('zh', 'alpha').title, '中文甲');
  assert.equal(service.getPublishedBySlug('en', 'alpha').title, 'English Alpha');
  assert.equal(service.getPublishedBySlug('zh', 'beta').title, '中文乙');
  assert.equal(service.getPublishedBySlug('en', 'beta'), null);
  assert.equal(service.getPublishedBySlug('en', 'gamma').title, 'English Gamma');
  assert.equal(service.getPublishedBySlug('zh', 'gamma'), null);

  // Archive and search stay per locale.
  assert.deepEqual(service.listArchive('zh').map(article => article.slug), ['beta', 'alpha']);
  assert.deepEqual(service.listArchive('en').map(article => article.slug), ['gamma', 'alpha']);
  assert.deepEqual(service.search('zh', 'needle').map(article => article.slug), ['beta', 'alpha']);
  assert.deepEqual(service.search('en', 'needle').map(article => article.slug), ['gamma', 'alpha']);
  assert.equal(service.search('en', '秘密').length, 0);
  assert.equal(service.search('zh', 'Secret').length, 0);
  assert.deepEqual(service.search('needle').map(article => article.slug), ['beta', 'alpha']);
  assert.deepEqual(service.search('needle', 1).map(article => article.slug), ['beta']);

  // Navigation never crosses locale.
  const betaNav = service.navigationFor(service.getPublishedBySlug('zh', 'beta'));
  assert.equal(betaNav.previous && betaNav.previous.slug, 'alpha');
  assert.equal(betaNav.next, null);
  const alphaEnNav = service.navigationFor(service.getPublishedBySlug('en', 'alpha'));
  assert.equal(alphaEnNav.previous, null);
  assert.equal(alphaEnNav.next && alphaEnNav.next.slug, 'gamma');

  // Related content ranks within the locale and never includes the sibling.
  assert.deepEqual(
    service.relatedFor(service.getPublishedBySlug('zh', 'alpha'), 10).map(article => article.slug),
    ['beta']
  );
  assert.deepEqual(
    service.relatedFor(service.getPublishedBySlug('en', 'alpha'), 10).map(article => article.slug),
    ['gamma']
  );
  assert.deepEqual(
    service.relatedFor(service.getPublishedBySlug('zh', 'alpha'), 10).map(article => article.locale),
    ['zh']
  );

  // Published alternates only; draft/absent siblings never leak.
  assert.equal(service.alternateFor(service.getPublishedBySlug('zh', 'alpha')).locale, 'en');
  assert.equal(service.alternateFor(service.getPublishedBySlug('en', 'alpha')).locale, 'zh');
  assert.equal(service.alternateFor(service.getPublishedBySlug('zh', 'beta')), null);
  assert.equal(service.alternateFor(service.getPublishedBySlug('en', 'gamma')), null);
  db.close();
});

test('localized taxonomy counts distinct articles and category/tag lookups use localized slugs', t => {
  const taxonomyPath = writeTaxonomyCatalog(seededCatalog());
  t.after(() => fsSync.rmSync(path.dirname(taxonomyPath), { recursive: true, force: true }));
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  migrateDatabase(db, { taxonomyPath });

  // A custom category whose localized slugs differ from its stable id.
  db.prepare("INSERT INTO categories (id, sort_order, origin) VALUES ('guides', 5, 'config')").run();
  db.prepare(`
    INSERT INTO category_labels (category_id, locale, name, slug)
    VALUES ('guides', 'zh', '指南', 'guides-zh'), ('guides', 'en', 'Guides', 'guides-en')
  `).run();
  insertTagLabels(db, { id: 'guide-a', categoryId: 'guides', zhName: '指南甲', zhSlug: 'a-guide', enName: 'Guide A', enSlug: 'guide-a' });
  insertTagLabels(db, { id: 'guide-b', categoryId: 'guides', zhName: '指南乙', zhSlug: 'b-guide', enName: 'Guide B', enSlug: 'guide-b' });

  const created = day => new Date(Date.UTC(2026, 0, day)).toISOString();
  const xZh = insertLocalizedPost(db, { translationKey: 'x', locale: 'zh', slug: 'x', title: 'X', created: created(1) });
  const yZh = insertLocalizedPost(db, { translationKey: 'y', locale: 'zh', slug: 'y', title: 'Y', created: created(2) });
  const zEn = insertLocalizedPost(db, { translationKey: 'z', locale: 'en', slug: 'z', title: 'Z', created: created(3) });
  attachTags(db, xZh.articleId, ['guide-a', 'guide-b']);
  attachTags(db, yZh.articleId, ['guide-a']);
  attachTags(db, zEn.articleId, ['guide-a']);

  const service = createArticleService(db);

  // Category counts use COUNT(DISTINCT articles.id): X has two tags in the
  // same category but counts once.
  const zhTaxonomy = service.listTaxonomy('zh');
  const guides = zhTaxonomy.categories.find(category => category.id === 'guides');
  assert.equal(guides.name, '指南');
  assert.equal(guides.slug, 'guides-zh');
  assert.equal(guides.count, 2);
  assert.equal(zhTaxonomy.tags.find(tag => tag.id === 'guide-a').count, 2);
  assert.equal(zhTaxonomy.tags.find(tag => tag.id === 'guide-b').count, 1);
  assert.equal(zhTaxonomy.tags.find(tag => tag.id === 'guide-a').slug, 'a-guide');

  const enTaxonomy = service.listTaxonomy('en');
  assert.equal(enTaxonomy.categories.find(category => category.id === 'guides').count, 1);
  assert.equal(enTaxonomy.categories.find(category => category.id === 'guides').slug, 'guides-en');

  // Category lookup uses (locale, label.slug), not stable ID or display text.
  assert.deepEqual(service.listByCategory('zh', 'guides-zh').map(article => article.slug), ['y', 'x']);
  assert.equal(service.listByCategory('zh', '指南').length, 0);
  assert.equal(service.listByCategory('zh', 'guides').length, 0);
  assert.deepEqual(service.listByCategory('en', 'guides-en').map(article => article.slug), ['z']);
  assert.equal(service.listByCategory('en', 'guides-zh').length, 0);

  // Tag lookup uses (locale, label.slug), not stable ID or display text.
  assert.deepEqual(service.listByTag('zh', 'a-guide').map(article => article.slug), ['y', 'x']);
  assert.equal(service.listByTag('zh', 'guide-a').length, 0);
  assert.equal(service.listByTag('zh', '指南甲').length, 0);
  assert.deepEqual(service.listByTag('en', 'guide-a').map(article => article.slug), ['z']);
  assert.equal(service.listByTag('en', 'a-guide').length, 0);

  // Batch-loaded taxonomy projection lands on detail and list models.
  const xArticle = service.getPublishedBySlug('zh', 'x');
  assert.deepEqual(xArticle.taxonomy.tags.map(tag => tag.slug).sort(), ['a-guide', 'b-guide']);
  assert.deepEqual(xArticle.taxonomy.categories.map(category => category.id), ['guides']);
  const listItem = service.listPublished('zh', 1, 20).articles.find(article => article.slug === 'x');
  assert.deepEqual(listItem.taxonomy.tags.map(tag => tag.id).sort(), ['guide-a', 'guide-b']);

  // Legacy single-argument zh calls keep their Chinese default.
  assert.equal(service.listByTag('a-guide').length, 2);
  assert.deepEqual(service.listPublished(1, 20).articles.map(article => article.slug), ['y', 'x']);
  db.close();
});

test('localized and legacy article JSON APIs isolate locale, taxonomy, and published alternates', async t => {
  const { baseUrl } = await seededHarness(t);

  const upload = async (name, fields) => {
    const response = await submit(baseUrl, '/api/admin/upload', name, markdown(fields));
    const body = await response.json();
    assert.equal(response.status, 200, JSON.stringify(body));
    return body.article;
  };
  const publish = async (title, slug, locale, tags, extra = {}) => upload(
    `${slug}.md`,
    { title, slug, locale, translationKey: slug, tags: `[${tags.join(', ')}]`, body: `${slug} needle`, ...extra }
  );

  // zh + en published twins.
  await publish('双语中文', 'dual-api', 'zh', ['nodejs', 'tutorial']);
  await publish('Bilingual EN', 'dual-api', 'en', ['nodejs']);
  // Locale-exclusive posts.
  await publish('仅中文', 'zh-only', 'zh', ['other']);
  await publish('English Only', 'en-only', 'en', ['tutorial']);
  // Published zh twin + draft en sibling.
  await publish('公开中文', 'twin-api', 'zh', ['nodejs']);
  await publish('Draft EN Twin', 'twin-api', 'en', ['tutorial'], { status: 'draft' });

  // Lists are locale-isolated.
  const zhList = await (await fetch(`${baseUrl}/api/zh/articles`)).json();
  const zhSlugs = zhList.articles.map(article => article.slug);
  assert.ok(zhSlugs.includes('twin-api') && zhSlugs.includes('zh-only') && zhSlugs.includes('dual-api'));
  assert.ok(!zhSlugs.includes('en-only'), JSON.stringify(zhSlugs));
  assert.ok(zhList.articles.every(article => article.locale === 'zh'));
  assert.ok(zhList.pagination.total === 3);

  const enList = await (await fetch(`${baseUrl}/api/en/articles`)).json();
  const enSlugs = enList.articles.map(article => article.slug);
  assert.ok(!enSlugs.includes('zh-only') && !enSlugs.includes('twin-api'), JSON.stringify(enSlugs));
  assert.ok(enSlugs.includes('dual-api') && enSlugs.includes('en-only'));
  assert.ok(enList.articles.every(article => article.locale === 'en'));
  assert.ok(enList.pagination.total === 2);

  // Localized taxonomy endpoint.
  const zhTaxonomy = await (await fetch(`${baseUrl}/api/zh/articles/taxonomy`)).json();
  const nodejs = zhTaxonomy.tags.find(tag => tag.id === 'nodejs');
  assert.equal(nodejs.name, 'Node.js');
  assert.equal(nodejs.slug, 'Node.js');
  assert.equal(nodejs.count, 2);
  assert.ok(zhTaxonomy.categories.some(category => category.id === 'technology' && category.count === 2));
  const enTaxonomy = await (await fetch(`${baseUrl}/api/en/articles/taxonomy`)).json();
  assert.equal(enTaxonomy.tags.find(tag => tag.id === 'nodejs').name, 'Node.js');
  assert.ok(enTaxonomy.tags.some(tag => tag.id === 'tutorial' && tag.count === 1));

  // Category and tag routes resolve by localized label slugs.
  const categoryResponse = await (await fetch(`${baseUrl}/api/zh/articles/category/${encodeURIComponent('技术')}`)).json();
  assert.deepEqual(categoryResponse.articles.map(article => article.slug).sort(), ['dual-api', 'twin-api']);
  const tagResponse = await (await fetch(`${baseUrl}/api/zh/articles/tag/${encodeURIComponent('Node.js')}`)).json();
  assert.deepEqual(tagResponse.articles.map(article => article.slug).sort(), ['dual-api', 'twin-api']);
  const enTagResponse = await (await fetch(`${baseUrl}/api/en/articles/tag/nodejs`)).json();
  assert.deepEqual(enTagResponse.articles.map(article => article.slug), ['dual-api']);

  // Archive route works under the localized router.
  const archive = await (await fetch(`${baseUrl}/api/zh/articles/archive/all`)).json();
  assert.ok(archive && typeof archive === 'object');
  const archived = Object.values(archive).flatMap(months => Object.values(months).flat());
  assert.ok(archived.length >= 3);

  // Detail carries locale, translationKey, localized taxonomy, and the published alternate.
  const detail = await (await fetch(`${baseUrl}/api/zh/articles/dual-api`)).json();
  assert.equal(detail.locale, 'zh');
  assert.equal(detail.translationKey, 'dual-api');
  assert.equal(detail.title, '双语中文');
  assert.equal(detail.slug, 'dual-api');
  assert.ok(detail.created_at);
  assert.equal(detail.alternate.locale, 'en');
  assert.equal(detail.alternate.slug, 'dual-api');
  assert.equal(detail.alternate.title, 'Bilingual EN');
  assert.deepEqual(detail.taxonomy.categories.map(category => category.id), ['technology']);
  assert.deepEqual(detail.taxonomy.tags.map(tag => tag.id).sort(), ['nodejs', 'tutorial']);

  // A locale-exclusive article has no published alternate.
  const zhOnlyDetail = await (await fetch(`${baseUrl}/api/zh/articles/zh-only`)).json();
  assert.equal(zhOnlyDetail.alternate, null);
  assert.deepEqual(zhOnlyDetail.taxonomy.tags.map(tag => tag.id), ['other']);

  // Draft siblings never leak: the en twin is 404 and the zh detail has no alternate.
  assert.equal((await fetch(`${baseUrl}/api/en/articles/twin-api`)).status, 404);
  const twinZhDetail = await (await fetch(`${baseUrl}/api/zh/articles/twin-api`)).json();
  assert.equal(twinZhDetail.alternate, null);
  assert.doesNotMatch(JSON.stringify(twinZhDetail), /Draft EN Twin/);
  assert.doesNotMatch(JSON.stringify(await (await fetch(`${baseUrl}/api/zh/articles`)).json()), /Draft EN Twin/);

  // Unsupported localized API locales return JSON 404.
  const unsupported = await fetch(`${baseUrl}/api/fr/articles`);
  assert.equal(unsupported.status, 404);
  assert.equal((await unsupported.json()).error, '接口不存在');

  // Dynamic /:slug stays last in the localized router.
  assert.equal((await fetch(`${baseUrl}/api/zh/articles/taxonomy`)).status, 200);
  assert.equal((await fetch(`${baseUrl}/api/zh/articles/archive/all`)).status, 200);
  assert.equal((await fetch(`${baseUrl}/api/zh/articles/missing-slug`)).status, 404);

  // Legacy /api/articles stays Chinese-compatible.
  const legacy = await (await fetch(`${baseUrl}/api/articles/dual-api`)).json();
  assert.equal(legacy.title, '双语中文');
  assert.equal(legacy.locale, 'zh');
  assert.equal(legacy.translationKey, 'dual-api');
  assert.deepEqual(legacy.tags, ['Node.js', '教程']);
  const legacyList = await (await fetch(`${baseUrl}/api/articles`)).json();
  assert.equal(legacyList.pagination.total, 3);
  assert.ok(legacyList.articles.every(article => article.locale === 'zh'));
  const legacyTags = await (await fetch(`${baseUrl}/api/articles/tags/all`)).json();
  assert.ok(Array.isArray(legacyTags));
  assert.ok(legacyTags.some(tag => tag.name === 'Node.js'));
  const legacyTagRoute = await (await fetch(`${baseUrl}/api/articles/tag/Node.js`)).json();
  assert.deepEqual(legacyTagRoute.articles.map(article => article.slug).sort(), ['dual-api', 'twin-api']);
  assert.equal((await fetch(`${baseUrl}/api/articles/en-only`)).status, 404);
});

// ---------------------------------------------------------------------------
// Task 8: public locale routing, legacy redirects, cookies, About, analytics
// ---------------------------------------------------------------------------

test('root negotiation, slash canonicalization, and legacy redirects follow the routing matrix', async t => {
  const { baseUrl } = await seededHarness(t);

  const negotiationCases = [
    { name: 'default zh', headers: {}, location: '/zh/' },
    { name: 'cookie zh', headers: { cookie: 'blog_locale=zh' }, location: '/zh/' },
    { name: 'cookie en', headers: { cookie: 'blog_locale=en' }, location: '/en/' },
    { name: 'accept-language en', headers: { 'accept-language': 'en-US,en;q=0.9' }, location: '/en/' },
    { name: 'unsupported fr header', headers: { 'accept-language': 'fr-FR,fr;q=0.9' }, location: '/zh/' },
    { name: 'page query preserved', path: '/?page=2', headers: { 'accept-language': 'en' }, location: '/en/?page=2' }
  ];
  for (const fixture of negotiationCases) {
    const response = await fetch(`${baseUrl}${fixture.path || '/'}`, {
      redirect: 'manual',
      headers: fixture.headers
    });
    assert.equal(response.status, 302, fixture.name);
    assert.equal(response.headers.get('location'), fixture.location, fixture.name);
    assert.equal(response.headers.get('cache-control'), 'private, no-store', fixture.name);
    assert.match(response.headers.get('vary') || '', /Cookie/, fixture.name);
    assert.match(response.headers.get('vary') || '', /Accept-Language/, fixture.name);
    assert.equal(response.headers.get('set-cookie'), null, 'negotiation must not set the locale cookie');
  }

  const canonicalCases = [
    { path: '/zh', location: '/zh/' },
    { path: '/en', location: '/en/' },
    { path: '/zh?page=2', location: '/zh/?page=2' },
    { path: '/en?q=sqlite%20fts', location: '/en/?q=sqlite%20fts' }
  ];
  for (const fixture of canonicalCases) {
    const response = await fetch(`${baseUrl}${fixture.path}`, { redirect: 'manual' });
    assert.equal(response.status, 308, fixture.path);
    assert.equal(response.headers.get('location'), fixture.location, fixture.path);
  }

  const legacyCases = [
    { path: '/article/example?ref=old', location: '/zh/article/example?ref=old' },
    { path: '/archive?year=2026', location: '/zh/archive?year=2026' },
    { path: '/tags', location: '/zh/tags' },
    { path: '/tag/Node.js?from=old', location: '/zh/tag/Node.js?from=old' },
    { path: '/tag/界面设计?from=old', location: '/zh/tag/ui-zh?from=old' },
    { path: '/tag/design?from=old', location: '/zh/tag/ui-zh?from=old' },
    { path: '/tag/UI设计?from=old', location: '/zh/tag/ui-zh?from=old' },
    { path: '/search?q=sqlite%20fts&mode=all', location: '/zh/search?q=sqlite%20fts&mode=all' },
    { path: '/about', location: '/zh/about' },
    { path: '/feed.xml', location: '/zh/feed.xml' }
  ];
  for (const fixture of legacyCases) {
    const response = await fetch(`${baseUrl}${fixture.path}`, { redirect: 'manual' });
    assert.equal(response.status, 301, fixture.path);
    assert.equal(response.headers.get('location'), fixture.location, fixture.path);
  }

  const unknownTag = await fetch(`${baseUrl}/tag/unknown-tag`, { redirect: 'manual' });
  assert.equal(unknownTag.status, 404, 'unknown legacy tags must 404 instead of opening a redirect');
});

test('localized pages set the one-year blog_locale cookie and never vary by language headers', async t => {
  const { baseUrl } = await seededHarness(t);

  for (const [pathname, locale] of [['/zh/', 'zh'], ['/en/', 'en']]) {
    const response = await fetch(`${baseUrl}${pathname}`, {
      headers: { 'accept-language': locale === 'zh' ? 'en-US,en;q=0.9' : 'zh-CN,zh;q=0.9' }
    });
    assert.equal(response.status, 200, pathname);
    assert.equal(response.headers.get('cache-control'), 'private, no-store', pathname);
    const setCookie = response.headers.get('set-cookie') || '';
    assert.match(setCookie, new RegExp(`blog_locale=${locale}`), pathname);
    assert.match(setCookie, /Max-Age=31536000/, pathname);
    assert.match(setCookie, /HttpOnly/, pathname);
    assert.match(setCookie, /SameSite=Lax/, pathname);
    assert.match(setCookie, /Path=\//, pathname);
    assert.doesNotMatch(setCookie, /Secure/, 'non-production must not set a Secure cookie');
    const vary = response.headers.get('vary');
    assert.equal(vary === null || !/Accept-Language|Cookie/i.test(vary), true,
      `localized page must not vary by language: ${vary}`);
  }
});

test('production locale cookie adds Secure', async t => {
  const root = await createProjectFixture(t);
  const init = runNode(root, 'server/scripts/init-db.js', [], { INITIAL_ADMIN_PASSWORD: INITIAL_PASSWORD });
  assert.equal(init.status, 0, init.stderr);
  const server = await startServer(t, root, {
    NODE_ENV: 'production',
    BLOG_PUBLIC_ORIGIN: 'https://blog.example.test'
  });
  const response = await fetch(`${server.baseUrl}/zh/`);
  assert.equal(response.status, 200);
  const setCookie = response.headers.get('set-cookie') || '';
  assert.match(setCookie, /blog_locale=zh/);
  assert.match(setCookie, /Secure/);
});

test('localized pagination and missing content return localized 404 pages while API errors stay JSON', async t => {
  const { baseUrl } = await seededHarness(t);

  const emptyHome = await fetch(`${baseUrl}/en/`);
  assert.equal(emptyHome.status, 200, 'locale page 1 stays 200 with zero posts');
  assert.equal((await fetch(`${baseUrl}/zh/`)).status, 200, 'zh page 1 stays 200 with zero posts');

  const enOverflow = await fetch(`${baseUrl}/en/?page=99`);
  assert.equal(enOverflow.status, 404);
  assert.match(await enOverflow.text(), /<html lang="en"/);

  const zhOverflow = await fetch(`${baseUrl}/zh/?page=2`);
  assert.equal(zhOverflow.status, 404);
  assert.match(await zhOverflow.text(), /<html lang="zh-CN"/);

  const missingEnglish = await fetch(`${baseUrl}/en/article/chinese-only`);
  assert.equal(missingEnglish.status, 404);
  assert.match(await missingEnglish.text(), /<html lang="en"/);

  const unsupported = await fetch(`${baseUrl}/fr/`);
  assert.equal(unsupported.status, 404);
  const unsupportedBody = await unsupported.text();
  assert.match(unsupportedBody, /<html lang="zh-CN"/);
  assert.doesNotMatch(unsupportedBody, /hljs-keyword/, 'unsupported locale must not reach article routes');
  assert.equal((await fetch(`${baseUrl}/fr/article/chinese-only`)).status, 404);

  const enBadPage = await fetch(`${baseUrl}/en/?page=abc`);
  assert.equal(enBadPage.status, 400);
  assert.match(await enBadPage.text(), /Invalid page format/);

  const zhBadPage = await fetch(`${baseUrl}/zh/?page=abc`);
  assert.equal(zhBadPage.status, 400);
  assert.match(await zhBadPage.text(), /页码格式无效/);

  const api = await fetch(`${baseUrl}/api/fr/articles`);
  assert.equal(api.status, 404);
  assert.deepEqual(await api.json(), { error: '接口不存在' });
});

test('app-level catch-all localized 404s never render dead language-switch targets', async t => {
  const { baseUrl } = await seededHarness(t);

  for (const [pathname, htmlLang, currentLabel] of [
    ['/zh/does-not-exist', 'zh-CN', '中文'],
    ['/en/does-not-exist', 'en', 'English']
  ]) {
    const response = await fetch(`${baseUrl}${pathname}`);
    assert.equal(response.status, 404, pathname);
    const html = await response.text();
    assert.match(html, new RegExp(`<html lang="${htmlLang}"`), pathname);
    assert.match(html, new RegExp(`language-switcher-current[^>]*aria-current="true"[^>]*>${currentLabel}<`), pathname);
    // The only switch anchors point at the always-valid locale roots.
    assert.match(html, /href="\/zh\/"/, pathname);
    assert.match(html, /href="\/en\/"/, pathname);
    // No dead target mirroring the unknown path in the other locale.
    assert.doesNotMatch(html, /href="\/en\/does-not-exist"/, pathname);
    assert.doesNotMatch(html, /href="\/zh\/does-not-exist"/, pathname);
  }

  // Unsupported locales keep their localized 404 without dead switch targets.
  const unsupported = await fetch(`${baseUrl}/fr/whatever`);
  assert.equal(unsupported.status, 404);
  const unsupportedHtml = await unsupported.text();
  assert.match(unsupportedHtml, /<html lang="zh-CN"/);
  assert.doesNotMatch(unsupportedHtml, /href="\/en\/whatever"/);
  assert.doesNotMatch(unsupportedHtml, /href="\/zh\/whatever"/);

  // API 404 behavior stays JSON and untouched.
  const api = await fetch(`${baseUrl}/api/zh/foo`);
  assert.equal(api.status, 404);
  assert.match(api.headers.get('content-type') || '', /application\/json/);
  assert.deepEqual(await api.json(), { error: '接口不存在' });
});

test('static-looking HTML, API, audio, and parser errors are explicitly no-store', async t => {
  const { baseUrl } = await seededHarness(t);

  for (const pathname of [
    '/images/missing-cache-test.webp',
    '/imagesx/missing-cache-test.webp',
    '/missing-cache-test.webp'
  ]) {
    const response = await fetch(`${baseUrl}${pathname}`);
    assert.equal(response.status, 404, pathname);
    assert.match(response.headers.get('content-type') || '', /text\/html/, pathname);
    assert.equal(response.headers.get('cache-control'), 'private, no-store', pathname);
    assert.equal(response.headers.get('expires'), null, pathname);
  }

  for (const pathname of ['/api/missing-cache-test.webp', '/api/articles/missing-cache-test.webp']) {
    const response = await fetch(`${baseUrl}${pathname}`);
    assert.equal(response.status, 404, pathname);
    assert.match(response.headers.get('content-type') || '', /application\/json/, pathname);
    assert.equal(response.headers.get('cache-control'), 'no-store', pathname);
    assert.equal(response.headers.get('expires'), null, pathname);
  }

  const audio = await fetch(`${baseUrl}/audio/missing-cache-test.mp3`);
  assert.equal(audio.status, 404);
  assert.equal(audio.headers.get('cache-control'), 'private, no-store');
  assert.equal(audio.headers.get('expires'), null);

  const htmlParserError = await fetch(`${baseUrl}/missing-cache-test.webp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{'
  });
  assert.equal(htmlParserError.status, 400);
  assert.equal(htmlParserError.headers.get('cache-control'), 'private, no-store');
  assert.equal(htmlParserError.headers.get('expires'), null);

  const apiParserError = await fetch(`${baseUrl}/api/missing-cache-test.webp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{'
  });
  assert.equal(apiParserError.status, 400);
  assert.match(apiParserError.headers.get('content-type') || '', /application\/json/);
  assert.equal(apiParserError.headers.get('cache-control'), 'no-store');
  assert.equal(apiParserError.headers.get('expires'), null);

  const successfulApi = await fetch(`${baseUrl}/api/articles`);
  assert.equal(successfulApi.status, 200);
  assert.equal(successfulApi.headers.get('cache-control'), 'no-store');
});

test('static-looking public HTML 500 responses are private no-store', async t => {
  const { root, baseUrl } = await seededHarness(t);

  // Removing a taxonomy table after startup makes an unknown legacy tag hit
  // the real database failure path before any localized no-store middleware.
  // The .webp suffix also reproduces the extension Cloudflare otherwise treats
  // as cacheable, without adding a production-only test route.
  const db = new Database(path.join(root, 'blog.db'));
  db.pragma('foreign_keys = OFF');
  db.exec('DROP TABLE tag_labels');
  db.close();

  const response = await fetch(`${baseUrl}/tag/missing-cache-test.webp`);
  assert.equal(response.status, 500);
  assert.match(response.headers.get('content-type') || '', /text\/plain/);
  assert.equal(response.headers.get('cache-control'), 'private, no-store');
  assert.equal(response.headers.get('expires'), null);
  assert.equal(await response.text(), '服务器错误');
});

test('unmatched API paths return JSON 404s and never reach the localized HTML router', async t => {
  const { baseUrl } = await seededHarness(t);

  for (const pathname of ['/api', '/api/anything', '/api/zh/foo', '/api/auth/missing']) {
    const response = await fetch(`${baseUrl}${pathname}`);
    assert.equal(response.status, 404, pathname);
    assert.match(response.headers.get('content-type') || '', /application\/json/, pathname);
    assert.deepEqual(await response.json(), { error: '接口不存在' }, pathname);
  }

  // The fallback must not shadow valid APIs.
  const legacy = await (await fetch(`${baseUrl}/api/articles`)).json();
  assert.equal(legacy.pagination.total, 0);
  const localized = await (await fetch(`${baseUrl}/api/zh/articles`)).json();
  assert.ok(Array.isArray(localized.articles));
  const auth = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'wrong-password' })
  });
  assert.equal(auth.status, 401, 'auth API must stay reachable');
  const missingArticle = await fetch(`${baseUrl}/api/articles/nope`);
  assert.equal(missingArticle.status, 404, 'legacy article 404 stays JSON');
  assert.match(missingArticle.headers.get('content-type') || '', /application\/json/);
  assert.deepEqual(await missingArticle.json(), { error: '文章不存在' });
  assert.equal((await fetch(`${baseUrl}/api/admin/articles`)).status, 401, 'admin API stays reachable');

  // HTML unknown paths remain localized HTML 404s, not JSON.
  const unknownHtml = await fetch(`${baseUrl}/fr/`);
  assert.equal(unknownHtml.status, 404);
  assert.match(unknownHtml.headers.get('content-type') || '', /text\/html/);
  assert.match(await unknownHtml.text(), /<html lang="zh-CN"/);
});

test('bilingual About pages render the exact brief content with safe external links', async t => {
  const { baseUrl } = await seededHarness(t);

  const zhAbout = await (await fetch(`${baseUrl}/zh/about`)).text();
  assert.match(zhAbout, /<h1[^>]*>关于我<\/h1>/);
  assert.match(zhAbout, /href="https:\/\/github\.com\/gchigoo" rel="noopener noreferrer"/);
  assert.match(zhAbout, /href="https:\/\/x\.com\/Sugar_Haaaat" rel="noopener noreferrer"/);
  assert.match(zhAbout, /href="https:\/\/cokedaily\.space" rel="noopener noreferrer"/);
  assert.match(zhAbout, /Keep it simple, keep it meaningful\./);
  assert.doesNotMatch(zhAbout, /About Me/);

  const enAbout = await (await fetch(`${baseUrl}/en/about`)).text();
  assert.match(enAbout, /<html lang="en"/);
  assert.match(enAbout, /<h1[^>]*>About Me<\/h1>/);
  assert.match(enAbout, /href="https:\/\/x\.com\/Sugar_Haaaat" rel="noopener noreferrer"/);
  assert.match(enAbout, /href="https:\/\/github\.com\/gchigoo" rel="noopener noreferrer"/);
  assert.match(enAbout, /href="https:\/\/cokedaily\.space" rel="noopener noreferrer"/);
  assert.match(enAbout, /Keep it simple, keep it meaningful\./);
  assert.doesNotMatch(enAbout, /关于我/);

  const legacy = await fetch(`${baseUrl}/about`, { redirect: 'manual' });
  assert.equal(legacy.status, 301);
  assert.equal(legacy.headers.get('location'), '/zh/about');
});

test('admin header links point directly at the Chinese site regardless of the locale cookie', async t => {
  const { baseUrl } = await harness(t);
  const response = await fetch(`${baseUrl}/admin/articles`, {
    headers: { cookie: `${cookie()}; blog_locale=en` }
  });
  const html = await response.text();
  assert.equal(response.status, 200, html);
  assert.match(html, /href="\/zh\/"/);
  assert.match(html, /href="\/zh\/about"/);
  assert.doesNotMatch(html, /href="\/en\//);
});

test('analytics records only completed localized 2xx HTML after negotiation and legacy redirects', async t => {
  const { root, baseUrl } = await seededHarness(t);
  const uploaded = await submit(baseUrl, '/api/admin/upload', 'tracked.md',
    markdown({ title: 'Tracked Target', slug: 'tracked-target', tags: '[other]' }));
  assert.equal(uploaded.status, 200, await uploaded.text());

  const headers = {
    'user-agent': 'Mozilla/5.0',
    accept: 'text/html',
    'x-forwarded-for': '203.0.113.77'
  };
  const rootHop = await fetch(`${baseUrl}/?ref=old`, { redirect: 'manual', headers });
  assert.equal(rootHop.status, 302);
  const legacyHop = await fetch(`${baseUrl}/article/tracked-target?ref=old`, { redirect: 'manual', headers });
  assert.equal(legacyHop.status, 301);
  await fetch(`${baseUrl}/zh/article/tracked-target?ref=old`, { headers });
  await fetch(`${baseUrl}/zh/`, { headers });
  assert.equal((await fetch(`${baseUrl}/en/article/nope`, { headers })).status, 404);

  const db = new Database(path.join(root, 'blog.db'), { readonly: true });
  const paths = db.prepare('SELECT path FROM access_metrics ORDER BY path').all().map(row => row.path);
  assert.deepEqual(paths, ['/zh/', '/zh/article/tracked-target'],
    'redirect hops and 404s must not create metrics');
  db.close();
});

// ---------------------------------------------------------------------------
// Task 9: localized SEO, RSS feeds, and the multilingual sitemap
// ---------------------------------------------------------------------------

test('localized article pages emit self canonicals, published-sibling alternates, and og locale metadata', async t => {
  const { baseUrl } = await seoSeededHarness(t, (db, created) => {
    insertLocalizedPost(db, { translationKey: 'dual-post', locale: 'zh', slug: 'dual-post', title: '双语文章', created: created(1) });
    insertLocalizedPost(db, { translationKey: 'dual-post', locale: 'en', slug: 'dual-post', title: 'Dual Post', created: created(1) });
    insertLocalizedPost(db, { translationKey: 'zh-only-post', locale: 'zh', slug: 'zh-only', title: '仅中文', created: created(2) });
    insertLocalizedPost(db, { translationKey: 'twin-post', locale: 'zh', slug: 'twin-post', title: '公开中文', created: created(3) });
    insertLocalizedPost(db, { translationKey: 'twin-post', locale: 'en', slug: 'twin-post', title: 'Draft Twin EN', status: 'draft', created: created(3) });
  });

  const enHtml = await (await fetch(`${baseUrl}/en/article/dual-post`)).text();
  assert.match(enHtml, /<link rel="canonical" href="https:\/\/blog\.example\.test\/en\/article\/dual-post">/);
  assert.match(enHtml, /<link rel="alternate" hreflang="zh" href="https:\/\/blog\.example\.test\/zh\/article\/dual-post">/);
  assert.match(enHtml, /<link rel="alternate" hreflang="en" href="https:\/\/blog\.example\.test\/en\/article\/dual-post">/);
  assert.match(enHtml, /<link rel="alternate" hreflang="x-default" href="https:\/\/blog\.example\.test\/">/);
  assert.match(enHtml, /<meta property="og:locale" content="en_US">/);
  assert.match(enHtml, /<meta property="og:locale:alternate" content="zh_CN">/);

  const zhHtml = await (await fetch(`${baseUrl}/zh/article/dual-post`)).text();
  assert.match(zhHtml, /<link rel="canonical" href="https:\/\/blog\.example\.test\/zh\/article\/dual-post">/);
  assert.match(zhHtml, /<meta property="og:locale" content="zh_CN">/);
  assert.match(zhHtml, /<meta property="og:locale:alternate" content="en_US">/);

  // A Chinese-only post has no English article alternate and no og alternate.
  const zhOnlyHtml = await (await fetch(`${baseUrl}/zh/article/zh-only`)).text();
  assert.match(zhOnlyHtml, /<link rel="canonical" href="https:\/\/blog\.example\.test\/zh\/article\/zh-only">/);
  assert.match(zhOnlyHtml, /hreflang="zh" href="https:\/\/blog\.example\.test\/zh\/article\/zh-only"/);
  assert.doesNotMatch(zhOnlyHtml, /hreflang="en"/);
  assert.doesNotMatch(zhOnlyHtml, /og:locale:alternate/);

  // Draft siblings never alternate, and the draft English page stays a 404.
  const twinHtml = await (await fetch(`${baseUrl}/zh/article/twin-post`)).text();
  assert.doesNotMatch(twinHtml, /hreflang="en"/);
  assert.equal((await fetch(`${baseUrl}/en/article/twin-post`)).status, 404);
});

test('home pagination emits alternates only where the target locale page exists', async t => {
  const { baseUrl } = await seoSeededHarness(t, (db, created) => {
    // 41 Chinese published posts -> zh totalPages 3; English has none -> 1 page.
    for (let index = 1; index <= 41; index += 1) {
      insertLocalizedPost(db, {
        translationKey: `zh-page-${index}`, locale: 'zh', slug: `zh-page-${index}`,
        title: `中文文章 ${index}`, created: created(index)
      });
    }
  });

  const zhHome = await (await fetch(`${baseUrl}/zh/`)).text();
  assert.match(zhHome, /<link rel="canonical" href="https:\/\/blog\.example\.test\/zh\/">/);
  assert.match(zhHome, /hreflang="zh" href="https:\/\/blog\.example\.test\/zh\/"/);
  assert.match(zhHome, /hreflang="en" href="https:\/\/blog\.example\.test\/en\/"/);

  const enHome = await (await fetch(`${baseUrl}/en/`)).text();
  assert.match(enHome, /hreflang="zh" href="https:\/\/blog\.example\.test\/zh\/"/);

  const zhPage2 = await (await fetch(`${baseUrl}/zh/?page=2`)).text();
  assert.match(zhPage2, /<link rel="canonical" href="https:\/\/blog\.example\.test\/zh\/\?page=2">/);
  assert.match(zhPage2, /hreflang="zh" href="https:\/\/blog\.example\.test\/zh\/\?page=2"/);
  assert.doesNotMatch(zhPage2, /hreflang="en"/);

  const zhPage3 = await (await fetch(`${baseUrl}/zh/?page=3`)).text();
  assert.match(zhPage3, /<link rel="canonical" href="https:\/\/blog\.example\.test\/zh\/\?page=3">/);
  assert.match(zhPage3, /hreflang="x-default" href="https:\/\/blog\.example\.test\/">/);
  assert.doesNotMatch(zhPage3, /hreflang="en"/);

  // Out-of-range locale pages keep the Task 8 localized 404 contract.
  const enOverflow = await fetch(`${baseUrl}/en/?page=3`);
  assert.equal(enOverflow.status, 404);
  assert.match(await enOverflow.text(), /<html lang="en"/);
  const zhOverflow = await fetch(`${baseUrl}/zh/?page=42`);
  assert.equal(zhOverflow.status, 404);
  assert.match(await zhOverflow.text(), /<html lang="zh-CN"/);
});

test('home pagination with a nonzero other locale keeps reciprocal alternates only for shared real pages', async t => {
  const { baseUrl } = await seoSeededHarness(t, (db, created) => {
    // zh: 41 posts -> 3 real pages at pageSize 20; en: 21 posts -> 2 real
    // pages. Page 2 is shared; page 3 exists only in zh.
    for (let index = 1; index <= 41; index += 1) {
      insertLocalizedPost(db, {
        translationKey: `zh-mid-${index}`, locale: 'zh', slug: `zh-mid-${index}`,
        title: `中文文章 ${index}`, created: created(index)
      });
    }
    for (let index = 1; index <= 21; index += 1) {
      insertLocalizedPost(db, {
        translationKey: `en-mid-${index}`, locale: 'en', slug: `en-mid-${index}`,
        title: `English ${index}`, created: created(index + 100)
      });
    }
  });

  // Page 1 is shared: both locales keep reciprocal hreflang alternates.
  const zhHome = await (await fetch(`${baseUrl}/zh/`)).text();
  assert.match(zhHome, /hreflang="zh" href="https:\/\/blog\.example\.test\/zh\/"/);
  assert.match(zhHome, /hreflang="en" href="https:\/\/blog\.example\.test\/en\/"/);
  const enHome = await (await fetch(`${baseUrl}/en/`)).text();
  assert.match(enHome, /hreflang="zh" href="https:\/\/blog\.example\.test\/zh\/"/);
  assert.match(enHome, /hreflang="en" href="https:\/\/blog\.example\.test\/en\/"/);

  // Page 2 is shared (zh 41 posts -> 3 pages, en 21 posts -> 2 pages).
  const zhPage2 = await (await fetch(`${baseUrl}/zh/?page=2`)).text();
  assert.match(zhPage2, /<link rel="canonical" href="https:\/\/blog\.example\.test\/zh\/\?page=2">/);
  assert.match(zhPage2, /hreflang="zh" href="https:\/\/blog\.example\.test\/zh\/\?page=2"/);
  assert.match(zhPage2, /hreflang="en" href="https:\/\/blog\.example\.test\/en\/\?page=2"/);
  const enPage2 = await (await fetch(`${baseUrl}/en/?page=2`)).text();
  assert.match(enPage2, /hreflang="zh" href="https:\/\/blog\.example\.test\/zh\/\?page=2"/);
  assert.match(enPage2, /hreflang="en" href="https:\/\/blog\.example\.test\/en\/\?page=2"/);

  // Page 3 exists only in zh: no dead English alternate/switch target.
  const zhPage3 = await (await fetch(`${baseUrl}/zh/?page=3`)).text();
  assert.match(zhPage3, /<link rel="canonical" href="https:\/\/blog\.example\.test\/zh\/\?page=3">/);
  assert.match(zhPage3, /hreflang="zh" href="https:\/\/blog\.example\.test\/zh\/\?page=3"/);
  assert.doesNotMatch(zhPage3, /hreflang="en"/);
  assert.match(zhPage3, /hreflang="x-default" href="https:\/\/blog\.example\.test\/">/);

  // The corresponding other-locale URL is a localized 404 under the Task 8
  // contract, and zh page 4 is likewise out of range.
  const enPage3 = await fetch(`${baseUrl}/en/?page=3`);
  assert.equal(enPage3.status, 404);
  assert.match(await enPage3.text(), /<html lang="en"/);
  const zhPage4 = await fetch(`${baseUrl}/zh/?page=4`);
  assert.equal(zhPage4.status, 404);
  assert.match(await zhPage4.text(), /<html lang="zh-CN"/);
});

test('static pages always carry zh/en alternates and search stays noindex with a locale-prefixed canonical', async t => {
  const { baseUrl } = await seoSeededHarness(t, (db, created) => {
    insertLocalizedPost(db, { translationKey: 'dual-post', locale: 'zh', slug: 'dual-post', title: '双语', created: created(1) });
    insertLocalizedPost(db, { translationKey: 'dual-post', locale: 'en', slug: 'dual-post', title: 'Dual', created: created(1) });
  });

  for (const [pathname, locale, other] of [
    ['/zh/', 'zh', 'en'],
    ['/en/', 'en', 'zh'],
    ['/zh/archive', 'zh', 'en'],
    ['/en/about', 'en', 'zh'],
    ['/zh/tags', 'zh', 'en']
  ]) {
    const html = await (await fetch(`${baseUrl}${pathname}`)).text();
    assert.match(html, new RegExp(`hreflang="${locale}"`), pathname);
    assert.match(html, new RegExp(`hreflang="${other}"`), pathname);
    assert.match(html, /hreflang="x-default" href="https:\/\/blog\.example\.test\/"/, pathname);
  }

  const enSearch = await (await fetch(`${baseUrl}/en/search?q=node`)).text();
  assert.match(enSearch, /<meta name="robots" content="noindex,follow">/);
  assert.match(enSearch, /<link rel="canonical" href="https:\/\/blog\.example\.test\/en\/search">/);
  assert.match(enSearch, /hreflang="zh" href="https:\/\/blog\.example\.test\/zh\/search"/);
  assert.match(enSearch, /hreflang="en" href="https:\/\/blog\.example\.test\/en\/search"/);
});

test('tag and category pages alternate only to locale endpoints with published articles', async t => {
  const { baseUrl } = await seoSeededHarness(t, (db, created) => {
    const zhNode = insertLocalizedPost(db, { translationKey: 'zh-node-post', locale: 'zh', slug: 'zh-node', title: '中文 Node 文', created: created(1) });
    attachTags(db, zhNode.articleId, ['nodejs']);
    const enNode = insertLocalizedPost(db, { translationKey: 'en-node-post', locale: 'en', slug: 'en-node', title: 'English Node', created: created(2) });
    attachTags(db, enNode.articleId, ['nodejs']);
    // tutorial tag has a zh article only, so the en tutorial endpoint has no published articles.
    const zhTutorial = insertLocalizedPost(db, { translationKey: 'zh-tut-post', locale: 'zh', slug: 'zh-tut', title: '教程文', created: created(3) });
    attachTags(db, zhTutorial.articleId, ['tutorial']);
  });

  // nodejs exists in both locales -> reciprocal alternates.
  const zhNode = await (await fetch(`${baseUrl}/zh/tag/${encodeURIComponent('Node.js')}`)).text();
  assert.match(zhNode, /<link rel="canonical" href="https:\/\/blog\.example\.test\/zh\/tag\/Node\.js">/);
  assert.match(zhNode, /hreflang="zh" href="https:\/\/blog\.example\.test\/zh\/tag\/Node\.js"/);
  assert.match(zhNode, /hreflang="en" href="https:\/\/blog\.example\.test\/en\/tag\/nodejs"/);

  // tutorial has no English published articles -> no English alternate.
  const zhTutorial = await (await fetch(`${baseUrl}/zh/tag/${encodeURIComponent('教程')}`)).text();
  assert.match(zhTutorial, /hreflang="zh"/);
  assert.doesNotMatch(zhTutorial, /hreflang="en"/);

  // Both locale category pages exist because both locales have a published
  // article in the technology category.
  const zhCategoryResponse = await fetch(`${baseUrl}/zh/category/${encodeURIComponent('技术')}`);
  assert.equal(zhCategoryResponse.status, 200);
  const zhCategory = await zhCategoryResponse.text();
  assert.match(zhCategory, /<link rel="canonical" href="https:\/\/blog\.example\.test\/zh\/category\/%E6%8A%80%E6%9C%AF">/);
  assert.match(zhCategory, /hreflang="en" href="https:\/\/blog\.example\.test\/en\/category\/technology"/);
  const enCategoryResponse = await fetch(`${baseUrl}/en/category/technology`);
  assert.equal(enCategoryResponse.status, 200);
  assert.match(await enCategoryResponse.text(), /hreflang="zh"/);

  // The uncategorized category has zero published articles: localized 404.
  assert.equal((await fetch(`${baseUrl}/zh/category/${encodeURIComponent('其他')}`)).status, 404);
});

test('localized RSS feeds isolate locale, language, and prefixed links', async t => {
  const { baseUrl } = await seoSeededHarness(t, (db, created) => {
    insertLocalizedPost(db, { translationKey: 'dual-post', locale: 'zh', slug: 'dual-post', title: '双语文章', created: created(1) });
    insertLocalizedPost(db, { translationKey: 'dual-post', locale: 'en', slug: 'dual-post', title: 'R&D', description: 'English <summary>', created: created(1) });
    insertLocalizedPost(db, { translationKey: 'zh-only-post', locale: 'zh', slug: 'zh-only', title: '仅中文', created: created(2) });
    insertLocalizedPost(db, { translationKey: 'en-only-post', locale: 'en', slug: 'en-only', title: 'English Only', created: created(3) });
  });

  const zhFeed = await (await fetch(`${baseUrl}/zh/feed.xml`)).text();
  assert.match(zhFeed, /<language>zh-CN<\/language>/);
  assert.match(zhFeed, /<title>双语文章<\/title>/);
  assert.match(zhFeed, /<link>https:\/\/blog\.example\.test\/zh\/article\/dual-post<\/link>/);
  assert.doesNotMatch(zhFeed, /English Only/);
  assert.doesNotMatch(zhFeed, /R&D/);

  const enFeed = await (await fetch(`${baseUrl}/en/feed.xml`)).text();
  assert.match(enFeed, /<language>en<\/language>/);
  assert.match(enFeed, /<title>R&amp;D<\/title>/);
  assert.match(enFeed, /<description>English &lt;summary&gt;<\/description>/);
  assert.match(enFeed, /<link>https:\/\/blog\.example\.test\/en\/article\/dual-post<\/link>/);
  assert.doesNotMatch(enFeed, /仅中文/);
  assert.doesNotMatch(enFeed, /zh-only/);
});

test('root sitemap localizes static/article/taxonomy URLs with reciprocal alternates, escaping, and dedupe', async t => {
  const { baseUrl } = await seoSeededHarness(t, (db, created) => {
    insertLocalizedPost(db, { translationKey: 'dual-post', locale: 'zh', slug: 'dual-post', title: '双语', created: created(1) });
    insertLocalizedPost(db, { translationKey: 'dual-post', locale: 'en', slug: 'dual-post', title: 'Dual Post', created: created(1) });
    const zhOnly = insertLocalizedPost(db, { translationKey: 'zh-only-post', locale: 'zh', slug: 'zh-only', title: '仅中文', created: created(2) });
    const enOnly = insertLocalizedPost(db, { translationKey: 'en-only-post', locale: 'en', slug: 'en-only', title: 'English Only', created: created(3) });
    attachTags(db, zhOnly.articleId, ['nodejs']);
    attachTags(db, enOnly.articleId, ['nodejs']);
  });

  const sitemap = await (await fetch(`${baseUrl}/sitemap.xml`)).text();

  // XHTML namespace for hreflang alternates.
  assert.match(sitemap, /xmlns="http:\/\/www\.sitemaps\.org\/schemas\/sitemap\/0\.9"/);
  assert.match(sitemap, /xmlns:xhtml="http:\/\/www\.w3\.org\/1999\/xhtml"/);

  // Both locales' static pages.
  assert.match(sitemap, /<loc>https:\/\/blog\.example\.test\/zh\/<\/loc>/);
  assert.match(sitemap, /<loc>https:\/\/blog\.example\.test\/en\/<\/loc>/);
  assert.match(sitemap, /<loc>https:\/\/blog\.example\.test\/zh\/about<\/loc>/);
  assert.match(sitemap, /<loc>https:\/\/blog\.example\.test\/en\/archive<\/loc>/);

  // Published articles per locale; articles carry lastmod.
  assert.match(sitemap, /<loc>https:\/\/blog\.example\.test\/zh\/article\/dual-post<\/loc>/);
  assert.match(sitemap, /<loc>https:\/\/blog\.example\.test\/en\/article\/dual-post<\/loc>/);
  assert.match(sitemap, /<loc>https:\/\/blog\.example\.test\/zh\/article\/zh-only<\/loc>/);
  assert.match(sitemap, /<lastmod>2026-01-01T00:00:00\.000Z<\/lastmod>/);
  assert.doesNotMatch(sitemap, /\/en\/article\/zh-only</);
  assert.doesNotMatch(sitemap, /\/zh\/article\/en-only</);

  // Tags and categories with published counts.
  assert.match(sitemap, /<loc>https:\/\/blog\.example\.test\/zh\/tag\/Node\.js<\/loc>/);
  assert.match(sitemap, /<loc>https:\/\/blog\.example\.test\/en\/tag\/nodejs<\/loc>/);
  assert.match(sitemap, /<loc>https:\/\/blog\.example\.test\/zh\/category\/%E6%8A%80%E6%9C%AF<\/loc>/);
  assert.match(sitemap, /<loc>https:\/\/blog\.example\.test\/en\/category\/technology<\/loc>/);
  assert.doesNotMatch(sitemap, /\/category\/%E5%85%B6%E4%BB%96</);

  const entryContaining = needle => {
    const index = sitemap.indexOf(`<loc>${needle}</loc>`);
    assert.ok(index !== -1, `sitemap entry missing ${needle}`);
    const entryStart = sitemap.lastIndexOf('<url>', index);
    const entryEnd = sitemap.indexOf('</url>', index);
    assert.ok(entryStart !== -1 && entryEnd !== -1, `malformed sitemap around ${needle}`);
    return sitemap.slice(entryStart, entryEnd + 6);
  };

  // A translated post carries reciprocal zh/en alternates plus x-default.
  const dualEntry = entryContaining('https://blog.example.test/zh/article/dual-post');
  assert.match(dualEntry, /hreflang="zh" href="https:\/\/blog\.example\.test\/zh\/article\/dual-post"/);
  assert.match(dualEntry, /hreflang="en" href="https:\/\/blog\.example\.test\/en\/article\/dual-post"/);
  assert.match(dualEntry, /hreflang="x-default" href="https:\/\/blog\.example\.test\/"/);

  // A locale-exclusive article gets no reciprocal alternate.
  const zhOnlyEntry = entryContaining('https://blog.example.test/zh/article/zh-only');
  assert.match(zhOnlyEntry, /hreflang="zh"/);
  assert.doesNotMatch(zhOnlyEntry, /hreflang="en"/);

  // The tag entry stays reciprocal because both locales have published articles.
  const zhTagEntry = entryContaining('https://blog.example.test/zh/tag/Node.js');
  assert.match(zhTagEntry, /hreflang="en" href="https:\/\/blog\.example\.test\/en\/tag\/nodejs"/);

  // No raw unescaped XML special characters.
  assert.doesNotMatch(sitemap, /&(?!amp;|lt;|gt;|quot;|apos;)/);
  assert.doesNotMatch(sitemap, /<(?!\/?(?:urlset|url|loc|lastmod|xhtml:link)|!DOCTYPE|\?xml)/);

  // Every loc is unique.
  const locs = [...sitemap.matchAll(/<loc>(.*?)<\/loc>/g)].map(match => match[1]);
  assert.ok(locs.length >= 12, `expected a rich sitemap, got ${locs.length} URLs`);
  assert.equal(new Set(locs).size, locs.length);
});

// ---------------------------------------------------------------------------
// Final review I-1: published legacy-origin DB tags absent from the catalog
// ---------------------------------------------------------------------------

test('published legacy-origin DB tags absent from the catalog resolve on localized tag pages, overview, chips, sitemap, and legacy redirects', async t => {
  const root = await createProjectFixture(t);
  // Release-shape fixture: the committed content/taxonomy.json has no fine
  // tags beyond the system `other`, so a migration-created `origin='legacy'`
  // tag seeded into the DB is absent from the catalog by construction.
  const init = runNode(root, 'server/scripts/init-db.js', [], { INITIAL_ADMIN_PASSWORD: INITIAL_PASSWORD });
  assert.equal(init.status, 0, init.stderr);
  const db = new Database(path.join(root, 'blog.db'));
  db.pragma('foreign_keys = ON');
  const legacyTagId = `legacy-${createHash('sha256').update('效率工具').digest('hex').slice(0, 12)}`;
  // allocateLegacyTag shape: legacy tag under the system uncategorized
  // category, both locale labels sharing the deterministic slug.
  db.prepare(`
    INSERT INTO tags (id, category_id, sort_order, origin, is_system)
    VALUES (?, 'uncategorized', 0, 'legacy', 0)
  `).run(legacyTagId);
  db.prepare(`
    INSERT INTO tag_labels (tag_id, locale, name, slug) VALUES (?, 'zh', '效率工具', ?), (?, 'en', '效率工具', ?)
  `).run(legacyTagId, legacyTagId, legacyTagId, legacyTagId);
  const created = day => new Date(Date.UTC(2026, 0, day)).toISOString();
  const zhPost = insertLocalizedPost(db, {
    translationKey: 'legacy-tag-zh', locale: 'zh', slug: 'legacy-tag-zh',
    title: '效率工具中文笔记', created: created(1)
  });
  attachTags(db, zhPost.articleId, [legacyTagId]);
  const enPost = insertLocalizedPost(db, {
    translationKey: 'legacy-tag-en', locale: 'en', slug: 'legacy-tag-en',
    title: 'Efficiency Tool English Notes', created: created(2)
  });
  attachTags(db, enPost.articleId, [legacyTagId]);

  // A zh-only legacy tag: the en endpoint must stay a localized 404 and the
  // zh page must not pair an en alternate that has no published endpoint.
  const zhOnlyTagId = `legacy-${createHash('sha256').update('旧笔记').digest('hex').slice(0, 12)}`;
  db.prepare(`
    INSERT INTO tags (id, category_id, sort_order, origin, is_system)
    VALUES (?, 'uncategorized', 0, 'legacy', 0)
  `).run(zhOnlyTagId);
  db.prepare(`
    INSERT INTO tag_labels (tag_id, locale, name, slug) VALUES (?, 'zh', '旧笔记', ?), (?, 'en', '旧笔记', ?)
  `).run(zhOnlyTagId, zhOnlyTagId, zhOnlyTagId, zhOnlyTagId);
  const zhOnlyPost = insertLocalizedPost(db, {
    translationKey: 'legacy-zhonly', locale: 'zh', slug: 'legacy-zhonly',
    title: '旧笔记归档', created: created(3)
  });
  attachTags(db, zhOnlyPost.articleId, [zhOnlyTagId]);

  // A legacy tag with only a draft article: zero published count must 404.
  const draftTagId = `legacy-${createHash('sha256').update('草稿标签').digest('hex').slice(0, 12)}`;
  db.prepare(`
    INSERT INTO tags (id, category_id, sort_order, origin, is_system)
    VALUES (?, 'uncategorized', 0, 'legacy', 0)
  `).run(draftTagId);
  db.prepare(`
    INSERT INTO tag_labels (tag_id, locale, name, slug) VALUES (?, 'zh', '草稿标签', ?), (?, 'en', '草稿标签', ?)
  `).run(draftTagId, draftTagId, draftTagId, draftTagId);
  const draftPost = insertLocalizedPost(db, {
    translationKey: 'legacy-draft', locale: 'zh', slug: 'legacy-draft',
    title: '未公开草稿', status: 'draft', created: created(4)
  });
  attachTags(db, draftPost.articleId, [draftTagId]);
  db.close();

  const server = await startServer(t, root, {
    JWT_SECRET,
    BLOG_PUBLIC_ORIGIN: 'https://blog.example.test'
  });
  const { baseUrl } = server;

  // 1. Localized stored-slug endpoints resolve and render only that locale's
  //    published articles.
  const zhTag = await (await fetch(`${baseUrl}/zh/tag/${legacyTagId}`)).text();
  assert.match(zhTag, /效率工具中文笔记/);
  assert.doesNotMatch(zhTag, /Efficiency Tool English Notes/);
  const enTag = await (await fetch(`${baseUrl}/en/tag/${legacyTagId}`)).text();
  assert.match(enTag, /Efficiency Tool English Notes/);
  assert.doesNotMatch(enTag, /效率工具中文笔记/);

  // 2. Parent-category breadcrumb comes from the normalized DB category
  //    labels (uncategorized zh = 其他).
  assert.match(zhTag, /href="\/zh\/category\/%E5%85%B6%E4%BB%96"/);
  assert.equal((await fetch(`${baseUrl}/zh/category/${encodeURIComponent('其他')}`)).status, 200);

  // 3. Hreflang/language switch pairs by the stable tag id and only appears
  //    when the other locale has a published endpoint (both do here).
  assert.match(zhTag, /hreflang="en" href="https:\/\/blog\.example\.test\/en\/tag\/legacy-/);
  assert.match(enTag, /hreflang="zh" href="https:\/\/blog\.example\.test\/zh\/tag\/legacy-/);

  // 4. Overview, home chips, and sitemap all point at the 200 endpoint.
  const overview = await (await fetch(`${baseUrl}/zh/tags`)).text();
  assert.match(overview, new RegExp(`/zh/tag/${legacyTagId}`));
  const home = await (await fetch(`${baseUrl}/zh/`)).text();
  assert.match(home, new RegExp(`/zh/tag/${legacyTagId}`));
  const sitemap = await (await fetch(`${baseUrl}/sitemap.xml`)).text();
  assert.match(sitemap, new RegExp(`<loc>https://blog\\.example\\.test/zh/tag/${legacyTagId}</loc>`));
  assert.match(sitemap, new RegExp(`<loc>https://blog\\.example\\.test/en/tag/${legacyTagId}</loc>`));

  // 5. Legacy unprefixed paths 301 to the actual Chinese stored slug with the
  //    raw query preserved (old display name and stored slug both work).
  const byName = await fetch(`${baseUrl}/tag/${encodeURIComponent('效率工具')}?from=old`, { redirect: 'manual' });
  assert.equal(byName.status, 301);
  assert.equal(byName.headers.get('location'), `/zh/tag/${legacyTagId}?from=old`);
  const bySlug = await fetch(`${baseUrl}/tag/${legacyTagId}?from=old`, { redirect: 'manual' });
  assert.equal(bySlug.status, 301);
  assert.equal(bySlug.headers.get('location'), `/zh/tag/${legacyTagId}?from=old`);

  // 6. Unknown and zero-published-count tags stay localized 404.
  assert.equal((await fetch(`${baseUrl}/zh/tag/unknown-tag`)).status, 404);
  assert.equal((await fetch(`${baseUrl}/en/tag/unknown-tag`)).status, 404);
  assert.equal((await fetch(`${baseUrl}/zh/tag/${draftTagId}`)).status, 404);
  assert.equal((await fetch(`${baseUrl}/en/tag/${draftTagId}`)).status, 404);

  // 7. A zh-only legacy tag stays a 200 in zh, renders only its own locale's
  //    articles, offers no en alternate, and the en endpoint is a 404.
  const zhOnly = await (await fetch(`${baseUrl}/zh/tag/${zhOnlyTagId}`)).text();
  assert.match(zhOnly, /旧笔记归档/);
  assert.doesNotMatch(zhOnly, /hreflang="en"/);
  assert.equal((await fetch(`${baseUrl}/en/tag/${zhOnlyTagId}`)).status, 404);
  // The sitemap only emits tags with a published count in that locale.
  assert.doesNotMatch(sitemap, new RegExp(`/en/tag/${zhOnlyTagId}`));
});

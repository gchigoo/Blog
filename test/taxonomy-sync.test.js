'use strict';

const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const test = require('node:test');
const Database = require('better-sqlite3');

const { migrateDatabase } = require('../server/migrations');
const { loadTaxonomyCatalog } = require('../server/taxonomy/catalog');
const { planTaxonomySync, resolveMarkdownTagTokens } = require('../server/taxonomy/store');
const { applyTaxonomySync, recoverTaxonomySync } = require('../server/taxonomy/publication');
const { dbStateHash } = require('../server/operations/journal');
const { searchArticleIds } = require('../server/articles/search-index');
const { parseMarkdownDocument } = require('../server/utils/markdown');

const REPO_ROOT = path.resolve(__dirname, '..');
const CLI = path.join(REPO_ROOT, 'scripts', 'sync-taxonomy.js');
const NODE_PATH = [path.join(REPO_ROOT, 'node_modules'), process.env.NODE_PATH].filter(Boolean).join(path.delimiter);

function sha256(text) {
  return createHash('sha256').update(text).digest('hex');
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

function insertLegacyArticle(db, { title, slug, tags, content = 'body text', status = 'published' }) {
  return db.prepare(`
    INSERT INTO articles (title, slug, content, html, tags, status, created_at, updated_at)
    VALUES (?, ?, ?, '<p>body</p>', ?, ?, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')
  `).run(title, slug, content, JSON.stringify(tags), status).lastInsertRowid;
}

function markdownFile({ title, slug, tags, body = 'body text', extra = {} }) {
  const front = [
    `title: ${title}`,
    `slug: ${slug}`,
    `description: 摘要`
  ];
  if (tags.length > 0) {
    front.push(`tags:\n${tags.map(tag => `  - ${tag}`).join('\n')}`);
  } else {
    front.push('tags: []');
  }
  for (const [key, value] of Object.entries(extra)) {
    front.push(`${key}: ${value}`);
  }
  return `---\n${front.join('\n')}\nstatus: published\ndate: '2026-01-01T00:00:00.000Z'\n---\n\n${body}\n`;
}

function catalogWithCategories({ tagsByCategory = {} } = {}) {
  const categories = [];
  for (const [categoryId, categoryConfig] of Object.entries({
    news: { zh: '新闻', en: 'News', sortOrder: 10 },
    life: { zh: '生活', en: 'Life', sortOrder: 20 },
    technology: { zh: '技术', en: 'Technology', sortOrder: 30 }
  })) {
    categories.push({
      id: categoryId,
      sortOrder: categoryConfig.sortOrder,
      labels: {
        zh: { name: categoryConfig.zh, slug: categoryConfig.zh },
        en: { name: categoryConfig.en, slug: categoryId }
      },
      tags: tagsByCategory[categoryId] || []
    });
  }
  categories.push({
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
  });
  return { version: 1, categories };
}

function baseOldCatalog() {
  return catalogWithCategories({
    tagsByCategory: {
      life: [
        { id: 'music', sortOrder: 10, labels: { zh: { name: '音乐', slug: '音乐' }, en: { name: 'Music', slug: 'music' } }, legacyNames: [] }
      ],
      technology: [
        { id: 'nodejs', sortOrder: 10, labels: { zh: { name: 'Node.js', slug: 'Node.js' }, en: { name: 'Node.js', slug: 'nodejs' } }, legacyNames: ['Node.js'] },
        { id: 'tutorial', sortOrder: 20, labels: { zh: { name: '教程', slug: '教程' }, en: { name: 'Tutorial', slug: 'tutorial' } }, legacyNames: [] },
        { id: 'ai', sortOrder: 30, labels: { zh: { name: 'AI', slug: 'AI' }, en: { name: 'AI', slug: 'ai' } }, legacyNames: ['AI', 'ai'] }
      ]
    }
  });
}

function baseNewCatalog() {
  const catalog = baseOldCatalog();
  // Tutorial display name changes (label-only update).
  catalog.categories.find(category => category.id === 'technology').tags
    .find(tag => tag.id === 'tutorial').labels.zh.name = '教程改';
  // Music moves to its configured parent news.
  const music = catalog.categories.find(category => category.id === 'life').tags
    .find(tag => tag.id === 'music');
  catalog.categories.find(category => category.id === 'life').tags = [];
  catalog.categories.find(category => category.id === 'news').tags = [music];
  // New config tags.
  catalog.categories.find(category => category.id === 'technology').tags.push(
    { id: 'rust', sortOrder: 40, labels: { zh: { name: 'Rust', slug: 'Rust' }, en: { name: 'Rust', slug: 'rust' } }, legacyNames: [] },
    { id: 'typescript', sortOrder: 50, labels: { zh: { name: 'TypeScript', slug: 'TypeScript' }, en: { name: 'TypeScript', slug: 'typescript' } }, legacyNames: ['TypeScript'] }
  );
  return catalog;
}

function buildV3Fixture(t, { oldCatalog, legacyArticles, files }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'taxonomy-sync-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'articles'), { recursive: true });
  fs.mkdirSync(path.join(root, 'uploads', 'temp'), { recursive: true });
  fs.mkdirSync(path.join(root, 'var', 'operations'), { recursive: true });
  const taxonomyPath = path.join(root, 'catalog-old.json');
  fs.writeFileSync(taxonomyPath, JSON.stringify(oldCatalog));
  const dbPath = path.join(root, 'blog.db');
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(legacySchemaSql());
  for (const article of legacyArticles) insertLegacyArticle(db, article);
  migrateDatabase(db, { taxonomyPath });
  for (const file of files) {
    const filePath = path.join(root, 'articles', file.relative);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, file.content);
  }
  const options = {
    articlesDir: path.join(root, 'articles'),
    tempDir: path.join(root, 'uploads', 'temp'),
    operationsDir: path.join(root, 'var', 'operations'),
    rootDir: root
  };
  return { root, db, dbPath, options };
}

function mainFixture(t) {
  const oldCatalog = baseOldCatalog();
  return buildV3Fixture(t, {
    oldCatalog,
    legacyArticles: [
      { title: 'Legacy A', slug: 'legacy-a', tags: ['TypeScript'] },
      { title: 'Config B', slug: 'config-b', tags: ['Node.js'] },
      { title: 'Label C', slug: 'label-c', tags: ['教程'] },
      { title: 'Move D', slug: 'move-d', tags: ['音乐'] },
      { title: 'No Tags E', slug: 'no-tags-e', tags: [] },
      { title: 'Unaffected G', slug: 'unaffected-g', tags: ['Node.js'] }
    ],
    files: [
      { relative: 'legacy-a.md', content: markdownFile({ title: 'Legacy A', slug: 'legacy-a', tags: ['TypeScript'] }) },
      { relative: 'config-b.md', content: markdownFile({ title: 'Config B', slug: 'config-b', tags: ['Node.js'] }) },
      { relative: 'label-c.md', content: markdownFile({ title: 'Label C', slug: 'label-c', tags: ['教程'] }) },
      { relative: 'move-d.md', content: markdownFile({ title: 'Move D', slug: 'move-d', tags: ['音乐'] }) },
      { relative: 'no-tags-e.md', content: markdownFile({ title: 'No Tags E', slug: 'no-tags-e', tags: [] }) },
      { relative: 'unaffected-g.md', content: markdownFile({ title: 'Unaffected G', slug: 'unaffected-g', tags: ['Node.js'] }) }
    ]
  });
}

function writeNewCatalog(root) {
  const catalogPath = path.join(root, 'catalog-new.json');
  fs.writeFileSync(catalogPath, JSON.stringify(baseNewCatalog()));
  return loadTaxonomyCatalog(catalogPath);
}

function loadMutatedCatalog(root, mutate) {
  const catalog = baseNewCatalog();
  mutate(catalog);
  const catalogPath = path.join(root, 'catalog-mutated.json');
  fs.writeFileSync(catalogPath, JSON.stringify(catalog));
  return loadTaxonomyCatalog(catalogPath);
}

function writeCliCatalog(root, catalog) {
  const contentDir = path.join(root, 'content');
  fs.mkdirSync(contentDir, { recursive: true });
  const catalogPath = path.join(contentDir, 'taxonomy.json');
  fs.writeFileSync(catalogPath, JSON.stringify(catalog));
  return catalogPath;
}

function walkFiles(root) {
  const found = [];
  const walk = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) walk(full);
      else found.push(path.relative(root, full));
    }
  };
  walk(root);
  return found.sort();
}

function readFtsRows(db) {
  return db.prepare('SELECT rowid, title, content, taxonomy FROM article_fts ORDER BY rowid')
    .all().map(row => JSON.stringify(row));
}

async function waitFor(predicate, { timeoutMs = 10000, intervalMs = 15 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = predicate();
    if (value) return value;
    if (Date.now() > deadline) throw new Error('waitFor timed out');
    await new Promise(resolve => setTimeout(resolve, intervalMs));
  }
}

function killChild(child) {
  return new Promise(resolve => {
    if (child.exitCode !== null || child.signalCode !== null) return resolve();
    child.once('exit', () => resolve());
    child.kill('SIGKILL');
    setTimeout(() => {
      try { child.kill('SIGKILL'); } catch { /* already gone */ }
      resolve();
    }, 500);
  });
}

function spawnCli(root, args, env = {}) {
  const child = spawn(process.execPath, [CLI, ...args], {
    cwd: root,
    env: {
      ...process.env,
      NODE_PATH,
      SYNC_TAXONOMY_PAUSE_MS: '250',
      ...env
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => { stderr += chunk; });
  return {
    child,
    stdout: () => stdout,
    stderr: () => stderr,
    exit: new Promise((resolve, reject) => {
      child.once('exit', (code, signal) => resolve({ code, signal }));
      child.once('error', reject);
    })
  };
}

async function runCli(root, args, env = {}) {
  const handle = spawnCli(root, args, env);
  const { code } = await handle.exit;
  return { code, stdout: handle.stdout(), stderr: handle.stderr() };
}

function readOperationManifest(root, operationId) {
  if (!operationId) return null;
  const filePath = path.join(root, 'var', 'operations', operationId, 'operation.json');
  return fs.existsSync(filePath) ? JSON.parse(fs.readFileSync(filePath, 'utf8')) : null;
}

function firstOperationId(root) {
  const dir = path.join(root, 'var', 'operations');
  if (!fs.existsSync(dir)) return null;
  return fs.readdirSync(dir).find(name => name !== 'active.lock' && !name.startsWith('stale-')) || null;
}

// ---------------------------------------------------------------------------
// Group 1: dry-run purity, coordinated apply, invariants
// ---------------------------------------------------------------------------

test('taxonomy sync dry-run returns an exact sorted plan and leaves database and files byte-for-byte unchanged', t => {
  const { root, db, dbPath, options } = mainFixture(t);
  const newCatalog = writeNewCatalog(root);
  const beforeFiles = walkFiles(root).filter(name => !name.startsWith('blog.db'));
  const beforeBytes = fs.readFileSync(dbPath);
  const beforeSizes = new Map(beforeFiles.filter(name => !name.startsWith('var')).map(name => {
    const full = path.join(root, name);
    return [name, fs.statSync(full).size];
  }));

  const plan = planTaxonomySync(db, newCatalog, options);
  const planAgain = planTaxonomySync(db, newCatalog, options);
  assert.deepEqual(planAgain, plan);

  assert.deepEqual(plan.conflicts, []);
  assert.deepEqual(plan.blockedSlugChanges, []);
  assert.deepEqual(plan.blockedDeletions, []);
  assert.deepEqual(plan.insertedTags.map(tag => tag.id), ['rust', 'typescript']);
  assert.deepEqual(plan.updatedTags.map(tag => tag.id), ['music', 'tutorial']);
  assert.ok(plan.updatedTags.find(tag => tag.id === 'music').changes.includes('category'));
  assert.ok(plan.updatedTags.find(tag => tag.id === 'tutorial').changes.includes('label:zh'));
  assert.deepEqual(plan.legacyRewires, [
    { legacyTagId: `legacy-${sha256('TypeScript').slice(0, 12)}`, tagId: 'typescript' }
  ]);
  assert.deepEqual(plan.deletedTags.map(tag => tag.id), [`legacy-${sha256('TypeScript').slice(0, 12)}`]);
  assert.deepEqual(plan.markdownRewrites.map(rewrite => rewrite.path), ['label-c.md', 'legacy-a.md']);
  assert.deepEqual(plan.markdownRewrites.find(rewrite => rewrite.path === 'label-c.md').tags, ['tutorial']);
  assert.deepEqual(plan.markdownRewrites.find(rewrite => rewrite.path === 'legacy-a.md').tags, ['typescript']);
  assert.deepEqual(plan.unmappedLegacyTags, []);
  assert.deepEqual(plan.affectedArticleIds, [1, 3, 4]);

  // Dry-run made no writes: files still identical, DB unchanged, no journal artifacts.
  const afterFiles = walkFiles(root).filter(name => !name.startsWith('blog.db'));
  assert.deepEqual(afterFiles, beforeFiles);
  for (const [name, size] of beforeSizes) {
    assert.equal(fs.statSync(path.join(root, name)).size, size, `file changed: ${name}`);
  }
  assert.deepEqual(fs.readFileSync(dbPath), beforeBytes, 'database bytes changed by dry-run');
  assert.deepEqual(fs.readdirSync(options.operationsDir), [], 'dry-run wrote journal artifacts');

  const closed = new Database(dbPath, { readonly: true });
  try {
    assert.equal(dbStateHash(closed), dbStateHash(db), 'database rows changed by dry-run');
  } finally {
    closed.close();
  }
  db.close();
});

test('taxonomy sync apply coordinates catalog, markdown, article_tags, and FTS invariants', t => {
  const { root, db, options } = mainFixture(t);
  const newCatalog = writeNewCatalog(root);
  const beforeFts = readFtsRows(db);
  const dryPlan = planTaxonomySync(db, newCatalog, options);

  const plan = applyTaxonomySync(db, newCatalog, options);

  // Plan returned matches the pure dry-run plan computed before apply.
  assert.deepEqual(plan, dryPlan);
  assert.deepEqual(plan.conflicts, []);
  assert.deepEqual(plan.affectedArticleIds, [1, 3, 4]);

  // Inserted tags carry both locale labels.
  for (const tagId of ['rust', 'typescript']) {
    const labels = db.prepare('SELECT locale, name, slug FROM tag_labels WHERE tag_id = ? ORDER BY locale').all(tagId);
    assert.deepEqual(labels.map(label => label.locale), ['en', 'zh']);
  }
  // Display names updated.
  assert.equal(db.prepare("SELECT name FROM tag_labels WHERE tag_id = 'tutorial' AND locale = 'zh'").get().name, '教程改');
  // Existing localized slugs are immutable.
  assert.equal(db.prepare("SELECT slug FROM tag_labels WHERE tag_id = 'tutorial' AND locale = 'zh'").get().slug, '教程');
  // Tags move only to their configured parent.
  assert.equal(db.prepare("SELECT category_id FROM tags WHERE id = 'music'").get().category_id, 'news');

  // Legacy tag rewired to its reviewed config id and removed once unreferenced.
  const legacyId = `legacy-${sha256('TypeScript').slice(0, 12)}`;
  assert.equal(db.prepare('SELECT 1 FROM tags WHERE id = ?').get(legacyId), undefined);
  assert.deepEqual(
    db.prepare('SELECT tag_id FROM article_tags WHERE article_id = 1 ORDER BY tag_id').all().map(row => row.tag_id),
    ['typescript']
  );

  // Markdown rewritten before article_tags rewiring; body and other front matter unchanged.
  const aContent = fs.readFileSync(path.join(root, 'articles', 'legacy-a.md'), 'utf8');
  assert.match(aContent, /^tags: \["typescript"\]$/m);
  assert.match(aContent, /title: Legacy A/);
  assert.match(aContent, /^body text$/m);
  const cContent = fs.readFileSync(path.join(root, 'articles', 'label-c.md'), 'utf8');
  assert.match(cContent, /^tags: \["tutorial"\]$/m);
  assert.match(cContent, /title: Label C/);

  // Files that need no rewrite are untouched.
  for (const name of ['config-b.md', 'move-d.md', 'no-tags-e.md', 'unaffected-g.md']) {
    const expected = markdownFile(
      name === 'config-b.md' ? { title: 'Config B', slug: 'config-b', tags: ['Node.js'] }
        : name === 'move-d.md' ? { title: 'Move D', slug: 'move-d', tags: ['音乐'] }
          : name === 'no-tags-e.md' ? { title: 'No Tags E', slug: 'no-tags-e', tags: [] }
            : { title: 'Unaffected G', slug: 'unaffected-g', tags: ['Node.js'] }
    );
    assert.equal(fs.readFileSync(path.join(root, 'articles', name), 'utf8'), expected, `unexpected change in ${name}`);
  }

  // Exactly the affected article ids had their FTS rows refreshed.
  const afterFts = readFtsRows(db);
  for (let rowId = 1; rowId <= 6; rowId += 1) {
    if (plan.affectedArticleIds.includes(rowId)) continue;
    assert.equal(afterFts[rowId - 1], beforeFts[rowId - 1], `FTS row ${rowId} changed`);
  }

  // Label-only updates and reparenting replace stale taxonomy text in FTS.
  assert.deepEqual(searchArticleIds(db, 'zh', '教程改'), [3]);
  assert.deepEqual(searchArticleIds(db, 'zh', '新闻'), [4]);
  assert.deepEqual(searchArticleIds(db, 'zh', '教程'), []);
  assert.deepEqual(searchArticleIds(db, 'zh', 'TypeScript'), [1]);

  // Each affected file's normalized tag-ID set equals its article_tags set.
  for (const articleId of plan.affectedArticleIds) {
    const article = db.prepare('SELECT slug, locale FROM articles WHERE id = ?').get(articleId);
    const filePath = path.join(options.articlesDir, `${article.slug}.md`);
    const raw = fs.readFileSync(filePath, 'utf8');
    const { data } = parseMarkdownDocument(raw);
    const resolved = resolveMarkdownTagTokens(db, newCatalog, data.tags || []);
    const dbTags = db.prepare('SELECT tag_id FROM article_tags WHERE article_id = ?').all(articleId).map(row => row.tag_id).sort();
    const fileTags = [...resolved.tagIds].sort();
    if (fileTags.length === 0) {
      assert.deepEqual(dbTags, ['other'], 'empty file tags must equal the system other tag');
    } else {
      assert.deepEqual(fileTags, dbTags, `invariant violated for article ${articleId}`);
    }
  }

  // No journal residue remains after a successful apply.
  assert.deepEqual(fs.readdirSync(options.operationsDir), []);
  db.close();
});

test('taxonomy sync preserves order and removes duplicates created by a rewire', t => {
  const oldCatalog = baseOldCatalog();
  const fixture = buildV3Fixture(t, {
    oldCatalog,
    legacyArticles: [
      { title: 'Dup A', slug: 'dup-a', tags: ['TypeScript', 'TS'] },
      { title: 'Dup B', slug: 'dup-b', tags: ['TS', 'TypeScript'] }
    ],
    files: [
      { relative: 'dup-a.md', content: markdownFile({ title: 'Dup A', slug: 'dup-a', tags: ['TypeScript', 'TS'] }) },
      { relative: 'dup-b.md', content: markdownFile({ title: 'Dup B', slug: 'dup-b', tags: ['TS', 'TypeScript'] }) }
    ]
  });
  const { root, db, options } = fixture;
  const newCatalog = baseNewCatalog();
  newCatalog.categories.find(category => category.id === 'technology').tags
    .find(tag => tag.id === 'typescript').legacyNames = ['TypeScript', 'TS'];
  const catalogPath = path.join(root, 'catalog-new.json');
  fs.writeFileSync(catalogPath, JSON.stringify(newCatalog));
  const catalog = loadTaxonomyCatalog(catalogPath);
  const legacyTypeScript = `legacy-${sha256('TypeScript').slice(0, 12)}`;
  const legacyTs = `legacy-${sha256('TS').slice(0, 12)}`;
  assert.deepEqual(
    db.prepare('SELECT tag_id FROM article_tags WHERE article_id = 1 ORDER BY tag_id').all().map(row => row.tag_id),
    [legacyTs, legacyTypeScript]
  );

  applyTaxonomySync(db, catalog, options);

  // Both aliases rewired to one config tag, deduped, first-occurrence order kept.
  const aContent = fs.readFileSync(path.join(root, 'articles', 'dup-a.md'), 'utf8');
  assert.match(aContent, /^tags: \["typescript"\]$/m);
  assert.match(aContent, /title: Dup A/);
  assert.match(aContent, /^body text$/m);
  const bContent = fs.readFileSync(path.join(root, 'articles', 'dup-b.md'), 'utf8');
  assert.match(bContent, /^tags: \["typescript"\]$/m);
  for (const articleId of [1, 2]) {
    assert.deepEqual(
      db.prepare('SELECT tag_id FROM article_tags WHERE article_id = ?').all(articleId).map(row => row.tag_id),
      ['typescript'],
      `article ${articleId} rewire`
    );
  }
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM tags WHERE id = ?').get(legacyTypeScript).n, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM tags WHERE id = ?').get(legacyTs).n, 0);
  db.close();
});

test('taxonomy sync catalog-only updates never touch Markdown', t => {
  const { root, db, options } = mainFixture(t);
  const newCatalog = loadMutatedCatalog(root, catalog => {
    const tech = catalog.categories.find(category => category.id === 'technology');
    tech.tags.find(tag => tag.id === 'tutorial').labels.zh.name = '教程';
    tech.tags = tech.tags.filter(tag => tag.id !== 'typescript');
    const life = catalog.categories.find(category => category.id === 'life');
    const news = catalog.categories.find(category => category.id === 'news');
    life.tags.push(news.tags.pop());
  });
  const beforeFiles = walkFiles(root).filter(name => !name.startsWith('blog.db'));
  const beforeDb = dbStateHash(db);

  const plan = applyTaxonomySync(db, newCatalog, options);

  assert.deepEqual(plan.affectedArticleIds, []);
  assert.deepEqual(plan.markdownRewrites, []);
  assert.deepEqual(plan.insertedTags.map(tag => tag.id), ['rust']);
  assert.deepEqual(walkFiles(root).filter(name => !name.startsWith('blog.db')), beforeFiles, 'catalog-only apply touched files');
  assert.notEqual(dbStateHash(db), beforeDb, 'catalog-only apply must still insert the new tag');
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM tags WHERE id = 'rust'").get().n, 1);
  assert.deepEqual(fs.readdirSync(options.operationsDir), []);
  db.close();
});

test('taxonomy sync refuses slug changes and referenced/system deletions with no changes', t => {
  // Case 1: an existing tag slug change is blocked.
  {
    const { root, db, options } = mainFixture(t);
    const newCatalog = loadMutatedCatalog(root, catalog => {
      const tech = catalog.categories.find(category => category.id === 'technology');
      tech.tags.find(tag => tag.id === 'nodejs').labels.zh.slug = 'node-js';
    });
    const beforeFiles = walkFiles(root).filter(name => !name.startsWith('blog.db'));
    const plan = planTaxonomySync(db, newCatalog, options);
    assert.deepEqual(plan.blockedSlugChanges.map(entry => `${entry.kind}:${entry.id}`), ['tag:nodejs']);
    assert.throws(() => applyTaxonomySync(db, newCatalog, options), error => error.code === 'plan_blocked');
    assert.deepEqual(fs.readdirSync(options.operationsDir), [], 'lock/manifest created for a blocked plan');
    assert.deepEqual(walkFiles(root).filter(name => !name.startsWith('blog.db')), beforeFiles);
    db.close();
  }
  // Case 2: deleting a referenced config tag is blocked.
  {
    const { root, db, options } = mainFixture(t);
    const newCatalog = loadMutatedCatalog(root, catalog => {
      catalog.categories.find(category => category.id === 'technology').tags =
        catalog.categories.find(category => category.id === 'technology').tags.filter(tag => tag.id !== 'nodejs');
    });
    const plan = planTaxonomySync(db, newCatalog, options);
    assert.deepEqual(plan.blockedDeletions.map(entry => entry.id), ['nodejs']);
    assert.throws(() => applyTaxonomySync(db, newCatalog, options), error => error.code === 'plan_blocked');
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM tags WHERE id = 'nodejs'").get().n, 1);
    assert.deepEqual(fs.readdirSync(options.operationsDir), []);
    db.close();
  }
  // Case 3: the system other tag cannot move out of uncategorized.
  {
    const { root, db, options } = mainFixture(t);
    const newCatalog = writeNewCatalog(root);
    db.prepare("UPDATE tags SET category_id = 'technology' WHERE id = 'other'").run();
    const plan = planTaxonomySync(db, newCatalog, options);
    assert.ok(plan.blockedDeletions.some(entry => entry.kind === 'system-tag'), JSON.stringify(plan.blockedDeletions));
    assert.throws(() => applyTaxonomySync(db, newCatalog, options), error => error.code === 'plan_blocked');
    assert.equal(db.prepare("SELECT category_id FROM tags WHERE id = 'other'").get().category_id, 'technology');
    db.close();
  }
});

test('taxonomy sync removes a migrated legacy tag only after no database or Markdown reference remains', t => {
  const { root, db, options } = mainFixture(t);
  const newCatalog = writeNewCatalog(root);
  const legacyId = `legacy-${sha256('TypeScript').slice(0, 12)}`;
  // Before apply: the legacy tag is referenced and its label is the migrated source text.
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM article_tags WHERE tag_id = ?').get(legacyId).n, 1);
  assert.equal(db.prepare("SELECT name FROM tag_labels WHERE tag_id = ? AND locale = 'zh'").get(legacyId).name, 'TypeScript');

  applyTaxonomySync(db, newCatalog, options);

  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM article_tags WHERE tag_id = ?').get(legacyId).n, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM tags WHERE id = ?').get(legacyId).n, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM tag_labels WHERE tag_id = ?').get(legacyId).n, 0);
  const articleMarkdown = fs.readFileSync(path.join(root, 'articles', 'legacy-a.md'), 'utf8');
  assert.doesNotMatch(articleMarkdown, /TypeScript/);
  db.close();
});

// ---------------------------------------------------------------------------
// Group 2: planning conflicts and refused states
// ---------------------------------------------------------------------------

test('taxonomy sync conflicts on missing markdown archives', t => {
  const { root, db, options } = mainFixture(t);
  const newCatalog = writeNewCatalog(root);
  fs.rmSync(path.join(root, 'articles', 'legacy-a.md'));
  const plan = planTaxonomySync(db, newCatalog, options);
  assert.deepEqual(plan.conflicts.map(conflict => `${conflict.articleId}:${conflict.type}`), ['1:missing-markdown']);
  const beforeFiles = walkFiles(root).filter(name => !name.startsWith('blog.db'));
  assert.throws(() => applyTaxonomySync(db, newCatalog, options), error => error.code === 'plan_blocked');
  assert.deepEqual(fs.readdirSync(options.operationsDir), []);
  assert.deepEqual(walkFiles(root).filter(name => !name.startsWith('blog.db')), beforeFiles);
  db.close();
});

test('taxonomy sync conflicts when both archive layouts are present', t => {
  const { root, db, options } = mainFixture(t);
  const newCatalog = writeNewCatalog(root);
  fs.mkdirSync(path.join(root, 'articles', 'zh'), { recursive: true });
  fs.writeFileSync(
    path.join(root, 'articles', 'zh', 'legacy-a.md'),
    markdownFile({ title: 'Legacy A', slug: 'legacy-a', tags: ['TypeScript'] })
  );
  const plan = planTaxonomySync(db, newCatalog, options);
  assert.deepEqual(plan.conflicts.map(conflict => conflict.type), ['both-layouts-present']);
  assert.throws(() => applyTaxonomySync(db, newCatalog, options), error => error.code === 'plan_blocked');
  assert.deepEqual(fs.readdirSync(options.operationsDir), []);
  db.close();
});

test('taxonomy sync conflicts on unknown and ambiguous file tokens', t => {
  const { root, db, options } = mainFixture(t);
  const newCatalog = writeNewCatalog(root);
  fs.writeFileSync(
    path.join(root, 'articles', 'label-c.md'),
    markdownFile({ title: 'Label C', slug: 'label-c', tags: ['教程', 'MysteryTag'] })
  );
  const plan = planTaxonomySync(db, newCatalog, options);
  assert.deepEqual(plan.conflicts.map(conflict => `${conflict.articleId}:${conflict.type}`), ['3:unknown-token']);
  assert.throws(() => applyTaxonomySync(db, newCatalog, options), error => error.code === 'plan_blocked');
  assert.deepEqual(fs.readdirSync(options.operationsDir), []);
  db.close();
});

test('taxonomy sync conflicts on database/file tag set mismatch', t => {
  const { root, db, options } = mainFixture(t);
  const newCatalog = writeNewCatalog(root);
  fs.writeFileSync(
    path.join(root, 'articles', 'label-c.md'),
    markdownFile({ title: 'Label C', slug: 'label-c', tags: ['教程', '音乐'] })
  );
  const plan = planTaxonomySync(db, newCatalog, options);
  assert.deepEqual(plan.conflicts.map(conflict => `${conflict.articleId}:${conflict.type}`), ['3:db-file-tag-mismatch']);
  assert.throws(() => applyTaxonomySync(db, newCatalog, options), error => error.code === 'plan_blocked');
  assert.deepEqual(fs.readdirSync(options.operationsDir), []);
  db.close();
});

test('taxonomy sync conflicts on unsafe article paths', t => {
  const { root, db, options } = mainFixture(t);
  const newCatalog = writeNewCatalog(root);
  const legacyId = `legacy-${sha256('TypeScript').slice(0, 12)}`;
  const postId = Number(db.prepare("INSERT INTO posts (translation_key, created_at, updated_at) VALUES ('unsafe', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')").run().lastInsertRowid);
  const articleId = Number(db.prepare(`
    INSERT INTO articles (post_id, locale, title, slug, content, html, status, created_at, updated_at)
    VALUES (?, 'zh', 'Unsafe', '../unsafe', 'body', '<p>body</p>', 'published', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')
  `).run(postId).lastInsertRowid);
  db.prepare('INSERT INTO article_tags (article_id, tag_id) VALUES (?, ?)').run(articleId, legacyId);
  const plan = planTaxonomySync(db, newCatalog, options);
  assert.deepEqual(plan.conflicts.map(conflict => `${conflict.articleId}:${conflict.type}`), [`${articleId}:unsafe-path`]);
  assert.throws(() => applyTaxonomySync(db, newCatalog, options), error => error.code === 'plan_blocked');
  assert.deepEqual(fs.readdirSync(options.operationsDir), []);
  db.close();
});

test('taxonomy sync refuses while an incomplete manifest exists without a lock', t => {
  const { root, db, options } = mainFixture(t);
  const newCatalog = writeNewCatalog(root);
  const operationId = 'orphaned-op';
  const opDir = path.join(options.operationsDir, operationId);
  fs.mkdirSync(opDir, { recursive: true });
  fs.writeFileSync(path.join(opDir, 'operation.json'), JSON.stringify({
    schema: 1, operationId, type: 'taxonomy-sync', phase: 'prepared', createdAt: new Date().toISOString(), files: []
  }));
  assert.throws(() => applyTaxonomySync(db, newCatalog, options), error => error.code === 'operation_incomplete');
  assert.deepEqual(fs.readdirSync(options.operationsDir), [operationId]);
  db.close();
});

// ---------------------------------------------------------------------------
// Group 3: compensated failures and stale-state guards
// ---------------------------------------------------------------------------

const compensationCases = [
  { name: 'after stage', injection: { stage: true } },
  { name: 'after tombstoning', injection: { tombstone: true } },
  { name: 'after promotion', injection: { promote: true } },
  { name: 'after tag rewire', injection: { rewire: true } },
  { name: 'after fts refresh', injection: { fts: true } }
];

for (const { name, injection } of compensationCases) {
  test(`taxonomy sync restores files and database after an injected failure ${name}`, t => {
    const { root, db, dbPath, options } = mainFixture(t);
    const newCatalog = writeNewCatalog(root);
    const beforeFiles = walkFiles(root).filter(file => !file.startsWith('blog.db'));
    const beforeBytes = fs.readFileSync(dbPath);
    const beforeDb = dbStateHash(db);

    assert.throws(
      () => applyTaxonomySync(db, newCatalog, { ...options, injectFailures: injection }),
      /injected failure/
    );

    assert.deepEqual(fs.readdirSync(options.operationsDir), [], 'operation residue after compensation');
    assert.deepEqual(walkFiles(root).filter(file => !file.startsWith('blog.db')), beforeFiles, 'file residue after compensation');
    assert.deepEqual(fs.readFileSync(dbPath), beforeBytes, 'database bytes changed');
    assert.equal(dbStateHash(db), beforeDb, 'database rows changed');
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM tags WHERE id = 'typescript'").get().n, 0);
    const orphaned = db.prepare('SELECT COUNT(*) AS n FROM posts WHERE id NOT IN (SELECT post_id FROM articles)').get().n;
    assert.equal(orphaned, 0, 'empty posts remain');
    db.close();
  });
}

test('taxonomy sync compensates when the database drifts before the apply transaction', t => {
  const { root, db, options } = mainFixture(t);
  const newCatalog = writeNewCatalog(root);
  const beforeFiles = walkFiles(root).filter(name => !name.startsWith('blog.db'));
  const hooks = {
    beforeDbTransaction() {
      db.prepare("UPDATE tag_labels SET name = 'drift' WHERE tag_id = 'nodejs' AND locale = 'zh'").run();
    }
  };
  assert.throws(() => applyTaxonomySync(db, newCatalog, { ...options, hooks }), error => error.code === 'stale_state');
  assert.deepEqual(walkFiles(root).filter(name => !name.startsWith('blog.db')), beforeFiles);
  // The external drift persists; only the apply's own changes rolled back.
  assert.equal(db.prepare("SELECT name FROM tag_labels WHERE tag_id = 'nodejs' AND locale = 'zh'").get().name, 'drift');
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM tags WHERE id = 'typescript'").get().n, 0, 'apply changes must roll back');
  assert.deepEqual(fs.readdirSync(options.operationsDir), []);
  db.close();
});

test('taxonomy sync compensates when a source file drifts before its tombstone rename', t => {
  const { root, db, options } = mainFixture(t);
  const newCatalog = writeNewCatalog(root);
  const beforeFiles = walkFiles(root).filter(name => !name.startsWith('blog.db'));
  const beforeDb = dbStateHash(db);
  const hooks = {
    beforeTombstone(file) {
      fs.appendFileSync(path.join(options.articlesDir, file.path), ' drift');
    }
  };
  assert.throws(() => applyTaxonomySync(db, newCatalog, { ...options, hooks }), error => error.code === 'file_hash_mismatch');
  assert.deepEqual(walkFiles(root).filter(name => !name.startsWith('blog.db')), beforeFiles);
  assert.equal(dbStateHash(db), beforeDb);
  assert.deepEqual(fs.readdirSync(options.operationsDir), []);
  db.close();
});

test('taxonomy sync reports a destination collision and compensates', t => {
  const { root, db, options } = mainFixture(t);
  const newCatalog = writeNewCatalog(root);
  const beforeFiles = walkFiles(root).filter(name => !name.startsWith('blog.db'));
  const beforeDb = dbStateHash(db);
  const hooks = {
    afterTombstone(file) {
      fs.writeFileSync(path.join(options.articlesDir, file.path), 'unexpected writer');
    }
  };
  assert.throws(() => applyTaxonomySync(db, newCatalog, { ...options, hooks }), error => error.code === 'destination_collision');
  assert.deepEqual(walkFiles(root).filter(name => !name.startsWith('blog.db')), beforeFiles);
  assert.equal(dbStateHash(db), beforeDb);
  assert.deepEqual(fs.readdirSync(options.operationsDir), []);
  db.close();
});

test('taxonomy sync leaves a recoverable db-committed journal when cleanup fails after commit', t => {
  const { root, db, options } = mainFixture(t);
  const newCatalog = writeNewCatalog(root);
  const hooks = {
    afterCleanup() {
      throw new Error('cleanup exploded');
    }
  };
  assert.throws(() => applyTaxonomySync(db, newCatalog, { ...options, hooks }), error => error.code === 'cleanup_failed');

  // The committed operation stays journaled with lock evidence for recovery.
  const operationId = firstOperationId(root);
  assert.ok(operationId, 'no recoverable operation directory retained');
  assert.equal(readOperationManifest(root, operationId).phase, 'db-committed');
  assert.ok(fs.existsSync(path.join(options.operationsDir, 'active.lock')), 'lock evidence missing');

  // Simulate the apply process having died (recovery always runs from a new
  // process after a crash), then finalize through the stale-lock takeover.
  const ownerPath = path.join(options.operationsDir, 'active.lock', 'owner.json');
  const owner = JSON.parse(fs.readFileSync(ownerPath, 'utf8'));
  fs.writeFileSync(ownerPath, JSON.stringify({ ...owner, pid: 999999999 }));

  // The database is already in post-state; recovery finalizes it.
  const result = recoverTaxonomySync(db, operationId, options);
  assert.equal(result.state, 'post-state-finalized');
  assert.deepEqual(fs.readdirSync(options.operationsDir), []);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM tags WHERE id = 'typescript'").get().n, 1);
  db.close();
});

test('taxonomy sync compensates when a failure lands between tombstone rename and flag persistence', t => {
  const { root, db, options } = mainFixture(t);
  const newCatalog = writeNewCatalog(root);
  const beforeFiles = walkFiles(root).filter(name => !name.startsWith('blog.db'));
  const beforeDb = dbStateHash(db);
  const hooks = {
    afterTombstoneRename() {
      throw new Error('crash after rename');
    }
  };
  assert.throws(() => applyTaxonomySync(db, newCatalog, { ...options, hooks }), /crash after rename/);
  assert.deepEqual(walkFiles(root).filter(name => !name.startsWith('blog.db')), beforeFiles, 'residue after compensation');
  assert.equal(dbStateHash(db), beforeDb, 'database changed');
  assert.deepEqual(fs.readdirSync(options.operationsDir), [], 'journal residue after compensation');
  assert.ok(!fs.existsSync(path.join(options.operationsDir, 'active.lock')));
  db.close();
});

function instrumentFileOps() {
  const events = [];
  const originalOpen = fs.openSync;
  const originalFsync = fs.fsyncSync;
  const originalRename = fs.renameSync;
  const fdPaths = new Map();
  fs.openSync = function openSync(target, ...rest) {
    const descriptor = originalOpen.call(fs, target, ...rest);
    fdPaths.set(descriptor, String(target));
    return descriptor;
  };
  fs.fsyncSync = function fsync(descriptor) {
    events.push(['fsync', fdPaths.get(descriptor) || String(descriptor)]);
    return originalFsync.call(fs, descriptor);
  };
  fs.renameSync = function rename(from, to) {
    events.push(['rename', String(from), String(to)]);
    return originalRename.call(fs, from, to);
  };
  return {
    events,
    restore() {
      fs.openSync = originalOpen;
      fs.fsyncSync = originalFsync;
      fs.renameSync = originalRename;
    }
  };
}

function eventsAfter(events, index, predicate) {
  for (let cursor = index + 1; cursor < events.length; cursor += 1) {
    if (predicate(events[cursor])) return cursor;
  }
  return -1;
}

test('taxonomy sync fsyncs staged files and article directories before advancing manifest flags', t => {
  const { root, db, options } = mainFixture(t);
  const newCatalog = writeNewCatalog(root);
  const instrument = instrumentFileOps();
  try {
    applyTaxonomySync(db, newCatalog, options);
  } finally {
    instrument.restore();
  }
  const { events } = instrument;
  const articlesDir = options.articlesDir;
  const isArticlesDirFsync = event => event[0] === 'fsync' && event[1] === articlesDir;
  const isManifestFsync = event => event[0] === 'fsync' && String(event[1]).includes('operation.json');
  const expectedSources = ['label-c.md', 'legacy-a.md'];

  for (const [index, filename] of expectedSources.entries()) {
    const sourcePath = path.join(articlesDir, filename);
    const stagedPath = events.find(event => event[0] === 'rename' && event[1].endsWith(`${path.sep}files${path.sep}${index}.md`))?.[1];
    assert.ok(stagedPath, `promotion rename recorded for ${filename}`);

    // Staged payload is fsynced before it is promoted.
    const stagedFsync = events.findIndex(event => event[0] === 'fsync' && event[1] === stagedPath);
    const promotion = events.findIndex(event => event[0] === 'rename' && event[1] === stagedPath);
    assert.ok(stagedFsync !== -1 && promotion !== -1, `staged fsync + promotion recorded for ${filename}`);
    assert.ok(stagedFsync < promotion, `staged file fsynced before promotion for ${filename}`);

    // Tombstone rename is followed by an article-directory fsync before any
    // manifest flag fsync.
    const tombstoneRename = events.findIndex(event => event[0] === 'rename' && event[1] === sourcePath);
    assert.ok(tombstoneRename !== -1, `tombstone rename recorded for ${filename}`);
    const dirFsyncAfterTombstone = eventsAfter(events, tombstoneRename, isArticlesDirFsync);
    const manifestFsyncAfterTombstone = eventsAfter(events, tombstoneRename, isManifestFsync);
    assert.ok(dirFsyncAfterTombstone !== -1 && manifestFsyncAfterTombstone !== -1);
    assert.ok(
      dirFsyncAfterTombstone < manifestFsyncAfterTombstone,
      `article directory fsynced after tombstone rename before manifest flag for ${filename}`
    );

    // Promotion rename is followed by an article-directory fsync before any
    // manifest flag fsync.
    const dirFsyncAfterPromotion = eventsAfter(events, promotion, isArticlesDirFsync);
    const manifestFsyncAfterPromotion = eventsAfter(events, promotion, isManifestFsync);
    assert.ok(dirFsyncAfterPromotion !== -1 && manifestFsyncAfterPromotion !== -1);
    assert.ok(
      dirFsyncAfterPromotion < manifestFsyncAfterPromotion,
      `article directory fsynced after promotion before manifest flag for ${filename}`
    );
  }
  db.close();
});

test('taxonomy sync rewrites a rewired legacy tag referenced by its own generated stable id', t => {
  const { root, db, options } = mainFixture(t);
  const newCatalog = writeNewCatalog(root);
  const legacyId = `legacy-${sha256('TypeScript').slice(0, 12)}`;
  fs.writeFileSync(
    path.join(root, 'articles', 'legacy-a.md'),
    markdownFile({ title: 'Legacy A', slug: 'legacy-a', tags: [legacyId] })
  );

  const dryPlan = planTaxonomySync(db, newCatalog, options);
  assert.deepEqual(dryPlan.conflicts, []);
  const legacyRewrite = dryPlan.markdownRewrites.find(rewrite => rewrite.path === 'legacy-a.md');
  assert.ok(legacyRewrite, 'plan must record a markdown rewrite for the legacy article');
  assert.ok(
    legacyRewrite.rewrites.some(rewrite => rewrite.from === legacyId && rewrite.to === 'typescript'),
    'plan must rewrite the generated legacy id to the reviewed config tag'
  );

  applyTaxonomySync(db, newCatalog, options);

  const content = fs.readFileSync(path.join(root, 'articles', 'legacy-a.md'), 'utf8');
  assert.match(content, /^tags: \["typescript"\]$/m);
  assert.deepEqual(
    db.prepare('SELECT tag_id FROM article_tags WHERE article_id = 1').all().map(row => row.tag_id),
    ['typescript']
  );
  const { data } = parseMarkdownDocument(content);
  const resolved = resolveMarkdownTagTokens(db, newCatalog, data.tags || []);
  assert.deepEqual([...resolved.tagIds].sort(), ['typescript'], 'file tag ids must equal article_tags after apply');
  db.close();
});

// ---------------------------------------------------------------------------
// Group 4: lock semantics and recovery
// ---------------------------------------------------------------------------

test('taxonomy sync lock is exclusive and a stale lock blocks apply and dry-run until recovery takes over', async t => {
  const { root, db, options } = mainFixture(t);
  const newCatalog = writeNewCatalog(root);
  writeCliCatalog(root, baseNewCatalog());
  const operationId = 'lock-owner-op';
  fs.mkdirSync(path.join(options.operationsDir, 'active.lock'), { recursive: true });
  fs.writeFileSync(path.join(options.operationsDir, 'active.lock', 'owner.json'), JSON.stringify({
    pid: 999999999, hostname: 'test', operationId, type: 'taxonomy-sync', acquiredAt: new Date().toISOString()
  }));
  fs.mkdirSync(path.join(options.operationsDir, operationId), { recursive: true });
  fs.writeFileSync(path.join(options.operationsDir, operationId, 'operation.json'), JSON.stringify({
    schema: 1, operationId, type: 'taxonomy-sync',
    phase: 'lock-acquired', createdAt: new Date().toISOString(), files: []
  }));

  // Apply and dry-run both refuse while a stale lock exists.
  assert.throws(() => applyTaxonomySync(db, newCatalog, options), error => error.code === 'operation_stale_lock');
  const dryRun = await runCli(root, ['--dry-run']);
  assert.notEqual(dryRun.code, 0);
  assert.match(dryRun.stdout, /stale/);

  // Recovery for an unrelated operation still refuses.
  assert.throws(
    () => recoverTaxonomySync(db, 'some-other-op', options),
    error => error.code === 'operation_stale_lock'
  );

  // Matching recovery takes over the stale lock through the atomic rename.
  const result = recoverTaxonomySync(db, operationId, options);
  assert.equal(result.state, 'pre-state-restored');
  assert.deepEqual(fs.readdirSync(options.operationsDir), []);
  assert.ok(!fs.existsSync(path.join(options.operationsDir, 'active.lock')));
  db.close();
});

test('taxonomy sync recovery refuses ambiguous states and retains the journal as evidence', t => {
  const { db, options } = mainFixture(t);
  const operationId = 'ambiguous-op';
  fs.mkdirSync(path.join(options.operationsDir, operationId), { recursive: true });
  fs.writeFileSync(path.join(options.operationsDir, operationId, 'operation.json'), JSON.stringify({
    schema: 1, operationId, type: 'taxonomy-sync',
    phase: 'files-promoted', createdAt: new Date().toISOString(),
    articlesDir: options.articlesDir,
    stagingRoot: path.join(options.tempDir, 'taxonomy-sync-ambiguous-op'),
    plan: { conflicts: [], affectedArticleIds: [] },
    preDbHash: 'sha256:nonexistent-pre', postDbHash: 'sha256:nonexistent-post',
    files: []
  }));
  assert.throws(() => recoverTaxonomySync(db, operationId, options), error => error.code === 'recovery_ambiguous');
  assert.ok(fs.existsSync(path.join(options.operationsDir, operationId)), 'evidence removed on refusal');
  assert.ok(fs.existsSync(path.join(options.operationsDir, 'active.lock')), 'lock removed on refusal');
  db.close();
});

test('taxonomy sync recovery refuses an unsafe tombstone path in the manifest', t => {
  const { root, db, options } = mainFixture(t);
  const newCatalog = writeNewCatalog(root);
  const plan = planTaxonomySync(db, newCatalog, options);
  const operationId = 'unsafe-tombstone-op';
  fs.mkdirSync(path.join(options.operationsDir, operationId), { recursive: true });
  fs.writeFileSync(path.join(options.operationsDir, operationId, 'operation.json'), JSON.stringify({
    schema: 1, operationId, type: 'taxonomy-sync',
    phase: 'prepared', createdAt: new Date().toISOString(),
    articlesDir: options.articlesDir,
    stagingRoot: path.join(options.tempDir, 'taxonomy-sync-unsafe-tombstone-op'),
    plan: { conflicts: [], affectedArticleIds: [] },
    preDbHash: dbStateHash(db), postDbHash: 'sha256:later',
    files: [{
      path: 'legacy-a.md',
      originalHash: plan.markdownRewrites[0].originalHash,
      stagedHash: plan.markdownRewrites[0].stagedHash,
      stagedPath: 'uploads/temp/x/0.md',
      tombstone: '../../escape.md',
      tombstoned: false, promoted: false
    }]
  }));
  assert.throws(() => recoverTaxonomySync(db, operationId, options), error => error.code === 'invalid_manifest');
  assert.ok(fs.existsSync(path.join(options.operationsDir, operationId)));
  db.close();
});

test('taxonomy sync recovery restores or finalizes child-process kill states deterministically', async t => {
  const killStates = [
    { name: 'after lock acquisition', reached: manifest => manifest && manifest.phase === 'lock-acquired' },
    {
      name: 'after tombstone rename before flag persistence',
      reached: manifest => manifest && manifest.files.length >= 2
        && !manifest.files[0].tombstoned
        && !fs.existsSync(path.join(manifest.articlesDir, manifest.files[0].path))
    },
    {
      name: 'after tombstoning',
      reached: manifest => manifest && manifest.files.length >= 2
        && manifest.files.every(file => file.tombstoned) && manifest.files.some(file => !file.promoted)
    },
    { name: 'after promotion', reached: manifest => manifest && manifest.phase === 'files-promoted' },
    { name: 'after database commit', reached: manifest => manifest && manifest.phase === 'db-committed' }
  ];

  for (const { name, reached } of killStates) {
    const { root, options } = mainFixture(t);
    writeCliCatalog(root, baseNewCatalog());

    const handle = spawnCli(root, []);
    const operationId = await waitFor(() => firstOperationId(root), { timeoutMs: 15000 });
    await waitFor(() => {
      const current = readOperationManifest(root, operationId);
      return reached(current) ? current : null;
    }, { timeoutMs: 15000 });
    await killChild(handle.child);
    await handle.exit;

    // A normal apply refuses while the incomplete journal is present.
    const refused = await runCli(root, []);
    assert.notEqual(refused.code, 0, `normal apply did not refuse after ${name}`);
    assert.match(refused.stdout, /incomplete|stale/i);

    // Recovery deterministically restores pre-state or finalizes post-state.
    const recovered = await runCli(root, ['--recover', operationId]);
    assert.equal(recovered.code, 0, `recovery failed after ${name}: ${recovered.stderr}`);
    const output = JSON.parse(recovered.stdout);
    assert.ok(['pre-state-restored', 'post-state-finalized', 'already-complete'].includes(output.state));

    // Invariants: no journal residue; no lock remains.
    assert.deepEqual(fs.readdirSync(options.operationsDir), []);
    assert.ok(!fs.existsSync(path.join(options.operationsDir, 'active.lock')));

    const fresh = new Database(path.join(root, 'blog.db'));
    try {
      const freshCatalog = loadTaxonomyCatalog(path.join(root, 'content', 'taxonomy.json'));
      const dryPlan = planTaxonomySync(fresh, freshCatalog, options);
      if (output.state === 'pre-state-restored') {
        // The database is unchanged; a fresh apply must now succeed end-to-end.
        applyTaxonomySync(fresh, freshCatalog, options);
        assert.deepEqual(fs.readdirSync(options.operationsDir), []);
      } else {
        // The post-state is committed: every affected file already matches article_tags.
        for (const articleId of dryPlan.affectedArticleIds) {
          const article = fresh.prepare('SELECT slug FROM articles WHERE id = ?').get(articleId);
          const raw = fs.readFileSync(path.join(options.articlesDir, `${article.slug}.md`), 'utf8');
          const { data } = parseMarkdownDocument(raw);
          const resolved = resolveMarkdownTagTokens(fresh, freshCatalog, data.tags || []);
          const dbTags = fresh.prepare('SELECT tag_id FROM article_tags WHERE article_id = ?').all(articleId).map(row => row.tag_id).sort();
          const fileTags = [...resolved.tagIds].sort();
          if (fileTags.length === 0) assert.deepEqual(dbTags, ['other']);
          else assert.deepEqual(fileTags, dbTags);
        }
      }
    } finally {
      fresh.close();
    }
  }
});

test('taxonomy sync parallel processes allow exactly one owner and concurrent dry-run reports the active operation', async t => {
  const { root, options } = mainFixture(t);
  writeCliCatalog(root, baseNewCatalog());

  const first = spawnCli(root, []);
  await waitFor(() => readOperationManifest(root, firstOperationId(root)), { timeoutMs: 15000 });

  // A second apply makes no DB or file changes and reports the live owner.
  const beforeFiles = walkFiles(root).filter(name => !name.startsWith('blog.db'));
  const second = await runCli(root, []);
  assert.notEqual(second.code, 0);
  assert.match(second.stdout, /active|busy/i);
  assert.deepEqual(walkFiles(root).filter(name => !name.startsWith('blog.db')), beforeFiles);

  // A concurrent dry-run performs no writes and reports the active operation.
  const beforeDryFiles = walkFiles(root).filter(name => !name.startsWith('blog.db'));
  const dryRun = await runCli(root, ['--dry-run']);
  assert.notEqual(dryRun.code, 0);
  assert.match(dryRun.stdout, /active operation/i);
  assert.deepEqual(walkFiles(root).filter(name => !name.startsWith('blog.db')), beforeDryFiles);

  // Recovery for the live owner is refused while the owner is alive.
  const operationId = firstOperationId(root);
  const recoveryWhileLive = await runCli(root, ['--recover', operationId]);
  assert.notEqual(recoveryWhileLive.code, 0);
  assert.match(recoveryWhileLive.stdout, /active|busy/i);

  // Kill the owner and recover.
  await killChild(first.child);
  await first.exit;
  const recovered = await runCli(root, ['--recover', operationId]);
  assert.equal(recovered.code, 0, recovered.stderr);
  assert.deepEqual(fs.readdirSync(options.operationsDir), []);
  assert.ok(!fs.existsSync(path.join(options.operationsDir, 'active.lock')));
});

// ---------------------------------------------------------------------------
// Group 5: CLI contract and pre-migration dry-run
// ---------------------------------------------------------------------------

test('taxonomy sync CLI rejects unknown, missing, and mixed flags', async t => {
  const { root } = mainFixture(t);
  for (const args of [
    ['--bogus'],
    ['--recover'],
    ['--recover', 'op', '--dry-run'],
    ['--dry-run', 'extra']
  ]) {
    const result = await runCli(root, args);
    assert.notEqual(result.code, 0, `flags ${args.join(' ')} must be rejected`);
    assert.match(result.stdout, /usage/i);
  }
  const recovery = await runCli(root, ['--recover', 'missing-op-id']);
  assert.equal(recovery.code, 4);
  assert.match(recovery.stdout, /no operation/i);
});

test('taxonomy sync CLI apply prints a JSON plan and leaves no journal residue', async t => {
  const { root, options } = mainFixture(t);
  writeCliCatalog(root, baseNewCatalog());
  const result = await runCli(root, [], { SYNC_TAXONOMY_PAUSE_MS: '0' });
  assert.equal(result.code, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.applied, true);
  assert.ok(/^[a-z0-9-]+$/i.test(output.operationId));
  assert.deepEqual(output.plan.affectedArticleIds, [1, 3, 4]);
  assert.deepEqual(fs.readdirSync(options.operationsDir), []);
});

test('taxonomy sync CLI dry-run supports schema v2 with a preMigration audit and zero writes', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'taxonomy-v2-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'articles'), { recursive: true });
  fs.mkdirSync(path.join(root, 'uploads', 'temp'), { recursive: true });
  fs.mkdirSync(path.join(root, 'var', 'operations'), { recursive: true });
  writeCliCatalog(root, baseOldCatalog());
  const dbPath = path.join(root, 'blog.db');
  const db = new Database(dbPath);
  db.exec(legacySchemaSql());
  insertLegacyArticle(db, { title: 'V2 A', slug: 'v2-a', tags: ['Node.js', 'TypeScript'] });
  db.close();
  const beforeBytes = fs.readFileSync(dbPath);
  const beforeFiles = walkFiles(root).filter(name => !name.startsWith('blog.db'));

  const result = await runCli(root, ['--dry-run']);
  assert.equal(result.code, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.preMigration, true);
  assert.ok(output.schemaVersion < 3);
  assert.deepEqual(
    output.plan.audit.unknownLegacyTags.map(entry => entry.value),
    ['TypeScript']
  );
  assert.deepEqual(
    output.plan.audit.unknownLegacyTags.map(entry => entry.legacyTagId),
    [`legacy-${sha256('TypeScript').slice(0, 12)}`]
  );
  assert.deepEqual(
    output.plan.audit.directMatches.map(entry => entry.value),
    ['Node.js']
  );
  assert.deepEqual(fs.readFileSync(dbPath), beforeBytes, 'v2 dry-run wrote to the database');
  assert.deepEqual(walkFiles(root).filter(name => !name.startsWith('blog.db')), beforeFiles, 'v2 dry-run wrote files');
});

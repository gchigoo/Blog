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
const {
  applyLocalizedContentMigration,
  contentDbStateHash,
  planLocalizedContentMigration,
  recoverLocalizedContentMigration,
  schemaVersion
} = require('../scripts/migrate-localized-content');
const { auditLocalizedContent } = require('../scripts/audit-localized-content');
const { parseMarkdownDocument } = require('../server/utils/markdown');
const { createProjectFixture, runNode, startServer } = require('./helpers/project-fixture');
const { validMp3 } = require('./helpers/article-audio-fixtures');

const REPO_ROOT = path.resolve(__dirname, '..');
const CONTENT_CLI = path.join(REPO_ROOT, 'scripts', 'migrate-localized-content.js');
const AUDIT_CLI = path.join(REPO_ROOT, 'scripts', 'audit-localized-content.js');
const TAXONOMY_CLI = path.join(REPO_ROOT, 'scripts', 'sync-taxonomy.js');
const NODE_PATH = [path.join(REPO_ROOT, 'node_modules'), process.env.NODE_PATH].filter(Boolean).join(path.delimiter);

const JWT_SECRET = 'test-only-jwt-secret-with-at-least-32-characters';

function sha256(text) {
  return createHash('sha256').update(text).digest('hex');
}

function legacySchemaSql() {
  return `
    CREATE TABLE articles (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL, slug TEXT UNIQUE NOT NULL, content TEXT NOT NULL,
      html TEXT NOT NULL, tags TEXT, status TEXT, created_at TEXT, updated_at TEXT,
      description TEXT
    );
  `;
}

function contentCatalog() {
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
          {
            id: 'tutorial',
            sortOrder: 20,
            labels: {
              zh: { name: '教程', slug: '教程' },
              en: { name: 'Tutorial', slug: 'tutorial' }
            },
            legacyNames: []
          }
        ]
      },
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

function mutatedCatalog() {
  const catalog = contentCatalog();
  catalog.categories.find(category => category.id === 'technology').tags.push({
    id: 'rust',
    sortOrder: 30,
    labels: {
      zh: { name: 'Rust', slug: 'Rust' },
      en: { name: 'Rust', slug: 'rust' }
    },
    legacyNames: []
  });
  return catalog;
}

function transitionalMarkdown({ title, slug, tags, body = 'body text', date = '2026-01-01T00:00:00.000Z' }) {
  const tagsBlock = Array.isArray(tags)
    ? `tags:\n${tags.map(tag => `  - ${tag}`).join('\n')}`
    : `tags: ${tags}`;
  return `---\ntitle: ${title}\nslug: ${slug}\ndescription: 摘要\n${tagsBlock}\nstatus: published\ndate: '${date}'\n---\n\n${body}\n`;
}

function legacyAudioHtml({ slug, hash, ext = 'mp3', extra = '' }) {
  return `<figure class="article-audio">\n<audio class="article-audio__control" controls preload="metadata">\n<source src="/audio/${slug}/${hash}.${ext}" type="audio/mpeg">\n</audio>\n<a class="article-audio__fallback" href="/audio/${slug}/${hash}.${ext}">下载</a>\n</figure>${extra}\n`;
}

function localizedAudioHtml({ slug, locale = 'zh', hash, ext = 'mp3' }) {
  return `<figure class="article-audio">\n<audio class="article-audio__control" controls preload="metadata">\n<source src="/audio/${locale}/${slug}/${hash}.${ext}" type="audio/mpeg">\n</audio>\n<a class="article-audio__fallback" href="/audio/${locale}/${slug}/${hash}.${ext}">下载</a>\n</figure>\n`;
}

function exampleArticleData(mp3) {
  const hash = sha256(mp3);
  return {
    title: 'Example Post',
    slug: 'example',
    tags: ['Node.js', 'TypeScript'],
    content: 'body text',
    html: legacyAudioHtml({ slug: 'example', hash }),
    markdown: transitionalMarkdown({ title: 'Example Post', slug: 'example', tags: ['Node.js', 'TypeScript'] }),
    audio: { [`${hash}.mp3`]: mp3 }
  };
}

function insertLegacyArticle(db, {
  title,
  slug,
  tags,
  content = 'body text',
  html,
  status = 'published',
  created = '2026-01-01T00:00:00.000Z',
  description = '摘要'
}) {
  return db.prepare(`
    INSERT INTO articles (title, slug, content, html, tags, status, description, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(title, slug, content, html || '<p>body</p>', JSON.stringify(tags), status, description, created, created).lastInsertRowid;
}

function buildContentFixture(t, { articles }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'content-migrate-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const taxonomyPath = path.join(root, 'content', 'taxonomy.json');
  fs.mkdirSync(path.dirname(taxonomyPath), { recursive: true });
  fs.writeFileSync(taxonomyPath, JSON.stringify(contentCatalog()));
  fs.mkdirSync(path.join(root, 'articles'), { recursive: true });
  fs.mkdirSync(path.join(root, 'public', 'audio'), { recursive: true });
  fs.mkdirSync(path.join(root, 'uploads', 'temp'), { recursive: true });
  fs.mkdirSync(path.join(root, 'var', 'operations'), { recursive: true });
  const dbPath = path.join(root, 'blog.db');
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(legacySchemaSql());
  db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)');
  db.prepare('INSERT OR IGNORE INTO schema_migrations (version, applied_at) VALUES (?, ?)').run(1, '2026-01-01T00:00:00.000Z');
  db.prepare('INSERT OR IGNORE INTO schema_migrations (version, applied_at) VALUES (?, ?)').run(2, '2026-01-01T00:00:00.000Z');
  for (const article of articles) {
    insertLegacyArticle(db, article);
    if (article.markdown) {
      fs.writeFileSync(path.join(root, 'articles', `${article.slug}.md`), article.markdown);
    }
    if (article.audio) {
      const directory = path.join(root, 'public', 'audio', article.slug);
      fs.mkdirSync(directory, { recursive: true });
      for (const [fileName, bytes] of Object.entries(article.audio)) {
        fs.writeFileSync(path.join(directory, fileName), bytes);
      }
    }
  }
  const options = {
    articlesDir: path.join(root, 'articles'),
    audioDir: path.join(root, 'public', 'audio'),
    tempDir: path.join(root, 'uploads', 'temp'),
    operationsDir: path.join(root, 'var', 'operations'),
    rootDir: root,
    taxonomyPath
  };
  return { root, db, dbPath, options, taxonomyPath };
}

function buildV3Fixture(t, { articles, catalog = null }) {
  const fixture = buildContentFixture(t, { articles });
  if (catalog) {
    fs.writeFileSync(fixture.taxonomyPath, JSON.stringify(catalog));
  }
  migrateDatabase(fixture.db, { taxonomyPath: fixture.taxonomyPath });
  return fixture;
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

function spawnCli(script, root, args, env = {}) {
  const child = spawn(process.execPath, [script, ...args], {
    cwd: root,
    env: {
      ...process.env,
      NODE_PATH,
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

function spawnContentCli(root, args, env = {}) {
  return spawnCli(CONTENT_CLI, root, args, { MIGRATE_CONTENT_PAUSE_MS: '250', ...env });
}

function spawnTaxonomyCli(root, args, env = {}) {
  return spawnCli(TAXONOMY_CLI, root, args, { SYNC_TAXONOMY_PAUSE_MS: '250', ...env });
}

async function runCli(script, root, args, env = {}) {
  const handle = spawnCli(script, root, args, env);
  const { code } = await handle.exit;
  return { code, stdout: handle.stdout(), stderr: handle.stderr() };
}

function runContentCli(root, args, env = {}) {
  return runCli(CONTENT_CLI, root, args, { MIGRATE_CONTENT_PAUSE_MS: '0', ...env });
}

function runTaxonomyCli(root, args, env = {}) {
  return runCli(TAXONOMY_CLI, root, args, { SYNC_TAXONOMY_PAUSE_MS: '0', ...env });
}

function writeCliCatalog(root, catalog) {
  const contentDir = path.join(root, 'content');
  fs.mkdirSync(contentDir, { recursive: true });
  fs.writeFileSync(path.join(contentDir, 'taxonomy.json'), JSON.stringify(catalog));
}

// ---------------------------------------------------------------------------
// Group 1: read-only dry-run identity across schema v2 and schema v3
// ---------------------------------------------------------------------------

test('content migration dry-run is identical across schema v2 and schema v3 and never writes', t => {
  const mp3 = validMp3();
  const article = exampleArticleData(mp3);
  const v2 = buildContentFixture(t, { articles: [article] });
  const v3 = buildV3Fixture(t, { articles: [article] });

  const beforeV2Files = walkFiles(v2.root).filter(name => !name.startsWith('blog.db'));
  const beforeV2Bytes = fs.readFileSync(v2.dbPath);
  const planV2 = planLocalizedContentMigration(v2.db, v2.options);
  assert.deepEqual(walkFiles(v2.root).filter(name => !name.startsWith('blog.db')), beforeV2Files, 'v2 dry-run wrote files');
  assert.deepEqual(fs.readFileSync(v2.dbPath), beforeV2Bytes, 'v2 dry-run wrote to the database');
  assert.deepEqual(fs.readdirSync(v2.options.operationsDir), [], 'v2 dry-run wrote journal artifacts');

  const beforeV3Files = walkFiles(v3.root).filter(name => !name.startsWith('blog.db'));
  const beforeV3Bytes = fs.readFileSync(v3.dbPath);
  const planV3 = planLocalizedContentMigration(v3.db, v3.options);
  const planV3Again = planLocalizedContentMigration(v3.db, v3.options);
  assert.deepEqual(planV3Again, planV3, 'dry-run plans must be deterministic');
  assert.deepEqual(walkFiles(v3.root).filter(name => !name.startsWith('blog.db')), beforeV3Files, 'v3 dry-run wrote files');
  assert.deepEqual(fs.readFileSync(v3.dbPath), beforeV3Bytes, 'v3 dry-run wrote to the database');
  assert.deepEqual(fs.readdirSync(v3.options.operationsDir), [], 'v3 dry-run wrote journal artifacts');

  assert.deepEqual(planV3, planV2, 'schema v2 and schema v3 dry-run plans must be identical');

  assert.deepEqual(planV2.conflicts, []);
  assert.deepEqual(planV2.missingMarkdown, []);
  assert.deepEqual(planV2.orphanMarkdown, []);
  assert.equal(planV2.markdownMoves.length, 1);
  const markdownMove = planV2.markdownMoves[0];
  assert.equal(markdownMove.articleId, 1);
  assert.equal(markdownMove.slug, 'example');
  assert.equal(markdownMove.locale, 'zh');
  assert.equal(markdownMove.from, 'example.md');
  assert.equal(markdownMove.to, 'zh/example.md');
  assert.equal(markdownMove.translationKey, 'example');
  assert.deepEqual(markdownMove.tags, ['nodejs', `legacy-${sha256('TypeScript').slice(0, 12)}`]);
  assert.deepEqual(markdownMove.rewrites, [
    { from: 'Node.js', to: 'nodejs' },
    { from: 'TypeScript', to: `legacy-${sha256('TypeScript').slice(0, 12)}` }
  ]);
  assert.equal(typeof markdownMove.originalHash, 'string');
  assert.equal(typeof markdownMove.stagedHash, 'string');

  assert.equal(planV2.audioMoves.length, 1);
  const audioMove = planV2.audioMoves[0];
  assert.equal(audioMove.from, `example/${sha256(mp3)}.mp3`);
  assert.equal(audioMove.to, `zh/example/${sha256(mp3)}.mp3`);
  assert.equal(audioMove.hash, sha256(mp3));
  assert.equal(audioMove.extension, 'mp3');
  assert.equal(typeof audioMove.originalHash, 'string');

  assert.equal(planV2.htmlAudioRewrites.length, 1);
  assert.equal(planV2.htmlAudioRewrites[0].occurrences, 2);
  assert.equal(planV2.htmlAudioRewrites[0].from, `/audio/example/${sha256(mp3)}.mp3`);
  assert.equal(planV2.htmlAudioRewrites[0].to, `/audio/zh/example/${sha256(mp3)}.mp3`);

  assert.equal(planV2.metadataRewrites.length, 1);
  const metadataRewrite = planV2.metadataRewrites[0];
  assert.equal(metadataRewrite.articleId, 1);
  assert.equal(metadataRewrite.contentHash, null, 'content without published URLs must not be rewritten');
  assert.equal(metadataRewrite.newContent, null);
  assert.doesNotMatch(metadataRewrite.newHtml, /\/audio\/example\//);
  assert.match(metadataRewrite.newHtml, /\/audio\/zh\/example\//);
  assert.match(metadataRewrite.newHtml, /class="article-audio__fallback"/);

  assert.deepEqual(planV2.tagMappings, [
    {
      articleId: 1,
      slug: 'example',
      mappings: [
        { value: 'Node.js', tagId: 'nodejs', kind: 'catalog' },
        { value: 'TypeScript', tagId: `legacy-${sha256('TypeScript').slice(0, 12)}`, kind: 'legacy' }
      ]
    }
  ]);
  v2.db.close();
  v3.db.close();
});

test('content migration dry-run predicts exact legacy tag ids for unknown values', t => {
  const mp3 = validMp3();
  const article = exampleArticleData(mp3);
  article.tags = ['Node.js', 'TypeScript'];
  article.markdown = transitionalMarkdown({ title: 'Example Post', slug: 'example', tags: ['Node.js', 'TypeScript'] });
  const v2 = buildContentFixture(t, { articles: [article] });
  const v3 = buildV3Fixture(t, { articles: [article] });
  const planV2 = planLocalizedContentMigration(v2.db, v2.options);
  const planV3 = planLocalizedContentMigration(v3.db, v3.options);
  assert.deepEqual(planV3, planV2);
  const typeScriptId = `legacy-${sha256('TypeScript').slice(0, 12)}`;
  assert.deepEqual(planV2.markdownMoves[0].tags, ['nodejs', typeScriptId]);
  assert.deepEqual(planV2.tagMappings[0].mappings, [
    { value: 'Node.js', tagId: 'nodejs', kind: 'catalog' },
    { value: 'TypeScript', tagId: typeScriptId, kind: 'legacy' }
  ]);
  v2.db.close();
  v3.db.close();
});

// ---------------------------------------------------------------------------
// Group 2: coordinated apply
// ---------------------------------------------------------------------------

test('content migration apply localizes markdown, audio, and exact HTML URLs', t => {
  const mp3 = validMp3();
  const hash = sha256(mp3);
  const fixture = buildV3Fixture(t, { articles: [exampleArticleData(mp3)] });
  const { root, db, options } = fixture;
  const dryPlan = planLocalizedContentMigration(db, options);

  const plan = applyLocalizedContentMigration(db, options);
  assert.deepEqual(plan, dryPlan);
  assert.deepEqual(fs.readdirSync(options.operationsDir), []);

  const moved = fs.readFileSync(path.join(root, 'articles', 'zh', 'example.md'), 'utf8');
  assert.match(moved, /^locale: zh$/m);
  assert.match(moved, /^translationKey: example$/m);
  assert.match(moved, /^tags: \["nodejs", "legacy-[a-f0-9]{12}"\]$/m);
  assert.match(moved, /^title: Example Post$/m);
  assert.ok(!fs.existsSync(path.join(root, 'articles', 'example.md')), 'legacy markdown source remains');

  assert.deepEqual(fs.readFileSync(path.join(root, 'public', 'audio', 'zh', 'example', `${hash}.mp3`)), mp3);
  assert.ok(!fs.existsSync(path.join(root, 'public', 'audio', 'example')), 'legacy audio directory remains');

  const row = db.prepare('SELECT html, content FROM articles WHERE id = 1').get();
  assert.match(row.html, /\/audio\/zh\/example\/[a-f0-9]{64}\.mp3/);
  assert.doesNotMatch(row.html, /\/audio\/example\//);
  assert.match(row.html, /class="article-audio__fallback"/);
  assert.equal(row.content, 'body text', 'content without published URLs must stay untouched');

  const dbTags = db.prepare('SELECT tag_id FROM article_tags WHERE article_id = 1 ORDER BY tag_id').all()
    .map(r => r.tag_id);
  const fileTags = parseMarkdownDocument(moved).data.tags;
  assert.deepEqual([...fileTags].sort(), dbTags, 'file tag ids must equal article_tags after apply');

  // Re-running after success returns an empty plan.
  const again = applyLocalizedContentMigration(db, options);
  assert.deepEqual(again.markdownMoves, []);
  assert.deepEqual(again.audioMoves, []);
  assert.deepEqual(again.metadataRewrites, []);
  assert.deepEqual(again.htmlAudioRewrites, []);
  assert.deepEqual(again.conflicts, []);
  assert.deepEqual(fs.readdirSync(options.operationsDir), []);
  db.close();
});

test('content migration apply rewrites exact published audio URLs stored in content and refreshes FTS', t => {
  const mp3 = validMp3();
  const hash = sha256(mp3);
  const body = `正文包含一个已发布链接 [听](/audio/example/${hash}.mp3)`;
  const article = exampleArticleData(mp3);
  article.content = body;
  article.markdown = `---\ntitle: Example Post\nslug: example\ndescription: 摘要\ntags:\n  - Node.js\n  - TypeScript\nstatus: published\ndate: '2026-01-01T00:00:00.000Z'\n---\n\n${body}\n`;
  const fixture = buildV3Fixture(t, { articles: [article] });
  const { db, options } = fixture;
  const dryPlan = planLocalizedContentMigration(db, options);
  assert.equal(dryPlan.metadataRewrites[0].contentHash, sha256(body));
  assert.match(dryPlan.metadataRewrites[0].newContent, new RegExp(`/audio/zh/example/${hash}\\.mp3`));

  applyLocalizedContentMigration(db, options);
  const row = db.prepare('SELECT content FROM articles WHERE id = 1').get();
  assert.match(row.content, new RegExp(`/audio/zh/example/${hash}\\.mp3`));
  assert.doesNotMatch(row.content, /\/audio\/example\//);
  const fts = db.prepare('SELECT content FROM article_fts WHERE rowid = 1').get();
  assert.match(fts.content, new RegExp(`/audio/zh/example/${hash}\\.mp3`), 'FTS content must refresh with content');
  db.close();
});

test('content migration already-migrated layout produces an empty plan', t => {
  const mp3 = validMp3();
  const hash = sha256(mp3);
  const fixture = buildV3Fixture(t, { articles: [exampleArticleData(mp3)] });
  const { root, db, options } = fixture;
  // Manually localize the layout before planning.
  fs.mkdirSync(path.join(root, 'articles', 'zh'), { recursive: true });
  fs.renameSync(path.join(root, 'articles', 'example.md'), path.join(root, 'articles', 'zh', 'example.md'));
  fs.mkdirSync(path.join(root, 'public', 'audio', 'zh', 'example'), { recursive: true });
  fs.renameSync(
    path.join(root, 'public', 'audio', 'example', `${hash}.mp3`),
    path.join(root, 'public', 'audio', 'zh', 'example', `${hash}.mp3`)
  );
  fs.rmdirSync(path.join(root, 'public', 'audio', 'example'));
  db.prepare('UPDATE articles SET html = ? WHERE id = 1').run(localizedAudioHtml({ slug: 'example', hash }));

  const plan = planLocalizedContentMigration(db, options);
  assert.deepEqual(plan.markdownMoves, []);
  assert.deepEqual(plan.audioMoves, []);
  assert.deepEqual(plan.metadataRewrites, []);
  assert.deepEqual(plan.conflicts, []);
  const applied = applyLocalizedContentMigration(db, options);
  assert.deepEqual(applied.markdownMoves, []);
  assert.deepEqual(fs.readdirSync(options.operationsDir), []);
  db.close();
});

// ---------------------------------------------------------------------------
// Group 3: planning conflicts and refused states
// ---------------------------------------------------------------------------

test('content migration conflicts when both archive layouts are present', t => {
  const mp3 = validMp3();
  const article = exampleArticleData(mp3);
  const fixture = buildV3Fixture(t, { articles: [article] });
  const { root, db, options } = fixture;
  fs.mkdirSync(path.join(root, 'articles', 'zh'), { recursive: true });
  fs.writeFileSync(path.join(root, 'articles', 'zh', 'example.md'), article.markdown);
  const plan = planLocalizedContentMigration(db, options);
  assert.deepEqual(plan.conflicts.map(conflict => `${conflict.articleId}:${conflict.type}`), ['1:both-layouts-present']);
  assert.throws(() => applyLocalizedContentMigration(db, options), error => error.code === 'plan_blocked');
  assert.deepEqual(fs.readdirSync(options.operationsDir), []);
  db.close();
});

test('content migration conflicts on a destination audio collision', t => {
  const mp3 = validMp3();
  const other = Buffer.from('different-audio-bytes-for-collision');
  const hash = sha256(mp3);
  const fixture = buildV3Fixture(t, { articles: [exampleArticleData(mp3)] });
  const { root, db, options } = fixture;
  const directory = path.join(root, 'public', 'audio', 'zh', 'example');
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, `${hash}.mp3`), other);
  const plan = planLocalizedContentMigration(db, options);
  assert.ok(plan.conflicts.some(conflict => conflict.type === 'destination-conflict'), JSON.stringify(plan.conflicts));
  assert.throws(() => applyLocalizedContentMigration(db, options), error => error.code === 'plan_blocked');
  db.close();
});

test('content migration conflicts on database/file slug mismatch', t => {
  const mp3 = validMp3();
  const article = exampleArticleData(mp3);
  article.markdown = transitionalMarkdown({ title: 'Example Post', slug: 'renamed', tags: ['Node.js', '教程'] });
  const fixture = buildV3Fixture(t, { articles: [article] });
  const { db, options } = fixture;
  const plan = planLocalizedContentMigration(db, options);
  assert.deepEqual(plan.conflicts.map(conflict => `${conflict.articleId}:${conflict.type}`), ['1:slug-mismatch']);
  assert.throws(() => applyLocalizedContentMigration(db, options), error => error.code === 'plan_blocked');
  db.close();
});

test('content migration conflicts on metadata mismatch (title/date/locale/key)', t => {
  const mp3 = validMp3();
  const article = exampleArticleData(mp3);
  article.markdown = transitionalMarkdown({ title: 'Other Title', slug: 'example', tags: ['Node.js', '教程'] });
  const fixture = buildV3Fixture(t, { articles: [article] });
  const { db, options } = fixture;
  const plan = planLocalizedContentMigration(db, options);
  assert.deepEqual(plan.conflicts.map(conflict => `${conflict.articleId}:${conflict.type}`), ['1:metadata-mismatch']);
  assert.throws(() => applyLocalizedContentMigration(db, options), error => error.code === 'plan_blocked');
  db.close();
});

test('content migration conflicts on file/database tag set mismatch', t => {
  const mp3 = validMp3();
  const article = exampleArticleData(mp3);
  article.markdown = transitionalMarkdown({ title: 'Example Post', slug: 'example', tags: ['Node.js'] });
  const fixture = buildV3Fixture(t, { articles: [article] });
  const { db, options } = fixture;
  const plan = planLocalizedContentMigration(db, options);
  assert.deepEqual(plan.conflicts.map(conflict => `${conflict.articleId}:${conflict.type}`), ['1:db-file-tag-mismatch']);
  assert.throws(() => applyLocalizedContentMigration(db, options), error => error.code === 'plan_blocked');
  db.close();
});

test('content migration reports missing markdown and refuses apply', t => {
  const mp3 = validMp3();
  const fixture = buildV3Fixture(t, { articles: [exampleArticleData(mp3)] });
  const { root, db, options } = fixture;
  fs.rmSync(path.join(root, 'articles', 'example.md'));
  const plan = planLocalizedContentMigration(db, options);
  assert.deepEqual(plan.missingMarkdown, [{ articleId: 1, slug: 'example' }]);
  assert.throws(() => applyLocalizedContentMigration(db, options), error => error.code === 'plan_blocked');
  assert.deepEqual(fs.readdirSync(options.operationsDir), []);
  db.close();
});

test('content migration reports orphan markdown and refuses apply', t => {
  const mp3 = validMp3();
  const fixture = buildV3Fixture(t, { articles: [exampleArticleData(mp3)] });
  const { root, db, options } = fixture;
  fs.writeFileSync(path.join(root, 'articles', 'stray.md'), '# orphan');
  const plan = planLocalizedContentMigration(db, options);
  assert.deepEqual(plan.orphanMarkdown, ['stray.md']);
  assert.throws(() => applyLocalizedContentMigration(db, options), error => error.code === 'plan_blocked');
  assert.deepEqual(fs.readdirSync(options.operationsDir), []);
  db.close();
});

test('content migration conflicts on foreign-slug and malformed audio URLs', t => {
  const mp3 = validMp3();
  const article = exampleArticleData(mp3);
  article.html = legacyAudioHtml({ slug: 'example', hash: sha256(mp3), extra: `<a href="/audio/another-post/${'f'.repeat(64)}.mp3">x</a><a href="/audio/example/not-a-hash.mp3">y</a>` });
  const fixture = buildV3Fixture(t, { articles: [article] });
  const { db, options } = fixture;
  const plan = planLocalizedContentMigration(db, options);
  const types = plan.conflicts.map(conflict => conflict.type).sort();
  assert.deepEqual(types, ['foreign-slug-audio-url', 'malformed-audio-url']);
  assert.throws(() => applyLocalizedContentMigration(db, options), error => error.code === 'plan_blocked');
  db.close();
});

test('content migration conflicts when a referenced audio file is missing', t => {
  const mp3 = validMp3();
  const article = exampleArticleData(mp3);
  article.html = legacyAudioHtml({ slug: 'example', hash: sha256(mp3), extra: `<a href="/audio/example/${'b'.repeat(64)}.mp3">x</a>` });
  const fixture = buildV3Fixture(t, { articles: [article] });
  const { db, options } = fixture;
  const plan = planLocalizedContentMigration(db, options);
  assert.ok(plan.conflicts.some(conflict => conflict.type === 'referenced-audio-missing'), JSON.stringify(plan.conflicts));
  assert.throws(() => applyLocalizedContentMigration(db, options), error => error.code === 'plan_blocked');
  db.close();
});

test('content migration conflicts on unreferenced legacy audio directories', t => {
  const mp3 = validMp3();
  const fixture = buildV3Fixture(t, { articles: [exampleArticleData(mp3)] });
  const { root, db, options } = fixture;
  fs.mkdirSync(path.join(root, 'public', 'audio', 'stray'), { recursive: true });
  fs.writeFileSync(path.join(root, 'public', 'audio', 'stray', `${'d'.repeat(64)}.mp3`), validMp3());
  const plan = planLocalizedContentMigration(db, options);
  assert.ok(plan.conflicts.some(conflict => conflict.type === 'unreferenced-audio-directory'), JSON.stringify(plan.conflicts));
  assert.throws(() => applyLocalizedContentMigration(db, options), error => error.code === 'plan_blocked');
  db.close();
});

test('content migration conflicts on unreferenced legacy audio files before any mutation', async t => {
  const mp3 = validMp3();
  const stray = Buffer.from('unreferenced-legacy-audio-bytes');
  const strayHash = sha256(stray);
  const fixture = buildV3Fixture(t, { articles: [exampleArticleData(mp3)] });
  const { root, db, dbPath, options } = fixture;
  fs.writeFileSync(path.join(root, 'public', 'audio', 'example', `${strayHash}.mp3`), stray);
  const beforeFiles = walkFiles(root).filter(name => !name.startsWith('blog.db'));
  const beforeBytes = fs.readFileSync(dbPath);

  // Dry-run reports the deterministic pre-commit conflict with zero writes.
  const dryRun = await runContentCli(root, ['--dry-run']);
  assert.equal(dryRun.code, 2, dryRun.stdout);
  const dryPlan = JSON.parse(dryRun.stdout).plan;
  assert.ok(
    dryPlan.conflicts.some(conflict => conflict.type === 'unreferenced-audio-file' && conflict.file === `${strayHash}.mp3`),
    JSON.stringify(dryPlan.conflicts)
  );
  assert.deepEqual(walkFiles(root).filter(name => !name.startsWith('blog.db')), beforeFiles, 'dry-run mutated files');
  assert.deepEqual(fs.readFileSync(dbPath), beforeBytes, 'dry-run mutated the database');

  // Apply refuses pre-commit and mutates nothing.
  assert.throws(() => applyLocalizedContentMigration(db, options), error => error.code === 'plan_blocked');
  assert.deepEqual(fs.readdirSync(options.operationsDir), []);
  assert.deepEqual(walkFiles(root).filter(name => !name.startsWith('blog.db')), beforeFiles, 'apply mutated files');
  assert.deepEqual(fs.readFileSync(dbPath), beforeBytes, 'apply mutated the database');
  assert.ok(fs.existsSync(path.join(root, 'public', 'audio', 'example', `${strayHash}.mp3`)), 'stray legacy audio was deleted');
  db.close();
});

test('content migration refuses schema v2 apply', t => {
  const mp3 = validMp3();
  const fixture = buildContentFixture(t, { articles: [exampleArticleData(mp3)] });
  const { db, options } = fixture;
  assert.equal(schemaVersion(db), 2);
  assert.throws(
    () => applyLocalizedContentMigration(db, options),
    error => error.code === 'schema_migration_required'
  );
  assert.deepEqual(fs.readdirSync(options.operationsDir), []);
  db.close();
});

test('content migration refuses while an incomplete manifest or stale lock exists', async t => {
  const mp3 = validMp3();
  const fixture = buildV3Fixture(t, { articles: [exampleArticleData(mp3)] });
  const { root, db, options } = fixture;
  // Incomplete manifest without a lock.
  const operationId = 'orphaned-op';
  const opDir = path.join(options.operationsDir, operationId);
  fs.mkdirSync(opDir, { recursive: true });
  fs.writeFileSync(path.join(opDir, 'operation.json'), JSON.stringify({
    schema: 1, operationId, type: 'content-migrate', phase: 'prepared',
    createdAt: new Date().toISOString(), files: []
  }));
  assert.throws(() => applyLocalizedContentMigration(db, options), error => error.code === 'operation_incomplete');
  assert.deepEqual(fs.readdirSync(options.operationsDir), [operationId]);
  fs.rmSync(opDir, { recursive: true, force: true });

  // Stale lock (dead owner) without an operation directory.
  fs.mkdirSync(path.join(options.operationsDir, 'active.lock'), { recursive: true });
  fs.writeFileSync(path.join(options.operationsDir, 'active.lock', 'owner.json'), JSON.stringify({
    pid: 999999999, hostname: 'test', operationId: 'other-op', type: 'content-migrate', acquiredAt: new Date().toISOString()
  }));
  assert.throws(() => applyLocalizedContentMigration(db, options), error => error.code === 'operation_stale_lock');
  const dryRun = await runContentCli(root, ['--dry-run']);
  assert.notEqual(dryRun.code, 0);
  assert.match(dryRun.stdout, /stale/);
  db.close();
});

// ---------------------------------------------------------------------------
// Group 4: compensated failures and stale-state guards
// ---------------------------------------------------------------------------

const compensationCases = [
  { name: 'after staging', injection: { stage: true } },
  { name: 'after markdown tombstoning', injection: { 'markdown-tombstone': true } },
  { name: 'after audio tombstoning', injection: { 'audio-tombstone': true } },
  { name: 'after markdown promotion', injection: { 'markdown-promote': true } },
  { name: 'after audio promotion', injection: { 'audio-promote': true } },
  { name: 'after SQL html update', injection: { db: true } },
  { name: 'after fts refresh', injection: { fts: true } }
];

for (const { name, injection } of compensationCases) {
  test(`content migration restores files and database after an injected failure ${name}`, t => {
    const mp3 = validMp3();
    const fixture = buildV3Fixture(t, { articles: [exampleArticleData(mp3)] });
    const { root, db, options } = fixture;
    const beforeFiles = walkFiles(root).filter(file => !file.startsWith('blog.db'));
    const beforeBytes = fs.readFileSync(fixture.dbPath);
    const beforeDb = contentDbStateHash(db);

    assert.throws(
      () => applyLocalizedContentMigration(db, options, { injectFailures: injection }),
      /injected failure/
    );

    assert.deepEqual(fs.readdirSync(options.operationsDir), [], `journal residue after ${name}`);
    assert.deepEqual(walkFiles(root).filter(file => !file.startsWith('blog.db')), beforeFiles, `file residue after ${name}`);
    assert.deepEqual(fs.readFileSync(fixture.dbPath), beforeBytes, `database bytes changed after ${name}`);
    assert.equal(contentDbStateHash(db), beforeDb, `database rows changed after ${name}`);
    assert.ok(!fs.existsSync(path.join(options.operationsDir, 'active.lock')), 'lock residue after compensation');
    db.close();
  });
}

test('content migration compensates when a source file drifts before its tombstone rename', t => {
  const mp3 = validMp3();
  const fixture = buildV3Fixture(t, { articles: [exampleArticleData(mp3)] });
  const { root, db, options } = fixture;
  const beforeFiles = walkFiles(root).filter(name => !name.startsWith('blog.db'));
  const beforeDb = contentDbStateHash(db);
  const hooks = {
    beforeTombstone() {
      fs.appendFileSync(path.join(options.articlesDir, 'example.md'), ' drift');
    }
  };
  assert.throws(() => applyLocalizedContentMigration(db, options, { hooks }), error => error.code === 'file_hash_mismatch');
  assert.deepEqual(walkFiles(root).filter(name => !name.startsWith('blog.db')), beforeFiles);
  assert.equal(contentDbStateHash(db), beforeDb);
  assert.deepEqual(fs.readdirSync(options.operationsDir), []);
  db.close();
});

test('content migration reports a destination collision and compensates', t => {
  const mp3 = validMp3();
  const fixture = buildV3Fixture(t, { articles: [exampleArticleData(mp3)] });
  const { root, db, options } = fixture;
  const beforeDb = contentDbStateHash(db);
  const hooks = {
    afterTombstone() {
      fs.mkdirSync(path.join(options.articlesDir, 'zh'), { recursive: true });
      fs.writeFileSync(path.join(options.articlesDir, 'zh', 'example.md'), 'unexpected writer');
    }
  };
  assert.throws(() => applyLocalizedContentMigration(db, options, { hooks }), error => error.code === 'destination_collision');
  // The operation's own source is restored from its tombstone...
  assert.ok(fs.existsSync(path.join(root, 'articles', 'example.md')), 'source markdown not restored');
  assert.equal(
    fs.readFileSync(path.join(root, 'articles', 'example.md'), 'utf8'),
    exampleArticleData(mp3).markdown,
    'source markdown content changed'
  );
  // ...while the external destination written by the hook survives untouched.
  assert.equal(fs.readFileSync(path.join(root, 'articles', 'zh', 'example.md'), 'utf8'), 'unexpected writer');
  assert.equal(contentDbStateHash(db), beforeDb);
  assert.deepEqual(fs.readdirSync(options.operationsDir), []);
  assert.ok(!fs.existsSync(path.join(options.operationsDir, 'active.lock')));
  db.close();
});

test('pre-existing identical audio destinations survive rollback and pre-state recovery', async t => {
  const mp3 = validMp3();
  const hash = sha256(mp3);
  const fixture = buildV3Fixture(t, { articles: [exampleArticleData(mp3)] });
  const { root, db, options } = fixture;
  const localizedDir = path.join(root, 'public', 'audio', 'zh', 'example');
  fs.mkdirSync(localizedDir, { recursive: true });
  fs.writeFileSync(path.join(localizedDir, `${hash}.mp3`), mp3);
  const legacyDir = path.join(root, 'public', 'audio', 'example');
  const beforeDb = contentDbStateHash(db);

  // 1) A caught failure after the audio promotion flag: the pre-existing
  // destination and the restored legacy source must both survive byte-identically.
  assert.throws(
    () => applyLocalizedContentMigration(db, options, { injectFailures: { 'audio-promote': true } }),
    /injected failure/
  );
  assert.deepEqual(fs.readFileSync(path.join(localizedDir, `${hash}.mp3`)), mp3, 'pre-existing destination deleted by rollback');
  assert.deepEqual(fs.readFileSync(path.join(legacyDir, `${hash}.mp3`)), mp3, 'legacy source not restored by rollback');
  assert.deepEqual(
    fs.readFileSync(path.join(root, 'articles', 'example.md'), 'utf8'),
    exampleArticleData(mp3).markdown,
    'source markdown not restored by rollback'
  );
  assert.ok(!fs.existsSync(path.join(root, 'articles', 'zh', 'example.md')), 'apply-created markdown destination remains after rollback');
  assert.equal(contentDbStateHash(db), beforeDb);
  assert.deepEqual(fs.readdirSync(options.operationsDir), []);
  assert.ok(!fs.existsSync(path.join(options.operationsDir, 'active.lock')));

  // 2) A child-process kill after promotion followed by --recover must restore
  // the pre-state with both identical audio files intact.
  const handle = spawnContentCli(root, []);
  const operationId = await waitFor(() => firstOperationId(root), { timeoutMs: 15000 });
  await waitFor(() => {
    const manifest = readOperationManifest(root, operationId);
    return manifest && manifest.phase === 'files-promoted' ? manifest : null;
  }, { timeoutMs: 15000 });
  await killChild(handle.child);
  await handle.exit;
  const recovered = await runContentCli(root, ['--recover', operationId]);
  assert.equal(recovered.code, 0, recovered.stderr);
  const output = JSON.parse(recovered.stdout);
  assert.equal(output.state, 'pre-state-restored');
  assert.deepEqual(fs.readFileSync(path.join(localizedDir, `${hash}.mp3`)), mp3, 'pre-existing destination deleted by recovery');
  assert.deepEqual(fs.readFileSync(path.join(legacyDir, `${hash}.mp3`)), mp3, 'legacy source not restored by recovery');
  assert.ok(fs.existsSync(path.join(root, 'articles', 'example.md')), 'source markdown not restored by recovery');
  assert.ok(!fs.existsSync(path.join(root, 'articles', 'zh', 'example.md')), 'apply-created markdown destination remains after recovery');
  assert.deepEqual(fs.readdirSync(options.operationsDir), []);

  // 3) A fresh apply then completes end-to-end with the pre-existing destination retained.
  const plan = applyLocalizedContentMigration(db, options);
  assert.equal(plan.audioMoves.length, 1);
  assert.deepEqual(fs.readdirSync(options.operationsDir), []);
  assert.deepEqual(fs.readFileSync(path.join(localizedDir, `${hash}.mp3`)), mp3, 'destination bytes changed by the fresh apply');
  db.close();
});

test('content migration compensates when the database drifts before the apply transaction', t => {
  const mp3 = validMp3();
  const fixture = buildV3Fixture(t, { articles: [exampleArticleData(mp3)] });
  const { root, db, options } = fixture;
  const beforeFiles = walkFiles(root).filter(name => !name.startsWith('blog.db'));
  const hooks = {
    beforeDbTransaction() {
      db.prepare("UPDATE articles SET title = 'drift' WHERE id = 1").run();
    }
  };
  assert.throws(() => applyLocalizedContentMigration(db, options, { hooks }), error => error.code === 'stale_state');
  assert.deepEqual(walkFiles(root).filter(name => !name.startsWith('blog.db')), beforeFiles);
  assert.equal(db.prepare('SELECT title FROM articles WHERE id = 1').get().title, 'drift');
  assert.deepEqual(fs.readdirSync(options.operationsDir), []);
  db.close();
});

test('content migration leaves a recoverable db-committed journal when the final audit fails after commit', t => {
  const mp3 = validMp3();
  const fixture = buildV3Fixture(t, { articles: [exampleArticleData(mp3)] });
  const { root, db, options } = fixture;
  assert.throws(
    () => applyLocalizedContentMigration(db, options, { injectFailures: { audit: true } }),
    error => error.code === 'cleanup_failed'
  );

  const operationId = firstOperationId(root);
  assert.ok(operationId, 'no recoverable operation directory retained');
  assert.equal(readOperationManifest(root, operationId).phase, 'db-committed');
  assert.ok(fs.existsSync(path.join(options.operationsDir, 'active.lock')), 'lock evidence missing');

  // Simulate the apply process having died, then finalize through stale-lock takeover.
  const ownerPath = path.join(options.operationsDir, 'active.lock', 'owner.json');
  const owner = JSON.parse(fs.readFileSync(ownerPath, 'utf8'));
  fs.writeFileSync(ownerPath, JSON.stringify({ ...owner, pid: 999999999 }));

  const result = recoverLocalizedContentMigration(db, operationId, options);
  assert.equal(result.state, 'post-state-finalized');
  assert.deepEqual(fs.readdirSync(options.operationsDir), []);
  assert.ok(!fs.existsSync(path.join(options.operationsDir, 'active.lock')));
  const row = db.prepare('SELECT html FROM articles WHERE id = 1').get();
  assert.match(row.html, /\/audio\/zh\/example\//);
  assert.ok(fs.existsSync(path.join(root, 'articles', 'zh', 'example.md')));
  db.close();
});

test('recovery refuses to finalize an audit-invalid committed post-state', t => {
  const mp3 = validMp3();
  const fixture = buildV3Fixture(t, { articles: [exampleArticleData(mp3)] });
  const { root, db, options } = fixture;
  assert.throws(
    () => applyLocalizedContentMigration(db, options, { injectFailures: { audit: true } }),
    error => error.code === 'cleanup_failed'
  );
  const operationId = firstOperationId(root);
  assert.ok(operationId);
  assert.equal(readOperationManifest(root, operationId).phase, 'db-committed');

  // Corrupt only the filesystem post-state so the required audit rejects it:
  // an unreferenced locale-owned audio file (the database stays post-state).
  const strayHash = 'e'.repeat(64);
  const strayPath = path.join(root, 'public', 'audio', 'zh', 'example', `${strayHash}.mp3`);
  fs.writeFileSync(strayPath, Buffer.from('stray-locale-owned-audio'));

  // Simulate the apply process having died, then attempt recovery: it must
  // refuse to report post-state-finalized and must retain the evidence.
  const ownerPath = path.join(options.operationsDir, 'active.lock', 'owner.json');
  const owner = JSON.parse(fs.readFileSync(ownerPath, 'utf8'));
  fs.writeFileSync(ownerPath, JSON.stringify({ ...owner, pid: 999999999 }));
  assert.throws(
    () => recoverLocalizedContentMigration(db, operationId, options),
    error => error.code === 'recovery_ambiguous'
  );
  assert.ok(fs.existsSync(path.join(options.operationsDir, operationId)), 'journal evidence removed on refusal');
  assert.ok(fs.existsSync(path.join(options.operationsDir, 'active.lock')), 'lock evidence removed on refusal');
  assert.ok(fs.existsSync(strayPath), 'stray locale-owned audio was silently deleted');
  const row = db.prepare('SELECT html FROM articles WHERE id = 1').get();
  assert.match(row.html, /\/audio\/zh\/example\//, 'committed post-state must not be rolled back on refusal');

  // Removing the stray file lets recovery finalize the committed post-state.
  // The first (refusing) recovery process has "died": mark its lock stale again.
  fs.rmSync(strayPath, { force: true });
  const secondOwnerPath = path.join(options.operationsDir, 'active.lock', 'owner.json');
  const secondOwner = JSON.parse(fs.readFileSync(secondOwnerPath, 'utf8'));
  fs.writeFileSync(secondOwnerPath, JSON.stringify({ ...secondOwner, pid: 999999999 }));
  const result = recoverLocalizedContentMigration(db, operationId, options);
  assert.equal(result.state, 'post-state-finalized');
  assert.deepEqual(fs.readdirSync(options.operationsDir), []);
  assert.ok(!fs.existsSync(path.join(options.operationsDir, 'active.lock')));
  db.close();
});

// ---------------------------------------------------------------------------
// Group 5: lock semantics and child-process recovery
// ---------------------------------------------------------------------------

test('content migration recovery restores or finalizes child-process kill states deterministically', async t => {
  const killStates = [
    { name: 'after lock acquisition', reached: manifest => manifest && manifest.phase === 'lock-acquired' },
    {
      name: 'after tombstoning',
      reached: manifest => manifest && manifest.files.length >= 2
        && manifest.files.every(file => file.tombstoned) && manifest.files.some(file => !file.promoted)
    },
    { name: 'after promotion', reached: manifest => manifest && manifest.phase === 'files-promoted' },
    { name: 'after database commit', reached: manifest => manifest && manifest.phase === 'db-committed' }
  ];

  for (const { name, reached } of killStates) {
    const mp3 = validMp3();
    const fixture = buildV3Fixture(t, { articles: [exampleArticleData(mp3)] });
    const { root, options } = fixture;

    const handle = spawnContentCli(root, []);
    const operationId = await waitFor(() => firstOperationId(root), { timeoutMs: 15000 });
    await waitFor(() => {
      const current = readOperationManifest(root, operationId);
      return reached(current) ? current : null;
    }, { timeoutMs: 15000 });
    await killChild(handle.child);
    await handle.exit;

    // A normal apply refuses while the incomplete journal or stale lock is present.
    const refused = await runContentCli(root, []);
    assert.notEqual(refused.code, 0, `normal apply did not refuse after ${name}`);
    assert.match(refused.stdout, /incomplete|stale/i);

    // Recovery deterministically restores pre-state or finalizes post-state.
    const recovered = await runContentCli(root, ['--recover', operationId]);
    assert.equal(recovered.code, 0, `recovery failed after ${name}: ${recovered.stderr}`);
    const output = JSON.parse(recovered.stdout);
    assert.ok(['pre-state-restored', 'post-state-finalized', 'already-complete'].includes(output.state));

    assert.deepEqual(fs.readdirSync(options.operationsDir), []);
    assert.ok(!fs.existsSync(path.join(options.operationsDir, 'active.lock')));

    if (output.state === 'pre-state-restored') {
      const fresh = new Database(path.join(root, 'blog.db'));
      fresh.pragma('foreign_keys = ON');
      applyLocalizedContentMigration(fresh, options);
      assert.deepEqual(fs.readdirSync(options.operationsDir), []);
      assert.ok(fs.existsSync(path.join(root, 'articles', 'zh', 'example.md')));
      fresh.close();
    }
  }
});

test('content migration recovery refuses an unsafe tombstone path in the manifest', t => {
  const mp3 = validMp3();
  const fixture = buildV3Fixture(t, { articles: [exampleArticleData(mp3)] });
  const { db, options } = fixture;
  const operationId = 'unsafe-tombstone-op';
  fs.mkdirSync(path.join(options.operationsDir, operationId), { recursive: true });
  fs.writeFileSync(path.join(options.operationsDir, operationId, 'operation.json'), JSON.stringify({
    schema: 1, operationId, type: 'content-migrate',
    phase: 'prepared', createdAt: new Date().toISOString(),
    articlesDir: options.articlesDir,
    audioDir: options.audioDir,
    stagingRoot: path.join(options.tempDir, 'localized-content-unsafe-tombstone-op'),
    rootDir: options.rootDir,
    dbPath: fixture.dbPath,
    plan: { conflicts: [], affectedArticleIds: [] },
    preDbHash: contentDbStateHash(db), postDbHash: 'sha256:later',
    files: [{
      kind: 'markdown', path: 'example.md', destination: 'zh/example.md',
      originalHash: 'sha256:original', stagedHash: 'sha256:staged',
      stagedPath: 'uploads/temp/x/0.md',
      tombstone: '../../escape.md',
      tombstoned: false, promoted: false
    }]
  }));
  assert.throws(() => recoverLocalizedContentMigration(db, operationId, options), error => error.code === 'invalid_manifest');
  assert.ok(fs.existsSync(path.join(options.operationsDir, operationId)));
  db.close();
});

test('content migration recovery refuses ambiguous states and retains the journal as evidence', t => {
  const mp3 = validMp3();
  const fixture = buildV3Fixture(t, { articles: [exampleArticleData(mp3)] });
  const { db, options } = fixture;
  const operationId = 'ambiguous-op';
  fs.mkdirSync(path.join(options.operationsDir, operationId), { recursive: true });
  fs.writeFileSync(path.join(options.operationsDir, operationId, 'operation.json'), JSON.stringify({
    schema: 1, operationId, type: 'content-migrate',
    phase: 'files-promoted', createdAt: new Date().toISOString(),
    articlesDir: options.articlesDir,
    audioDir: options.audioDir,
    stagingRoot: path.join(options.tempDir, 'localized-content-ambiguous-op'),
    rootDir: options.rootDir,
    dbPath: fixture.dbPath,
    plan: { conflicts: [], affectedArticleIds: [] },
    preDbHash: 'sha256:nonexistent-pre', postDbHash: 'sha256:nonexistent-post',
    files: []
  }));
  assert.throws(() => recoverLocalizedContentMigration(db, operationId, options), error => error.code === 'recovery_ambiguous');
  assert.ok(fs.existsSync(path.join(options.operationsDir, operationId)), 'evidence removed on refusal');
  assert.ok(fs.existsSync(path.join(options.operationsDir, 'active.lock')), 'lock removed on refusal');
  db.close();
});

// ---------------------------------------------------------------------------
// Deterministic phase-anchored whole-tree comparisons for the shared-lock test
// ---------------------------------------------------------------------------

// The owner apply stages every payload before persisting phase 'prepared' and
// performs every recorded rename before persisting phase 'files-promoted';
// both phases are durable manifest states, so the file tree can be compared at
// those two phase boundaries without racing the owner's ongoing writes.
// Between 'prepared' and 'files-promoted' the non-DB tree may differ only by
// the owner's own recorded moves; any additional difference is a write by the
// blocked process under test. A recorded markdown move is staged under
// uploads/temp and renamed to its destination during promotion, so its staged
// path is also removed; audio moves link their destination from the tombstone
// and never stage a payload.

function normalizedStagedPath(file) {
  return file.stagedPath ? file.stagedPath.replaceAll('\\', '/') : null;
}

function contentMovePathChanges(manifest) {
  const added = [];
  const removed = [];
  for (const file of manifest.files) {
    const directory = file.kind === 'audio' ? 'public/audio' : 'articles';
    removed.push(path.posix.join(directory, file.path));
    const stagedPath = normalizedStagedPath(file);
    if (stagedPath) removed.push(stagedPath);
    added.push(path.posix.join(directory, file.tombstone));
    added.push(path.posix.join(directory, file.destination));
  }
  return { added: added.sort(), removed: removed.sort() };
}

function taxonomyMovePathChanges(manifest) {
  const added = [];
  const removed = [];
  for (const file of manifest.files) {
    // A taxonomy rewrite is promoted back to its own source path, so the
    // source exists in both snapshots; only the staged copy and the tombstone
    // change between 'prepared' and 'files-promoted'.
    const stagedPath = normalizedStagedPath(file);
    if (stagedPath) removed.push(stagedPath);
    added.push(path.posix.join('articles', file.tombstone));
  }
  return { added: added.sort(), removed: removed.sort() };
}

function assertTreeDiff(actual, baseline, expected, message) {
  const baselineSet = new Set(baseline);
  const actualSet = new Set(actual);
  assert.deepEqual(
    actual.filter(name => !baselineSet.has(name)).sort(),
    expected.added,
    `${message}: unexpected added paths`
  );
  assert.deepEqual(
    baseline.filter(name => !actualSet.has(name)).sort(),
    expected.removed,
    `${message}: unexpected removed paths`
  );
}

test('taxonomy and content migrations serialize on the shared var/operations lock', async t => {
  const mp3 = validMp3();
  const fixture = buildV3Fixture(t, { articles: [exampleArticleData(mp3)] });
  const { root, db, options } = fixture;
  writeCliCatalog(root, mutatedCatalog());

  // Direction 1: a paused content apply owns the lock; the taxonomy apply is inert.
  const contentHandle = spawnContentCli(root, []);
  const contentOperationId = await waitFor(() => {
    const id = firstOperationId(root);
    const current = readOperationManifest(root, id);
    return current && current.phase === 'prepared' ? id : null;
  }, { timeoutMs: 15000 });

  // Phase 'prepared' means every staging write is durable and the owner is
  // paused before its first live rename; snapshot the tree at this boundary.
  const beforeTaxonomyFiles = walkFiles(root).filter(name => !name.startsWith('blog.db'));
  const contentManifest = readOperationManifest(root, contentOperationId);
  assert.ok(
    contentManifest.files.every(file => !file.tombstoned && !file.promoted),
    'content owner was no longer paused at prepared'
  );

  const taxonomyBlocked = await runTaxonomyCli(root, []);
  assert.notEqual(taxonomyBlocked.code, 0, 'taxonomy apply must fail while content owns the lock');
  assert.match(taxonomyBlocked.stdout, /active|busy|incomplete|stale/i);

  // A concurrent dry-run reports the active operation without writing.
  const dryRun = await runContentCli(root, ['--dry-run']);
  assert.notEqual(dryRun.code, 0);
  assert.match(dryRun.stdout, /active operation/i);

  // Re-anchor on 'files-promoted' (every recorded rename durable) and require
  // the whole non-DB tree to differ only by the owner's own recorded moves,
  // proving neither the blocked taxonomy apply nor the dry-run wrote anything.
  await waitFor(() => readOperationManifest(root, contentOperationId)?.phase === 'files-promoted', { timeoutMs: 15000 });
  const afterTaxonomyFiles = walkFiles(root).filter(name => !name.startsWith('blog.db'));
  assertTreeDiff(afterTaxonomyFiles, beforeTaxonomyFiles, contentMovePathChanges(contentManifest), 'loser changed files');

  // Kill and recover the content owner.
  await killChild(contentHandle.child);
  await contentHandle.exit;
  const recoveredContent = await runContentCli(root, ['--recover', contentOperationId]);
  assert.equal(recoveredContent.code, 0, recoveredContent.stderr);
  assert.deepEqual(fs.readdirSync(options.operationsDir), []);

  // Direction 2: a paused taxonomy apply owns the lock; the content apply is inert.
  const taxonomyHandle = spawnTaxonomyCli(root, []);
  const taxonomyOperationId = await waitFor(() => {
    const id = firstOperationId(root);
    const current = readOperationManifest(root, id);
    return current && current.phase === 'prepared' ? id : null;
  }, { timeoutMs: 15000 });
  const beforeContentFiles = walkFiles(root).filter(name => !name.startsWith('blog.db'));
  const taxonomyManifest = readOperationManifest(root, taxonomyOperationId);
  assert.ok(
    taxonomyManifest.files.every(file => !file.tombstoned && !file.promoted),
    'taxonomy owner was no longer paused at prepared'
  );

  const contentBlocked = await runContentCli(root, []);
  assert.notEqual(contentBlocked.code, 0, 'content apply must fail while taxonomy owns the lock');
  assert.match(contentBlocked.stdout, /active|busy|incomplete|stale/i);

  await waitFor(() => readOperationManifest(root, taxonomyOperationId)?.phase === 'files-promoted', { timeoutMs: 15000 });
  const afterContentFiles = walkFiles(root).filter(name => !name.startsWith('blog.db'));
  assertTreeDiff(afterContentFiles, beforeContentFiles, taxonomyMovePathChanges(taxonomyManifest), 'loser changed files');

  await killChild(taxonomyHandle.child);
  await taxonomyHandle.exit;
  const recoveredTaxonomy = await runTaxonomyCli(root, ['--recover', taxonomyOperationId]);
  assert.equal(recoveredTaxonomy.code, 0, recoveredTaxonomy.stderr);
  assert.deepEqual(fs.readdirSync(options.operationsDir), []);

  // Both migrations now run serially and leave a clean registry.
  const taxonomyApplied = await runTaxonomyCli(root, []);
  assert.equal(taxonomyApplied.code, 0, taxonomyApplied.stderr);
  assert.deepEqual(fs.readdirSync(options.operationsDir), []);
  const contentApplied = await runContentCli(root, []);
  assert.equal(contentApplied.code, 0, contentApplied.stderr);
  assert.deepEqual(fs.readdirSync(options.operationsDir), []);
  db.close();
});

// ---------------------------------------------------------------------------
// Group 6: CLI contract
// ---------------------------------------------------------------------------

test('content migration CLI rejects unknown, missing, and mixed flags', async t => {
  const mp3 = validMp3();
  const fixture = buildV3Fixture(t, { articles: [exampleArticleData(mp3)] });
  const { root } = fixture;
  for (const args of [
    ['--bogus'],
    ['--recover'],
    ['--recover', 'op', '--dry-run'],
    ['--dry-run', 'extra']
  ]) {
    const result = await runContentCli(root, args);
    assert.notEqual(result.code, 0, `flags ${args.join(' ')} must be rejected`);
    assert.match(result.stdout, /usage/i);
  }
  const recovery = await runContentCli(root, ['--recover', 'missing-op-id']);
  assert.equal(recovery.code, 4);
  assert.match(recovery.stdout, /no operation/i);
});

test('content migration CLI apply prints a JSON plan and leaves no journal residue', async t => {
  const mp3 = validMp3();
  const fixture = buildV3Fixture(t, { articles: [exampleArticleData(mp3)] });
  const { root, options } = fixture;
  const result = await runContentCli(root, []);
  assert.equal(result.code, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.applied, true);
  assert.ok(/^[a-z0-9-]+$/i.test(output.operationId));
  assert.equal(output.plan.markdownMoves.length, 1);
  assert.equal(output.plan.audioMoves.length, 1);
  assert.deepEqual(fs.readdirSync(options.operationsDir), []);
});

test('content migration CLI dry-run on schema v2 prints a plan with zero writes', async t => {
  const mp3 = validMp3();
  const fixture = buildContentFixture(t, { articles: [exampleArticleData(mp3)] });
  const { root, dbPath, options } = fixture;
  const beforeBytes = fs.readFileSync(dbPath);
  const beforeFiles = walkFiles(root).filter(name => !name.startsWith('blog.db'));

  const result = await runContentCli(root, ['--dry-run']);
  assert.equal(result.code, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.dryRun, true);
  assert.equal(output.schemaVersion, 2);
  assert.equal(output.preMigration, true);
  assert.equal(output.plan.markdownMoves.length, 1);
  assert.equal(output.plan.audioMoves.length, 1);
  assert.equal(output.plan.metadataRewrites.length, 1);
  assert.deepEqual(fs.readFileSync(dbPath), beforeBytes, 'v2 dry-run wrote to the database');
  assert.deepEqual(walkFiles(root).filter(name => !name.startsWith('blog.db')), beforeFiles, 'v2 dry-run wrote files');
  assert.deepEqual(fs.readdirSync(options.operationsDir), [], 'v2 dry-run wrote journal artifacts');
});

// ---------------------------------------------------------------------------
// Group 7: page and byte-range behavior after apply
// ---------------------------------------------------------------------------

test('after apply the transitional Chinese app serves the localized audio page with byte ranges', async t => {
  const root = await createProjectFixture(t);
  const mp3 = validMp3();
  const hash = sha256(mp3);
  const article = exampleArticleData(mp3);

  const taxonomyPath = path.join(root, 'content', 'taxonomy.json');
  fs.writeFileSync(taxonomyPath, JSON.stringify(contentCatalog()));
  const dbPath = path.join(root, 'blog.db');
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(legacySchemaSql());
  db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)');
  db.prepare('INSERT OR IGNORE INTO schema_migrations (version, applied_at) VALUES (?, ?)').run(1, '2026-01-01T00:00:00.000Z');
  db.prepare('INSERT OR IGNORE INTO schema_migrations (version, applied_at) VALUES (?, ?)').run(2, '2026-01-01T00:00:00.000Z');
  insertLegacyArticle(db, article);
  db.close();

  const migrated = new Database(dbPath);
  migrateDatabase(migrated, { taxonomyPath });
  migrated.close();

  fs.writeFileSync(path.join(root, 'articles', 'example.md'), article.markdown);
  fs.mkdirSync(path.join(root, 'public', 'audio', 'example'), { recursive: true });
  fs.writeFileSync(path.join(root, 'public', 'audio', 'example', `${hash}.mp3`), mp3);

  const result = runNode(root, 'scripts/migrate-localized-content.js');
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);

  const server = await startServer(t, root, { JWT_SECRET });
  const pageResponse = await fetch(`${server.baseUrl}/article/example`);
  const page = await pageResponse.text();
  assert.equal(pageResponse.status, 200, page);
  assert.doesNotMatch(page, /\/audio\/example\//, 'page must not contain legacy audio URLs');
  const urlMatch = page.match(/\/audio\/zh\/example\/[a-f0-9]{64}\.mp3/);
  assert.ok(urlMatch, 'page must contain the localized audio URL');
  const audioUrl = `${server.baseUrl}${urlMatch[0]}`;

  const rangeResponse = await fetch(audioUrl, { headers: { range: 'bytes=0-3' } });
  assert.equal(rangeResponse.status, 206);
  assert.equal(rangeResponse.headers.get('content-range'), `bytes 0-3/${mp3.length}`);
  assert.deepEqual(Buffer.from(await rangeResponse.arrayBuffer()), mp3.subarray(0, 4));
});

// ---------------------------------------------------------------------------
// Group 8: read-only auditor
// ---------------------------------------------------------------------------

test('audit-localized-content passes on a migrated fixture and prints deterministic JSON', t => {
  const mp3 = validMp3();
  const fixture = buildV3Fixture(t, { articles: [exampleArticleData(mp3)] });
  applyLocalizedContentMigration(fixture.db, fixture.options);
  const audit = auditLocalizedContent(fixture.db, fixture.options);
  assert.equal(audit.passed, true, JSON.stringify(audit.errors));
  assert.deepEqual(audit.errors, []);
  assert.equal(audit.checks.integrity, true);
  assert.equal(audit.checks.foreignKeys, true);
  assert.equal(audit.checks.articles, true);
  assert.equal(audit.checks.legacyLayout, true);
  assert.equal(audit.checks.audioUrls, true);
  assert.equal(audit.checks.fts, true);
  assert.equal(audit.checks.comments, true);
  assert.equal(audit.checks.operations, true);
  assert.equal(audit.counts.articles, 1);
  assert.equal(audit.counts.audioFiles, 1);
  fixture.db.close();
});

test('audit-localized-content CLI exits zero on a migrated fixture and non-zero on regressions', async t => {
  const mp3 = validMp3();
  const fixture = buildV3Fixture(t, { articles: [exampleArticleData(mp3)] });
  const { root } = fixture;
  applyLocalizedContentMigration(fixture.db, fixture.options);
  const result = runNode(root, AUDIT_CLI);
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  const okJson = JSON.parse(result.stdout);
  assert.equal(okJson.audited, true);
  assert.deepEqual(okJson.errors, []);

  fs.writeFileSync(path.join(root, 'articles', 'stray.md'), '# stray');
  const bad = runNode(root, AUDIT_CLI);
  assert.notEqual(bad.status, 0, 'auditor must fail on legacy markdown residue');
  const badJson = JSON.parse(bad.stdout);
  assert.equal(badJson.audited, true);
  assert.equal(badJson.passed, false);
  assert.ok(badJson.errors.some(error => error.check === 'legacyLayout'));
});

test('audit-localized-content reports legacy audio, stale FTS, legacy URLs, and operation residue', t => {
  const mp3 = validMp3();
  const hash = sha256(mp3);
  const fixture = buildV3Fixture(t, { articles: [exampleArticleData(mp3)] });
  const { root, db, options } = fixture;
  applyLocalizedContentMigration(db, options);

  // 1) A live legacy audio file with matching content recreated by a writer.
  fs.mkdirSync(path.join(root, 'public', 'audio', 'example'), { recursive: true });
  fs.writeFileSync(path.join(root, 'public', 'audio', 'example', `${hash}.mp3`), mp3);
  let audit = auditLocalizedContent(db, options);
  assert.equal(audit.passed, false, JSON.stringify(audit.errors));
  assert.ok(audit.errors.some(error => error.check === 'legacyLayout'));
  fs.rmSync(path.join(root, 'public', 'audio', 'example'), { recursive: true, force: true });

  // 2) A legacy URL in stored HTML.
  db.prepare('UPDATE articles SET html = ? WHERE id = 1').run(`<a href="/audio/example/${hash}.mp3">x</a>`);
  audit = auditLocalizedContent(db, options);
  assert.equal(audit.passed, false);
  assert.ok(audit.errors.some(error => error.check === 'audioUrls' && /legacy/.test(error.message)));
  db.prepare('UPDATE articles SET html = ? WHERE id = 1').run(localizedAudioHtml({ slug: 'example', hash }));

  // 3) Stale FTS taxonomy text.
  db.prepare("UPDATE article_fts SET taxonomy = '陈旧分类文本' WHERE rowid = 1").run();
  audit = auditLocalizedContent(db, options);
  assert.equal(audit.passed, false);
  assert.ok(audit.errors.some(error => error.check === 'fts'));
  const { rebuildArticleSearchIndex } = require('../server/articles/search-index');
  rebuildArticleSearchIndex(db);

  // 4) Operation residue (incomplete manifest) and a stale shared lock.
  fs.mkdirSync(path.join(options.operationsDir, 'ghost-op'), { recursive: true });
  fs.writeFileSync(path.join(options.operationsDir, 'ghost-op', 'operation.json'), JSON.stringify({
    schema: 1, operationId: 'ghost-op', type: 'content-migrate', phase: 'prepared',
    createdAt: new Date().toISOString(), files: []
  }));
  audit = auditLocalizedContent(db, options);
  assert.equal(audit.passed, false);
  assert.ok(audit.errors.some(error => error.check === 'operations' && /ghost-op/.test(error.message)));
  fs.rmSync(path.join(options.operationsDir, 'ghost-op'), { recursive: true, force: true });
  fs.mkdirSync(path.join(options.operationsDir, 'active.lock'), { recursive: true });
  fs.writeFileSync(path.join(options.operationsDir, 'active.lock', 'owner.json'), JSON.stringify({
    pid: 999999999, hostname: 'test', operationId: 'dead', type: 'content-migrate', acquiredAt: new Date().toISOString()
  }));
  audit = auditLocalizedContent(db, options);
  assert.equal(audit.passed, false);
  assert.ok(audit.errors.some(error => error.check === 'operations'));
  db.close();
});

test('audit-localized-content reports orphaned posts, dangling comments, and unreferenced audio', t => {
  const mp3 = validMp3();
  const fixture = buildV3Fixture(t, { articles: [exampleArticleData(mp3)] });
  const { root, db, options } = fixture;
  applyLocalizedContentMigration(db, options);

  db.prepare("INSERT INTO posts (translation_key, created_at, updated_at) VALUES ('orphan-post', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')").run();
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT NOT NULL UNIQUE);
    CREATE TABLE IF NOT EXISTS comment_users (
      id INTEGER PRIMARY KEY AUTOINCREMENT, provider TEXT NOT NULL, subject TEXT NOT NULL,
      display_name TEXT NOT NULL, avatar_url TEXT, created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS comments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      article_id INTEGER NOT NULL REFERENCES articles(id) ON DELETE CASCADE,
      comment_user_id INTEGER NOT NULL REFERENCES comment_users(id) ON DELETE RESTRICT,
      content TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending',
      created_at TEXT NOT NULL, reviewed_at TEXT, reviewed_by INTEGER
    );
  `);
  db.prepare("INSERT INTO users (username) VALUES ('admin')").run();
  db.prepare(`INSERT INTO comment_users (provider, subject, display_name, created_at)
    VALUES ('google', 'audit-commenter', 'Audit Commenter', '2026-01-01T00:00:00.000Z')`).run();
  db.pragma('foreign_keys = OFF');
  db.prepare(`INSERT INTO comments (article_id, comment_user_id, content, status, created_at)
    VALUES (999, 1, 'dangling', 'pending', '2026-01-01T00:00:00.000Z')`).run();
  db.pragma('foreign_keys = ON');
  let audit = auditLocalizedContent(db, options);
  assert.equal(audit.passed, false);
  assert.ok(audit.errors.some(error => error.check === 'comments'));

  db.prepare('DELETE FROM comments').run();
  db.prepare('DELETE FROM comment_users').run();

  // Unreferenced live locale-owned audio file.
  fs.mkdirSync(path.join(root, 'public', 'audio', 'zh', 'example'), { recursive: true });
  fs.writeFileSync(path.join(root, 'public', 'audio', 'zh', 'example', `${'c'.repeat(64)}.mp3`), validMp3());
  audit = auditLocalizedContent(db, options);
  assert.equal(audit.passed, false);
  assert.ok(audit.errors.some(error => error.check === 'audioUrls' && /unreferenced|referenced/i.test(error.message)));

  // Missing localized markdown file.
  fs.rmSync(path.join(root, 'articles', 'zh', 'example.md'));
  audit = auditLocalizedContent(db, options);
  assert.equal(audit.passed, false);
  assert.ok(audit.errors.some(error => error.check === 'articles' && /markdown/i.test(error.message)));
  db.close();
});

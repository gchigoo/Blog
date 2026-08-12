'use strict';

const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');
const Database = require('better-sqlite3');

const markdownUtils = require('../server/utils/markdown');
const {
  ALLOWED_ENGLISH_CJK_LITERALS,
  auditTranslationRelease,
  extractExternalUrls,
  extractFencedCode,
  extractTableShapes,
  extractTechnicalTokens,
  historicalHtmlFingerprintMatches,
  loadReleaseManifest,
  loadShaManifest,
  stripNonProse
} = require('../scripts/audit-translation-release');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const SCRIPT_PATH = path.join(PROJECT_ROOT, 'scripts', 'audit-translation-release.js');
const TRACKED_RELEASE_PATH = path.join(PROJECT_ROOT, 'content', 'releases', 'english-articles-2026-08-04.json');
const PACKAGE_PATH = path.join(PROJECT_ROOT, 'package.json');
const CHECKS = Object.freeze({
  bundle: 'bundleIntegrity',
  cjk: 'cjkProse',
  databaseCounts: 'databaseCounts',
  databaseFiles: 'databaseFiles',
  fencedCode: 'fencedCode',
  headings: 'headingLevels',
  images: 'images',
  lists: 'lists',
  metadata: 'englishMetadata',
  rawHtml: 'rawHtml',
  siblings: 'siblings',
  sourceArchives: 'sourceArchives',
  tables: 'tableShapes',
  technicalTokens: 'technicalTokens',
  urls: 'externalUrls'
});

const RELEASE = Object.freeze({
  version: 1,
  articles: Object.freeze([
    Object.freeze({
      translationKey: '9102',
      zhSlug: '9102',
      enSlug: 'understanding-fast-charging',
      enTitle: 'It’s 2019—Are You Still Using Apple’s 5V/1A Charger?',
      description: 'A practical introduction to fast charging, the electrical principles behind it, and the major charging protocols in use in 2019.',
      date: '2019-12-15T01:18:00.000Z',
      tags: Object.freeze(['consumer-electronics', 'explainers', 'charging', 'apple'])
    }),
    Object.freeze({
      translationKey: 'baiduyun-speed-limit',
      zhSlug: 'baiduyun-speed-limit',
      enSlug: 'baidu-netdisk-speed-limit-guide',
      enTitle: 'Baidu Netdisk Throttling You? You May Be Downloading the Wrong Way!',
      description: 'A step-by-step guide to downloading Baidu Netdisk files with Chrome, IDM, Tampermonkey, and a download-assistant script.',
      date: '2019-09-08T09:12:00.000Z',
      tags: Object.freeze(['tutorials', 'tools', 'baidu-netdisk', 'idm', 'tampermonkey'])
    }),
    Object.freeze({
      translationKey: 'apps-in-my-iphone-1784032269347',
      zhSlug: 'apps-in-my-iphone-1784032269347',
      enSlug: 'my-essential-iphone-apps',
      enTitle: 'Apps on My iPhone',
      description: 'A personal list of recommended iPhone apps for tools, daily life, media, learning, finance, and productivity.',
      date: '2019-09-01T16:02:00.000Z',
      tags: Object.freeze(['app', 'iphone', 'ios', 'tools', 'productivity'])
    }),
    Object.freeze({
      translationKey: 'home-assistant-nuc9-to-mac-mini-homekit',
      zhSlug: 'home-assistant-nuc9-to-mac-mini-homekit',
      enSlug: 'migrating-home-assistant-from-nuc9-to-mac-mini',
      enTitle: 'I Moved Home Assistant from a NUC9 to a Mac mini—and HomeKit Taught Me a Lesson',
      description: 'Lessons from moving Home Assistant from a NUC9 to a Mac mini with UTM, HAOS, HomeKit Bridge, and bridged networking.',
      date: '2026-05-10T16:00:00.000Z',
      tags: Object.freeze(['home-assistant', 'homekit', 'mac-mini', 'utm', 'smart-home'])
    })
  ])
});

function cloneRelease() {
  return structuredClone(RELEASE);
}

function sha256(content) {
  return createHash('sha256').update(content).digest('hex');
}

function sortStrings(values) {
  return [...values].sort((left, right) => left < right ? -1 : left > right ? 1 : 0);
}

function documentFor(metadata, body, { omit = [] } = {}) {
  const omitted = new Set(omit);
  return [
    '---',
    `title: ${JSON.stringify(metadata.title)}`,
    `slug: ${JSON.stringify(metadata.slug)}`,
    `locale: ${JSON.stringify(metadata.locale)}`,
    `translationKey: ${JSON.stringify(metadata.translationKey)}`,
    ...(!omitted.has('description') ? [`description: ${JSON.stringify(metadata.description)}`] : []),
    `date: ${JSON.stringify(metadata.date)}`,
    ...(!omitted.has('status') ? [`status: ${JSON.stringify(metadata.status)}`] : []),
    `tags: ${JSON.stringify(metadata.tags)}`,
    '---',
    body
  ].join('\n');
}

function sourceMetadata(record, index) {
  return {
    title: `源文章 ${index + 1}`,
    slug: record.zhSlug,
    locale: 'zh',
    translationKey: record.translationKey,
    description: '',
    date: record.date,
    status: 'published',
    tags: [...record.tags]
  };
}

function englishMetadata(record) {
  return {
    title: record.enTitle,
    slug: record.enSlug,
    locale: 'en',
    translationKey: record.translationKey,
    description: record.description,
    date: record.date,
    status: 'published',
    tags: [...record.tags]
  };
}

function bodyFor(record, index, locale) {
  const headings = locale === 'zh'
    ? ['概览', '步骤', '引用容器标题', '列表容器标题']
    : ['Overview', 'Steps', 'Quoted container heading', 'List container heading'];
  const prose = locale === 'zh'
    ? '这是一段经过审核的中文源文。'
    : 'This is reviewed English prose for the release.';
  const listText = locale === 'zh'
    ? ['第一项', '嵌套甲', '嵌套乙', '第二项', '列表容器']
    : ['First item', 'Nested A', 'Nested B', 'Second item', 'List container'];
  return [
    `# ${headings[0]}`,
    '',
    prose,
    '',
    `Read the [shared reference](https://example.com/release/article-${index + 1}?source=audit).`,
    '',
    `![release diagram](/images/release/article-${index + 1}.png "shared inline title")`,
    `![full reference diagram][full-diagram-${index + 1}]`,
    `![collapsed-diagram-${index + 1}][]`,
    `![shortcut-diagram-${index + 1}]`,
    '',
    'Use USB-PD 3.0 over HTTP/2 at port 443 with 5V, 1A, 18W, 80%, 10MB/s, 20GB, and retries=3.',
    '',
    `## ${headings[1]}`,
    '',
    '```js release-sample',
    'const port = 443;',
    'const retries = 3;',
    '// 中文只存在于代码围栏中',
    '```',
    '',
    '| Item | Value |',
    '| --- | --- |',
    '| protocol | USB-PD |',
    '| endpoint | shared |',
    '',
    `1. ${listText[0]}`,
    `   - ${listText[1]}`,
    `   - ${listText[2]}`,
    `2. ${listText[3]}`,
    '',
    `> ### ${headings[2]}`,
    '>',
    '> ```yaml quoted-fence',
    '> enabled: true',
    '> mode: shared',
    '> ```',
    '>',
    '> | Quote | Shape |',
    '> | --- | --- |',
    '> | alpha | beta |',
    '',
    `- ${listText[4]}`,
    `    ### ${headings[3]}`,
    '',
    '    ```json list-fence',
    '    {"enabled": true}',
    '    ```',
    '',
    '    | List | Shape |',
    '    | --- | --- |',
    '    | gamma | delta |',
    '',
    '`内联代码中的中文不会被当作英文散文。`',
    '',
    '<script>window.releaseAuditPwned = true;</script>',
    '',
    `Release key: ${record.enSlug}.`,
    '',
    `[full-diagram-${index + 1}]: /images/release/article-${index + 1}-full.png "shared full title"`,
    `[collapsed-diagram-${index + 1}]: /images/release/article-${index + 1}-collapsed.png "shared collapsed title"`,
    `[shortcut-diagram-${index + 1}]: /images/release/article-${index + 1}-shortcut.png "shared shortcut title"`,
    ''
  ].join('\n');
}

function createSchema(db) {
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE posts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      translation_key TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE articles (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      post_id INTEGER NOT NULL REFERENCES posts(id),
      locale TEXT NOT NULL,
      title TEXT NOT NULL,
      slug TEXT NOT NULL,
      content TEXT NOT NULL,
      html TEXT NOT NULL,
      status TEXT NOT NULL,
      description TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE article_tags (
      article_id INTEGER NOT NULL REFERENCES articles(id),
      tag_id TEXT NOT NULL
    );
    CREATE VIRTUAL TABLE article_fts USING fts5(title, content, taxonomy);
  `);
}

function insertArticle(db, postId, metadata, raw) {
  const parsed = markdownUtils.parseMarkdownDocument(raw);
  const result = db.prepare(`
    INSERT INTO articles (
      post_id, locale, title, slug, content, html, status, description, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    postId,
    metadata.locale,
    metadata.title,
    metadata.slug,
    parsed.content,
    markdownUtils.renderMarkdown(parsed.content, { locale: metadata.locale }),
    metadata.status,
    metadata.description,
    metadata.date,
    metadata.date
  );
  const articleId = Number(result.lastInsertRowid);
  for (const tag of metadata.tags) {
    db.prepare('INSERT INTO article_tags (article_id, tag_id) VALUES (?, ?)').run(articleId, tag);
  }
  db.prepare('INSERT INTO article_fts(rowid, title, content, taxonomy) VALUES (?, ?, ?, ?)')
    .run(articleId, metadata.title, parsed.content, metadata.tags.join(' '));
  return articleId;
}

function writeShaManifest(bundleDir) {
  const lines = fs.readdirSync(bundleDir)
    .filter(name => name.endsWith('.md'))
    .sort()
    .map(name => `${sha256(fs.readFileSync(path.join(bundleDir, name)))}  ${name}`);
  fs.writeFileSync(path.join(bundleDir, 'SHA256SUMS'), `${lines.join('\n')}\n`);
}

function createFixture(t, { mode = 'source' } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'translation-release-audit-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const articlesDir = path.join(root, 'articles');
  const bundleDir = path.join(root, 'bundle');
  fs.mkdirSync(path.join(articlesDir, 'zh'), { recursive: true });
  fs.mkdirSync(path.join(articlesDir, 'en'), { recursive: true });
  fs.mkdirSync(bundleDir, { recursive: true });
  const releasePath = path.join(root, 'release.json');
  fs.writeFileSync(releasePath, `${JSON.stringify(RELEASE, null, 2)}\n`);

  const dbPath = path.join(root, 'blog.db');
  const db = new Database(dbPath);
  createSchema(db);
  const articleIds = [];
  for (const [index, record] of RELEASE.articles.entries()) {
    const sourceMetadataRecord = sourceMetadata(record, index);
    const source = documentFor(
      sourceMetadataRecord,
      bodyFor(record, index, 'zh'),
      { omit: ['description', 'status'] }
    );
    const english = documentFor(englishMetadata(record), bodyFor(record, index, 'en'));
    fs.writeFileSync(path.join(articlesDir, 'zh', `${record.zhSlug}.md`), source);
    fs.writeFileSync(path.join(bundleDir, `${record.enSlug}.md`), english);
    const postId = Number(db.prepare(
      'INSERT INTO posts (translation_key, created_at, updated_at) VALUES (?, ?, ?)'
    ).run(record.translationKey, record.date, record.date).lastInsertRowid);
    const zhId = insertArticle(db, postId, sourceMetadataRecord, source);
    const ids = { postId, zhId, enId: null };
    if (mode === 'published') {
      fs.writeFileSync(path.join(articlesDir, 'en', `${record.enSlug}.md`), english);
      ids.enId = insertArticle(db, postId, englishMetadata(record), english);
    }
    articleIds.push(ids);
  }
  writeShaManifest(bundleDir);
  db.close();

  return {
    root,
    dbPath,
    articlesDir,
    bundleDir,
    releasePath,
    mode,
    articleIds,
    options: { dbPath, articlesDir, bundleDir, releasePath, mode }
  };
}

function rewriteDocument(filePath, mutateMetadata, mutateBody = body => body) {
  const parsed = markdownUtils.parseMarkdownDocument(fs.readFileSync(filePath, 'utf8'));
  const metadata = {
    title: parsed.data.title,
    slug: parsed.data.slug,
    locale: parsed.data.locale,
    translationKey: parsed.data.translationKey,
    description: parsed.data.description,
    date: parsed.data.date,
    status: parsed.data.status,
    tags: [...parsed.data.tags]
  };
  if (mutateMetadata) mutateMetadata(metadata);
  fs.writeFileSync(filePath, documentFor(metadata, mutateBody(parsed.content)));
}

function rewriteEnglish(fixture, index, mutateMetadata, mutateBody = body => body) {
  const record = RELEASE.articles[index];
  rewriteDocument(
    path.join(fixture.bundleDir, `${record.enSlug}.md`),
    mutateMetadata,
    mutateBody
  );
  writeShaManifest(fixture.bundleDir);
}

function rewriteSource(fixture, index, mutateMetadata, mutateBody = body => body) {
  const record = RELEASE.articles[index];
  rewriteDocument(
    path.join(fixture.articlesDir, 'zh', `${record.zhSlug}.md`),
    mutateMetadata,
    mutateBody
  );
}

function rewriteRawEnglish(fixture, index, transform) {
  const record = RELEASE.articles[index];
  const filePath = path.join(fixture.bundleDir, `${record.enSlug}.md`);
  fs.writeFileSync(filePath, transform(fs.readFileSync(filePath, 'utf8')));
  writeShaManifest(fixture.bundleDir);
}

function rewriteRawSource(fixture, index, transform) {
  const record = RELEASE.articles[index];
  const filePath = path.join(fixture.articlesDir, 'zh', `${record.zhSlug}.md`);
  fs.writeFileSync(filePath, transform(fs.readFileSync(filePath, 'utf8')));
}

function openFixtureDb(fixture) {
  return new Database(fixture.dbPath);
}

function assertAuditFailure(report, check) {
  assert.equal(report.passed, false, 'audit should fail');
  assert.equal(report.checks[check], false, JSON.stringify(report, null, 2));
  assert.ok(report.errors.some(error => error.check === check), JSON.stringify(report.errors, null, 2));
}

function runCli(fixture, args = []) {
  return spawnSync(process.execPath, [SCRIPT_PATH, ...args], {
    cwd: fixture.root,
    encoding: 'utf8'
  });
}

test('source-mode happy path passes with a deterministic report', t => {
  const fixture = createFixture(t);
  const report = auditTranslationRelease({
    dbPath: path.join(fixture.root, 'blog.db'),
    articlesDir: path.join(fixture.root, 'articles'),
    bundleDir: path.join(fixture.root, 'bundle'),
    releasePath: path.join(fixture.root, 'release.json'),
    mode: 'source'
  });
  assert.equal(report.passed, true, JSON.stringify(report.errors));
  assert.equal(report.mode, 'source');
  assert.deepEqual(report.counts, {
    manifestArticles: 4,
    bundleMarkdownFiles: 4,
    posts: 4,
    articles: 4,
    zhArticles: 4,
    enArticles: 0,
    ftsRows: 4,
    sourceArchives: 4,
    publishedArchives: 0
  });
  assert.deepEqual(report.errors, []);
  assert.deepEqual(report, auditTranslationRelease(fixture.options));
});

test('published-mode happy path passes with exact sibling and FTS counts', t => {
  const fixture = createFixture(t, { mode: 'published' });
  const report = auditTranslationRelease(fixture.options);
  assert.equal(report.passed, true, JSON.stringify(report.errors));
  assert.equal(report.mode, 'published');
  assert.equal(report.counts.posts, 4);
  assert.equal(report.counts.articles, 8);
  assert.equal(report.counts.ftsRows, 8);
  assert.equal(report.counts.zhArticles, 4);
  assert.equal(report.counts.enArticles, 4);
  assert.equal(report.counts.publishedArchives, 4);
});

test('tracked release manifest is the exact approved four-record artifact with no extra keys', () => {
  const raw = fs.readFileSync(TRACKED_RELEASE_PATH, 'utf8');
  const tracked = JSON.parse(raw);
  assert.deepEqual(tracked, RELEASE);
  assert.deepEqual(Object.keys(tracked), ['version', 'articles']);
  for (const article of tracked.articles) {
    assert.deepEqual(Object.keys(article), [
      'translationKey', 'zhSlug', 'enSlug', 'enTitle', 'description', 'date', 'tags'
    ]);
  }
});

test('package exposes the exact tracked translation release audit command', () => {
  const pkg = JSON.parse(fs.readFileSync(PACKAGE_PATH, 'utf8'));
  assert.equal(pkg.scripts['audit-translation-release'], 'node scripts/audit-translation-release.js');
});

test('release manifest loader validates the exact schema and deeply freezes its result', t => {
  const fixture = createFixture(t);
  const manifest = loadReleaseManifest(fixture.releasePath);
  assert.deepEqual(manifest, RELEASE);
  assert.ok(Object.isFrozen(manifest));
  assert.ok(Object.isFrozen(manifest.articles));
  assert.ok(Object.isFrozen(manifest.articles[0]));
  assert.ok(Object.isFrozen(manifest.articles[0].tags));
  assert.throws(() => {
    manifest.articles[0].tags.push('mutation');
  }, TypeError);
});

const invalidManifestCases = [
  ['unknown top-level keys', release => { release.extra = true; }, /unknown key "extra"/],
  ['unknown article keys', release => { release.articles[0].extra = true; }, /unknown key "extra"/],
  ['duplicate translation keys', release => { release.articles[1].translationKey = release.articles[0].translationKey; }, /duplicate translationKey/],
  ['duplicate Chinese slugs', release => { release.articles[1].zhSlug = release.articles[0].zhSlug; }, /duplicate zhSlug/],
  ['duplicate English slugs', release => { release.articles[1].enSlug = release.articles[0].enSlug; }, /duplicate enSlug/],
  ['unsafe translation keys', release => { release.articles[0].translationKey = '../unsafe'; }, /unsafe translationKey/],
  ['unsafe Chinese slugs', release => { release.articles[0].zhSlug = 'Unsafe Slug'; }, /unsafe zhSlug/],
  ['unsafe English slugs', release => { release.articles[0].enSlug = '/absolute'; }, /unsafe enSlug/],
  ['unsupported locales', release => { release.articles[0].locale = 'fr'; }, /unsupported locale/],
  ['empty descriptions', release => { release.articles[0].description = '  '; }, /description must not be empty/],
  ['legacy tag ids', release => { release.articles[0].tags.push('legacy-deadbeef'); }, /legacy tag/],
  ['malformed ISO dates', release => { release.articles[0].date = '2019-12-15'; }, /ISO date/],
  ['invalid calendar dates', release => { release.articles[0].date = '2019-99-15T01:18:00.000Z'; }, /ISO date/]
];

for (const [name, mutate, expected] of invalidManifestCases) {
  test(`release manifest rejects ${name}`, t => {
    const fixture = createFixture(t);
    const release = cloneRelease();
    mutate(release);
    fs.writeFileSync(fixture.releasePath, JSON.stringify(release));
    assert.throws(() => loadReleaseManifest(fixture.releasePath), expected);
  });
}

test('release audit requires exactly the four tracked manifest records', t => {
  const fixture = createFixture(t);
  const release = cloneRelease();
  release.articles.pop();
  fs.writeFileSync(fixture.releasePath, JSON.stringify(release));
  assertAuditFailure(auditTranslationRelease(fixture.options), 'releaseManifest');
});

test('SHA manifest loader returns a filename-to-hash Map for the exact bundle', t => {
  const fixture = createFixture(t);
  const hashes = loadShaManifest(fixture.bundleDir);
  assert.ok(hashes instanceof Map);
  assert.deepEqual([...hashes.keys()], sortStrings(RELEASE.articles.map(record => `${record.enSlug}.md`)));
  for (const [filename, hash] of hashes) {
    assert.equal(hash, sha256(fs.readFileSync(path.join(fixture.bundleDir, filename))));
  }
});

const invalidBundleCases = [
  ['unsorted lines', fixture => {
    const shaPath = path.join(fixture.bundleDir, 'SHA256SUMS');
    const lines = fs.readFileSync(shaPath, 'utf8').trimEnd().split('\n').reverse();
    fs.writeFileSync(shaPath, `${lines.join('\n')}\n`);
  }, /sorted/],
  ['duplicate entries', fixture => {
    const shaPath = path.join(fixture.bundleDir, 'SHA256SUMS');
    const lines = fs.readFileSync(shaPath, 'utf8').trimEnd().split('\n');
    fs.writeFileSync(shaPath, `${lines[0]}\n${lines[0]}\n${lines.slice(1).join('\n')}\n`);
  }, /duplicate/],
  ['unsafe basenames', fixture => {
    fs.writeFileSync(path.join(fixture.bundleDir, 'SHA256SUMS'), `${'a'.repeat(64)}  ../unsafe.md\n`);
  }, /unsafe basename/],
  ['non-Markdown entries', fixture => {
    fs.writeFileSync(path.join(fixture.bundleDir, 'SHA256SUMS'), `${'a'.repeat(64)}  archive.zip\n`);
  }, /Markdown/],
  ['invalid hashes', fixture => {
    const shaPath = path.join(fixture.bundleDir, 'SHA256SUMS');
    fs.writeFileSync(shaPath, fs.readFileSync(shaPath, 'utf8').replace(/^[a-f0-9]{64}/, 'not-a-hash'));
  }, /hash/],
  ['symlinks', fixture => {
    const record = RELEASE.articles[0];
    const filePath = path.join(fixture.bundleDir, `${record.enSlug}.md`);
    fs.unlinkSync(filePath);
    fs.symlinkSync(path.join(fixture.articlesDir, 'zh', `${record.zhSlug}.md`), filePath);
  }, /symlink/],
  ['hidden files', fixture => {
    fs.writeFileSync(path.join(fixture.bundleDir, '.hidden.md'), 'hidden');
  }, /hidden/],
  ['subdirectories', fixture => {
    fs.mkdirSync(path.join(fixture.bundleDir, 'nested'));
  }, /subdirectory/],
  ['extra archives', fixture => {
    fs.writeFileSync(path.join(fixture.bundleDir, 'release.zip'), 'archive');
  }, /extra file/],
  ['extra unsigned Markdown files', fixture => {
    fs.writeFileSync(path.join(fixture.bundleDir, 'extra.md'), 'extra');
  }, /extra file/]
];

for (const [name, mutate, expected] of invalidBundleCases) {
  test(`SHA manifest rejects ${name}`, t => {
    const fixture = createFixture(t);
    mutate(fixture);
    assert.throws(() => loadShaManifest(fixture.bundleDir), expected);
  });
}

test('SHA manifest rejects a symlinked bundle root', t => {
  const fixture = createFixture(t);
  const realBundle = path.join(fixture.root, 'bundle-real');
  fs.renameSync(fixture.bundleDir, realBundle);
  fs.symlinkSync(realBundle, fixture.bundleDir);
  assert.throws(() => loadShaManifest(fixture.bundleDir), /bundle root.*symlink/i);
});

test('focused extraction helpers preserve ordered structures and strip non-prose CJK', () => {
  const markdown = [
    '[first](https://one.example/path)',
    '![excluded](https://images.example/image.png)',
    '<https://two.example/path>',
    '[reference link][shared-ref]',
    '![reference image][shared-image]',
    '',
    '```js exact-info',
    'const value = 1;\r',
    '```',
    '',
    '~~~text',
    'body',
    '~~~',
    '',
    '| A | B |',
    '| --- | --- |',
    '| 1 | 2 |',
    '| 3 | 4 |',
    '',
    '`内联中文` [English](https://example.com/中文) ![English](https://example.com/图片)',
    'USB-PD 3.0 over HTTP/2 at port 443: 5V, 1A, 18W, 80%, 10MB/s, 20GB, retries=3.',
    '',
    '[shared-ref]: https://reference.example/path',
    '[shared-image]: https://images.example/reference.png'
  ].join('\n');
  assert.deepEqual(extractExternalUrls(markdown), [
    'https://one.example/path',
    'https://two.example/path',
    'https://reference.example/path',
    'https://example.com/中文'
  ]);
  assert.deepEqual(extractFencedCode(markdown), [
    { info: 'js exact-info', body: 'const value = 1;\r\n' },
    { info: 'text', body: 'body\n' }
  ]);
  assert.deepEqual(extractTableShapes(markdown), [{ columns: 2, rows: 3 }]);
  const technical = extractTechnicalTokens(markdown);
  assert.deepEqual(technical, sortStrings(technical));
  for (const expected of ['USB-PD', '3.0', 'HTTP/2', 'port:443', '5V', '1A', '18W', '80%', '10MB/s', '20GB', 'retries=3']) {
    assert.ok(technical.includes(expected), `missing technical token ${expected}: ${technical.join(', ')}`);
  }
  assert.doesNotMatch(stripNonProse(markdown), /\p{Script=Han}/u);
  assert.deepEqual(ALLOWED_ENGLISH_CJK_LITERALS, []);
  assert.ok(Object.isFrozen(ALLOWED_ENGLISH_CJK_LITERALS));
});

test('structure helpers recognize fenced code and tables inside blockquote and list containers', () => {
  const markdown = [
    '> ```js quoted',
    '> const quoted = true;\r',
    '> ```',
    '>',
    '> | A | B |',
    '> | --- | --- |',
    '> | one | two |',
    '',
    '- item',
    '',
    '    ```json listed',
    '    {"listed": true}',
    '    ```',
    '',
    '    | C | D |',
    '    | --- | --- |',
    '    | three | four |'
  ].join('\n');
  assert.deepEqual(extractFencedCode(markdown), [
    { info: 'js quoted', body: 'const quoted = true;\r\n' },
    { info: 'json listed', body: '{"listed": true}\n' }
  ]);
  assert.deepEqual(extractTableShapes(markdown), [
    { columns: 2, rows: 2 },
    { columns: 2, rows: 2 }
  ]);
});

test('audit rejects a missing bundle Markdown file', t => {
  const fixture = createFixture(t);
  fs.unlinkSync(path.join(fixture.bundleDir, `${RELEASE.articles[0].enSlug}.md`));
  assertAuditFailure(auditTranslationRelease(fixture.options), CHECKS.bundle);
});

test('audit rejects an extra bundle file', t => {
  const fixture = createFixture(t);
  fs.writeFileSync(path.join(fixture.bundleDir, 'extra.md'), 'extra');
  assertAuditFailure(auditTranslationRelease(fixture.options), CHECKS.bundle);
});

test('audit rejects a SHA256SUMS mismatch', t => {
  const fixture = createFixture(t);
  const filePath = path.join(fixture.bundleDir, `${RELEASE.articles[0].enSlug}.md`);
  fs.appendFileSync(filePath, '\nchanged after hashing\n');
  assertAuditFailure(auditTranslationRelease(fixture.options), CHECKS.bundle);
});

test('audit rejects duplicate SHA256SUMS entries', t => {
  const fixture = createFixture(t);
  const shaPath = path.join(fixture.bundleDir, 'SHA256SUMS');
  const lines = fs.readFileSync(shaPath, 'utf8').trimEnd().split('\n');
  fs.writeFileSync(shaPath, `${lines[0]}\n${lines[0]}\n${lines.slice(1).join('\n')}\n`);
  assertAuditFailure(auditTranslationRelease(fixture.options), CHECKS.bundle);
});

test('audit rejects unsafe symlinks and hidden bundle files', t => {
  const fixture = createFixture(t);
  fs.writeFileSync(path.join(fixture.bundleDir, '.hidden'), 'hidden');
  assertAuditFailure(auditTranslationRelease(fixture.options), CHECKS.bundle);
});

const metadataMutations = [
  ['title', metadata => { metadata.title = 'Wrong title'; }],
  ['slug', metadata => { metadata.slug = 'wrong-safe-slug'; }],
  ['translationKey', metadata => { metadata.translationKey = 'wrong-translation-key'; }],
  ['date', metadata => { metadata.date = '2026-01-02T03:04:05.000Z'; }],
  ['status', metadata => { metadata.status = 'draft'; }],
  ['description', metadata => { metadata.description = 'Wrong description'; }],
  ['tags', metadata => { metadata.tags = metadata.tags.slice(1); }],
  ['locale', metadata => { metadata.locale = 'zh'; }]
];

for (const [field, mutate] of metadataMutations) {
  test(`audit rejects wrong English ${field}`, t => {
    const fixture = createFixture(t);
    rewriteEnglish(fixture, 0, mutate);
    assertAuditFailure(auditTranslationRelease(fixture.options), CHECKS.metadata);
  });
}

test('audit rejects legacy-* English tags', t => {
  const fixture = createFixture(t);
  rewriteEnglish(fixture, 0, metadata => { metadata.tags.push('legacy-deadbeef'); });
  assertAuditFailure(auditTranslationRelease(fixture.options), CHECKS.metadata);
});

test('English audit accepts publisher-generated folded YAML with exact values', t => {
  const fixture = createFixture(t);
  const record = RELEASE.articles[3];
  const filePath = path.join(fixture.bundleDir, `${record.enSlug}.md`);
  const parsed = markdownUtils.parseMarkdownDocument(fs.readFileSync(filePath, 'utf8'));
  fs.writeFileSync(filePath, markdownUtils.serializeMarkdownDocument(parsed.content, englishMetadata(record)));
  writeShaManifest(fixture.bundleDir);
  const report = auditTranslationRelease(fixture.options);
  assert.equal(report.passed, true, JSON.stringify(report.errors));
});

test('source audit accepts omitted raw description and status with normalized defaults', t => {
  const fixture = createFixture(t);
  const report = auditTranslationRelease(fixture.options);
  assert.equal(report.passed, true, JSON.stringify(report.errors));
});

test('source audit rejects explicit non-default description or status', t => {
  const fixture = createFixture(t);
  rewriteRawSource(fixture, 0, raw => raw.replace(
    /^date: .*$/m,
    'description: "unexpected"\nstatus: draft\n$&'
  ));
  assertAuditFailure(auditTranslationRelease(fixture.options), CHECKS.sourceArchives);
});

test('source audit rejects omitted raw locale and translationKey instead of accepting parser defaults', t => {
  const fixture = createFixture(t);
  rewriteRawSource(fixture, 0, raw => raw
    .replace(/^locale: .*\n/m, '')
    .replace(/^translationKey: .*\n/m, ''));
  assertAuditFailure(auditTranslationRelease(fixture.options), CHECKS.sourceArchives);
});

const rawEnglishMetadataBypasses = [
  ['omitted status', raw => raw.replace(/^status: .*\n/m, '')],
  ['noncanonical equivalent date', raw => raw.replace(
    /^date: .*$/m,
    'date: "2019-12-14T20:18:00-05:00"'
  )],
  ['comma-separated tag string', raw => raw.replace(
    /^tags: .*$/m,
    'tags: "consumer-electronics, explainers, charging, apple"'
  )],
  ['duplicate tag array', raw => raw.replace(
    /^tags: .*$/m,
    'tags: ["consumer-electronics", "explainers", "charging", "apple", "apple"]'
  )],
  ['whitespace-normalized tag', raw => raw.replace(
    /^tags: .*$/m,
    'tags: [" consumer-electronics ", "explainers", "charging", "apple"]'
  )]
];

for (const [name, transform] of rawEnglishMetadataBypasses) {
  test(`English audit rejects raw front matter with ${name}`, t => {
    const fixture = createFixture(t);
    rewriteRawEnglish(fixture, 0, transform);
    assertAuditFailure(auditTranslationRelease(fixture.options), CHECKS.metadata);
  });
}

test('audit rejects a source/English image URL multiset mismatch', t => {
  const fixture = createFixture(t);
  rewriteEnglish(fixture, 0, null, body => body.replace('/images/release/article-1.png', '/images/release/different.png'));
  assertAuditFailure(auditTranslationRelease(fixture.options), CHECKS.images);
});

test('audit rejects a full-reference image destination mismatch', t => {
  const fixture = createFixture(t);
  rewriteEnglish(fixture, 0, null, body => body.replace(
    '/images/release/article-1-full.png',
    '/images/release/different-full.png'
  ));
  assertAuditFailure(auditTranslationRelease(fixture.options), CHECKS.images);
});

test('audit rejects a collapsed-reference image destination mismatch', t => {
  const fixture = createFixture(t);
  rewriteEnglish(fixture, 0, null, body => body.replace(
    '/images/release/article-1-collapsed.png',
    '/images/release/different-collapsed.png'
  ));
  assertAuditFailure(auditTranslationRelease(fixture.options), CHECKS.images);
});

test('audit rejects a shortcut-reference image destination mismatch', t => {
  const fixture = createFixture(t);
  rewriteEnglish(fixture, 0, null, body => body.replace(
    '/images/release/article-1-shortcut.png',
    '/images/release/different-shortcut.png'
  ));
  assertAuditFailure(auditTranslationRelease(fixture.options), CHECKS.images);
});

test('audit compares only inline image destinations and permits translated optional titles', t => {
  const fixture = createFixture(t);
  rewriteEnglish(fixture, 0, null, body => body.replace('shared inline title', 'translated optional title'));
  const report = auditTranslationRelease(fixture.options);
  assert.equal(report.passed, true, JSON.stringify(report.errors));
});

test('audit rejects an external HTTP(S) URL multiset mismatch', t => {
  const fixture = createFixture(t);
  rewriteEnglish(fixture, 0, null, body => body.replace('https://example.com/release/article-1?source=audit', 'https://example.net/different'));
  assertAuditFailure(auditTranslationRelease(fixture.options), CHECKS.urls);
});

test('audit rejects fenced code info-string mismatches', t => {
  const fixture = createFixture(t);
  rewriteEnglish(fixture, 0, null, body => body.replace('```js release-sample', '```js changed-info'));
  assertAuditFailure(auditTranslationRelease(fixture.options), CHECKS.fencedCode);
});

test('audit rejects fenced code body-byte mismatches with unchanged info and technical tokens', t => {
  const fixture = createFixture(t);
  rewriteEnglish(fixture, 0, null, body => body.replace('const retries = 3;', 'let retries = 3;'));
  assertAuditFailure(auditTranslationRelease(fixture.options), CHECKS.fencedCode);
});

test('audit accepts the exact approved visible text-fence translation', t => {
  const fixture = createFixture(t);
  const record = RELEASE.articles[3];
  const sourceMutation = body => body
    .replace('```js release-sample', '```text')
    .replace(
      'const port = 443;\nconst retries = 3;\n// 中文只存在于代码围栏中',
      'NUC9 -> PVE -> Home Assistant 虚拟机'
    );
  rewriteSource(fixture, 3, null, sourceMutation);
  const db = openFixtureDb(fixture);
  const sourceRaw = fs.readFileSync(
    path.join(fixture.articlesDir, 'zh', `${record.zhSlug}.md`),
    'utf8'
  );
  const sourceParsed = markdownUtils.parseMarkdownDocument(sourceRaw);
  db.prepare('UPDATE articles SET content = ?, html = ? WHERE id = ?').run(
    sourceParsed.content,
    markdownUtils.renderMarkdown(sourceParsed.content, { locale: 'zh' }),
    fixture.articleIds[3].zhId
  );
  db.close();
  rewriteEnglish(fixture, 3, null, body => body
    .replace('```js release-sample', '```text')
    .replace(
      'const port = 443;\nconst retries = 3;\n// 中文只存在于代码围栏中',
      'NUC9 -> PVE -> Home Assistant VM'
    ));
  const report = auditTranslationRelease(fixture.options);
  assert.equal(report.passed, true, JSON.stringify(report.errors));
  assert.equal(record.translationKey, 'home-assistant-nuc9-to-mac-mini-homekit');
});

test('audit rejects untranslated CJK in visible text fences', t => {
  const fixture = createFixture(t);
  rewriteEnglish(fixture, 0, null, body => body
    .replace('```js release-sample', '```text')
    .replace('const retries = 3;', 'const retries = 3; // 未翻译'));
  assertAuditFailure(auditTranslationRelease(fixture.options), CHECKS.cjk);
});

test('audit rejects any unapproved visible text-fence translation', t => {
  const fixture = createFixture(t);
  rewriteEnglish(fixture, 0, null, body => body
    .replace('```js release-sample', '```text')
    .replace('const retries = 3;', 'let retries = 3;'));
  assertAuditFailure(auditTranslationRelease(fixture.options), CHECKS.fencedCode);
});

test('audit rejects blockquote-contained fenced code body mismatches', t => {
  const fixture = createFixture(t);
  rewriteEnglish(fixture, 0, null, body => body.replace('> mode: shared', '> mode: changed'));
  assertAuditFailure(auditTranslationRelease(fixture.options), CHECKS.fencedCode);
});

test('audit rejects list-contained fenced code body mismatches', t => {
  const fixture = createFixture(t);
  rewriteEnglish(fixture, 0, null, body => body.replace('{"enabled": true}', '{"enabled": false}'));
  assertAuditFailure(auditTranslationRelease(fixture.options), CHECKS.fencedCode);
});

test('audit rejects Markdown table shape mismatches', t => {
  const fixture = createFixture(t);
  rewriteEnglish(fixture, 0, null, body => body.replace('| endpoint | shared |', '| endpoint | shared |\n| extra | row |'));
  assertAuditFailure(auditTranslationRelease(fixture.options), CHECKS.tables);
});

test('audit rejects blockquote-contained Markdown table shape mismatches', t => {
  const fixture = createFixture(t);
  rewriteEnglish(fixture, 0, null, body => body.replace(
    '> | alpha | beta |',
    '> | alpha | beta |\n> | extra | row |'
  ));
  assertAuditFailure(auditTranslationRelease(fixture.options), CHECKS.tables);
});

test('audit rejects list-contained Markdown table shape mismatches', t => {
  const fixture = createFixture(t);
  rewriteEnglish(fixture, 0, null, body => body.replace(
    '    | gamma | delta |',
    '    | gamma | delta |\n    | extra | row |'
  ));
  assertAuditFailure(auditTranslationRelease(fixture.options), CHECKS.tables);
});

test('audit rejects heading-level sequence mismatches', t => {
  const fixture = createFixture(t);
  rewriteEnglish(fixture, 0, null, body => body.replace('## Steps', '### Steps'));
  assertAuditFailure(auditTranslationRelease(fixture.options), CHECKS.headings);
});

test('audit rejects blockquote-contained heading-level mismatches', t => {
  const fixture = createFixture(t);
  rewriteEnglish(fixture, 0, null, body => body.replace('> ### Quoted container heading', '> #### Quoted container heading'));
  assertAuditFailure(auditTranslationRelease(fixture.options), CHECKS.headings);
});

test('audit rejects list-contained heading-level mismatches', t => {
  const fixture = createFixture(t);
  rewriteEnglish(fixture, 0, null, body => body.replace('    ### List container heading', '    #### List container heading'));
  assertAuditFailure(auditTranslationRelease(fixture.options), CHECKS.headings);
});

test('audit rejects ordered list type, nesting, or item-count mismatches', t => {
  const fixture = createFixture(t);
  rewriteEnglish(fixture, 0, null, body => body.replace('   - Nested B', '   1. Nested B'));
  assertAuditFailure(auditTranslationRelease(fixture.options), CHECKS.lists);
});

test('audit rejects blockquote-contained nested-list structure mismatches', t => {
  const fixture = createFixture(t);
  rewriteEnglish(fixture, 0, null, body => body.replace(
    '> | alpha | beta |',
    '> - nested quote item\n>   - nested quote child\n> | alpha | beta |'
  ));
  assertAuditFailure(auditTranslationRelease(fixture.options), CHECKS.lists);
});

test('audit rejects technical-token multiset mismatches', t => {
  const fixture = createFixture(t);
  rewriteEnglish(fixture, 0, null, body => body.replace('18W, 80%', '20W, 80%'));
  assertAuditFailure(auditTranslationRelease(fixture.options), CHECKS.technicalTokens);
});

test('audit rejects untranslated CJK in English prose', t => {
  const fixture = createFixture(t);
  rewriteEnglish(fixture, 0, null, body => `${body}\n这是未翻译的英文散文。\n`);
  assertAuditFailure(auditTranslationRelease(fixture.options), CHECKS.cjk);
});

test('audit proves source raw HTML is escaped and fails if rendering makes it executable', t => {
  const fixture = createFixture(t);
  const originalRender = markdownUtils.renderMarkdown;
  markdownUtils.renderMarkdown = markdown => markdown;
  try {
    assertAuditFailure(auditTranslationRelease(fixture.options), CHECKS.rawHtml);
  } finally {
    markdownUtils.renderMarkdown = originalRender;
  }
});

test('source mode rejects wrong posts/articles/locale/FTS counts', t => {
  const fixture = createFixture(t);
  const db = openFixtureDb(fixture);
  db.prepare('DELETE FROM article_fts WHERE rowid = ?').run(fixture.articleIds[0].zhId);
  db.prepare("INSERT INTO posts (translation_key, created_at, updated_at) VALUES ('extra', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')").run();
  db.close();
  assertAuditFailure(auditTranslationRelease(fixture.options), CHECKS.databaseCounts);
});

test('source mode rejects a missing source archive', t => {
  const fixture = createFixture(t);
  fs.unlinkSync(path.join(fixture.articlesDir, 'zh', `${RELEASE.articles[0].zhSlug}.md`));
  assertAuditFailure(auditTranslationRelease(fixture.options), CHECKS.sourceArchives);
});

test('source mode rejects a symlinked zh locale parent directory', t => {
  const fixture = createFixture(t);
  const outsideZh = path.join(fixture.root, 'outside-zh');
  fs.renameSync(path.join(fixture.articlesDir, 'zh'), outsideZh);
  fs.symlinkSync(outsideZh, path.join(fixture.articlesDir, 'zh'));
  assertAuditFailure(auditTranslationRelease(fixture.options), CHECKS.sourceArchives);
});

test('source mode rejects source archive metadata that does not match the release', t => {
  const fixture = createFixture(t);
  rewriteSource(fixture, 0, metadata => { metadata.tags = metadata.tags.slice(1); });
  assertAuditFailure(auditTranslationRelease(fixture.options), CHECKS.sourceArchives);
});

test('source mode rejects source database/file metadata mismatches', t => {
  const fixture = createFixture(t);
  const db = openFixtureDb(fixture);
  db.prepare('UPDATE articles SET title = ? WHERE id = ?').run('Database drift', fixture.articleIds[0].zhId);
  db.close();
  assertAuditFailure(auditTranslationRelease(fixture.options), CHECKS.databaseFiles);
});

test('source mode accepts the publisher serializer single leading newline and historical external-link rel omission', t => {
  const fixture = createFixture(t);
  const record = RELEASE.articles[0];
  const filePath = path.join(fixture.articlesDir, 'zh', `${record.zhSlug}.md`);
  const raw = fs.readFileSync(filePath, 'utf8');
  const parsed = markdownUtils.parseMarkdownDocument(raw);
  const rewritten = documentFor(sourceMetadata(record, 0), `\n${parsed.content}`, {
    omit: ['description', 'status']
  });
  fs.writeFileSync(filePath, rewritten);
  const db = openFixtureDb(fixture);
  db.prepare('UPDATE articles SET html = replace(html, ?, ?) WHERE id = ?')
    .run(' rel="noopener noreferrer"', '', fixture.articleIds[0].zhId);
  db.close();
  const report = auditTranslationRelease(fixture.options);
  assert.equal(report.passed, true, JSON.stringify(report.errors));
});

test('known historical source HTML matching requires both exact fingerprints', () => {
  const content = 'known historical source body';
  const historicalHtml = '<p><font color="gray">known historical HTML</font></p>';
  const fingerprints = {
    contentSha256: sha256(content),
    htmlSha256: sha256(historicalHtml)
  };
  const article = { html: historicalHtml };

  assert.equal(historicalHtmlFingerprintMatches(article, content, fingerprints), true);
  assert.equal(historicalHtmlFingerprintMatches(article, `${content}\n`, fingerprints), false);
  assert.equal(
    historicalHtmlFingerprintMatches({ html: `${historicalHtml}<!-- drift -->` }, content, fingerprints),
    false
  );
  assert.equal(historicalHtmlFingerprintMatches(article, content, undefined), false);
});

test('source mode rejects exact database content drift independently', t => {
  const fixture = createFixture(t);
  const db = openFixtureDb(fixture);
  db.prepare('UPDATE articles SET content = content || ? WHERE id = ?').run('\ncontent drift', fixture.articleIds[0].zhId);
  db.close();
  assertAuditFailure(auditTranslationRelease(fixture.options), CHECKS.databaseFiles);
});

test('source mode rejects exact rendered HTML drift independently', t => {
  const fixture = createFixture(t);
  const db = openFixtureDb(fixture);
  db.prepare('UPDATE articles SET html = html || ? WHERE id = ?').run('<!-- html drift -->', fixture.articleIds[0].zhId);
  db.close();
  assertAuditFailure(auditTranslationRelease(fixture.options), CHECKS.databaseFiles);
});

test('source mode rejects draft Chinese database articles', t => {
  const fixture = createFixture(t);
  const db = openFixtureDb(fixture);
  db.prepare("UPDATE articles SET status = 'draft' WHERE id = ?").run(fixture.articleIds[0].zhId);
  db.close();
  assertAuditFailure(auditTranslationRelease(fixture.options), CHECKS.databaseCounts);
});

test('source mode rejects any English database article', t => {
  const fixture = createFixture(t);
  const db = openFixtureDb(fixture);
  const record = RELEASE.articles[0];
  const english = documentFor(englishMetadata(record), bodyFor(record, 0, 'en'));
  insertArticle(db, fixture.articleIds[0].postId, englishMetadata(record), english);
  db.close();
  assertAuditFailure(auditTranslationRelease(fixture.options), CHECKS.databaseCounts);
});

test('published mode rejects database/file metadata mismatches', t => {
  const fixture = createFixture(t, { mode: 'published' });
  const db = openFixtureDb(fixture);
  db.prepare('UPDATE articles SET description = ? WHERE id = ?').run('Database drift', fixture.articleIds[0].enId);
  db.close();
  assertAuditFailure(auditTranslationRelease(fixture.options), CHECKS.databaseFiles);
});

test('published mode rejects database/file tag-set mismatches', t => {
  const fixture = createFixture(t, { mode: 'published' });
  const db = openFixtureDb(fixture);
  db.prepare('DELETE FROM article_tags WHERE article_id = ? AND tag_id = ?')
    .run(fixture.articleIds[0].enId, RELEASE.articles[0].tags[0]);
  db.close();
  assertAuditFailure(auditTranslationRelease(fixture.options), CHECKS.databaseFiles);
});

test('published mode rejects a missing published English file', t => {
  const fixture = createFixture(t, { mode: 'published' });
  fs.unlinkSync(path.join(fixture.articlesDir, 'en', `${RELEASE.articles[0].enSlug}.md`));
  assertAuditFailure(auditTranslationRelease(fixture.options), CHECKS.databaseFiles);
});

test('published mode rejects a symlinked en locale parent directory', t => {
  const fixture = createFixture(t, { mode: 'published' });
  const outsideEn = path.join(fixture.root, 'outside-en');
  fs.renameSync(path.join(fixture.articlesDir, 'en'), outsideEn);
  fs.symlinkSync(outsideEn, path.join(fixture.articlesDir, 'en'));
  assertAuditFailure(auditTranslationRelease(fixture.options), CHECKS.databaseFiles);
});

test('published mode rejects duplicate locale siblings per translation key', t => {
  const fixture = createFixture(t, { mode: 'published' });
  const db = openFixtureDb(fixture);
  const record = RELEASE.articles[0];
  const duplicate = documentFor(
    { ...englishMetadata(record), slug: 'duplicate-english-sibling' },
    bodyFor(record, 0, 'en')
  );
  insertArticle(db, fixture.articleIds[0].postId, { ...englishMetadata(record), slug: 'duplicate-english-sibling' }, duplicate);
  db.close();
  assertAuditFailure(auditTranslationRelease(fixture.options), CHECKS.siblings);
});

test('published mode rejects a missing locale sibling per translation key', t => {
  const fixture = createFixture(t, { mode: 'published' });
  const db = openFixtureDb(fixture);
  db.prepare('DELETE FROM article_fts WHERE rowid = ?').run(fixture.articleIds[0].enId);
  db.prepare('DELETE FROM article_tags WHERE article_id = ?').run(fixture.articleIds[0].enId);
  db.prepare('DELETE FROM articles WHERE id = ?').run(fixture.articleIds[0].enId);
  db.close();
  assertAuditFailure(auditTranslationRelease(fixture.options), CHECKS.siblings);
});

test('published mode rejects wrong post and article counts', t => {
  const fixture = createFixture(t, { mode: 'published' });
  const db = openFixtureDb(fixture);
  db.prepare('DELETE FROM article_fts WHERE rowid = ?').run(fixture.articleIds[0].enId);
  db.prepare('DELETE FROM article_tags WHERE article_id = ?').run(fixture.articleIds[0].enId);
  db.prepare('DELETE FROM articles WHERE id = ?').run(fixture.articleIds[0].enId);
  db.prepare("INSERT INTO posts (translation_key, created_at, updated_at) VALUES ('extra', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')").run();
  db.close();
  assertAuditFailure(auditTranslationRelease(fixture.options), CHECKS.databaseCounts);
});

test('published mode rejects wrong FTS counts', t => {
  const fixture = createFixture(t, { mode: 'published' });
  const db = openFixtureDb(fixture);
  db.prepare('DELETE FROM article_fts WHERE rowid = ?').run(fixture.articleIds[0].enId);
  db.close();
  assertAuditFailure(auditTranslationRelease(fixture.options), CHECKS.databaseCounts);
});

test('published mode rejects same-count FTS rows with the wrong row-ID set', t => {
  const fixture = createFixture(t, { mode: 'published' });
  const db = openFixtureDb(fixture);
  const removed = db.prepare('SELECT title, content, taxonomy FROM article_fts WHERE rowid = ?')
    .get(fixture.articleIds[0].enId);
  db.prepare('DELETE FROM article_fts WHERE rowid = ?').run(fixture.articleIds[0].enId);
  db.prepare('INSERT INTO article_fts(rowid, title, content, taxonomy) VALUES (?, ?, ?, ?)')
    .run(9999, removed.title, removed.content, removed.taxonomy);
  db.close();
  assertAuditFailure(auditTranslationRelease(fixture.options), CHECKS.databaseCounts);
});

test('database schema/content failures return an audit report instead of throwing', t => {
  const fixture = createFixture(t);
  const db = openFixtureDb(fixture);
  db.exec('DROP TABLE article_fts');
  db.close();
  assertAuditFailure(auditTranslationRelease(fixture.options), CHECKS.databaseCounts);
});

test('CLI prints deterministic JSON and documents exit codes 0, 2, and 1', t => {
  const fixture = createFixture(t);
  const flags = [
    '--db', fixture.dbPath,
    '--articles', fixture.articlesDir,
    '--release', fixture.releasePath,
    '--bundle', fixture.bundleDir,
    '--mode', 'source'
  ];
  const first = runCli(fixture, flags);
  const second = runCli(fixture, flags);
  assert.equal(first.status, 0, first.stderr || first.stdout);
  assert.equal(first.stderr, '');
  assert.equal(first.stdout, second.stdout);
  assert.equal(JSON.parse(first.stdout).passed, true);

  const bundleFile = path.join(fixture.bundleDir, `${RELEASE.articles[0].enSlug}.md`);
  fs.appendFileSync(bundleFile, '\nmutation\n');
  const auditFailure = runCli(fixture, flags);
  assert.equal(auditFailure.status, 2, auditFailure.stderr || auditFailure.stdout);
  assert.equal(auditFailure.stderr, '');
  assert.equal(JSON.parse(auditFailure.stdout).passed, false);

  const usageFailure = runCli(fixture, ['--unknown', 'value']);
  assert.equal(usageFailure.status, 1, usageFailure.stderr || usageFailure.stdout);
  assert.equal(usageFailure.stderr, '');
  assert.equal(JSON.parse(usageFailure.stdout).errors[0].check, 'usage');

  const missingDbFlags = [...flags];
  missingDbFlags[1] = path.join(fixture.root, 'missing.db');
  const runtimeFailure = runCli(fixture, missingDbFlags);
  assert.equal(runtimeFailure.status, 1, runtimeFailure.stderr || runtimeFailure.stdout);
  assert.equal(runtimeFailure.stderr, '');
  assert.equal(JSON.parse(runtimeFailure.stdout).errors[0].check, 'runtime');
});

'use strict';

const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const test = require('node:test');
const Database = require('better-sqlite3');
const jwt = require('jsonwebtoken');
const matter = require('gray-matter');

const { createProjectFixture, runNode, startServer } = require('./helpers/project-fixture');
const {
  parseArguments,
  publishTranslationRelease,
  readTokenFromFd,
  uploadArticle,
  validateLoopbackBaseUrl
} = require('../scripts/publish-translation-release');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const CLI_PATH = path.join(PROJECT_ROOT, 'scripts', 'publish-translation-release.js');
const PACKAGE_PATH = path.join(PROJECT_ROOT, 'package.json');
const TRACKED_RELEASE_PATH = path.join(
  PROJECT_ROOT,
  'content',
  'releases',
  'english-articles-2026-08-04.json'
);
const NODE_PATH = [path.join(PROJECT_ROOT, 'node_modules'), process.env.NODE_PATH]
  .filter(Boolean)
  .join(path.delimiter);
const JWT_SECRET = 'test-only-jwt-secret-with-at-least-32-characters';
const INITIAL_PASSWORD = 'S3cure!Node24';
const VALID_TOKEN = jwt.sign(
  { id: 1, username: 'admin' },
  JWT_SECRET,
  { algorithm: 'HS256', expiresIn: '5m' }
);
const RELEASE = JSON.parse(fs.readFileSync(TRACKED_RELEASE_PATH, 'utf8'));

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function compareStrings(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function articleDocument(record, locale, index, overrides = {}) {
  const english = locale === 'en';
  const metadata = {
    title: english ? record.enTitle : `源文章 ${index + 1}`,
    slug: english ? record.enSlug : record.zhSlug,
    locale,
    translationKey: record.translationKey,
    description: english ? record.description : `第 ${index + 1} 篇源文章说明`,
    date: record.date,
    status: 'published',
    tags: [...record.tags],
    ...overrides
  };
  return [
    '---',
    `title: ${JSON.stringify(metadata.title)}`,
    `slug: ${JSON.stringify(metadata.slug)}`,
    `locale: ${JSON.stringify(metadata.locale)}`,
    `translationKey: ${JSON.stringify(metadata.translationKey)}`,
    `description: ${JSON.stringify(metadata.description)}`,
    `date: ${JSON.stringify(metadata.date)}`,
    `status: ${JSON.stringify(metadata.status)}`,
    `tags: ${JSON.stringify(metadata.tags)}`,
    '---',
    '',
    `# ${english ? `English release article ${index + 1}` : `中文源文章 ${index + 1}`}`,
    '',
    english
      ? `Searchable English release body ${index + 1} for ${record.translationKey}.`
      : `这是第 ${index + 1} 篇中文源文章。`,
    ''
  ].join('\n');
}

function writeShaManifest(bundleDir) {
  const lines = fs.readdirSync(bundleDir)
    .filter(filename => filename.endsWith('.md'))
    .sort(compareStrings)
    .map(filename => `${sha256(fs.readFileSync(path.join(bundleDir, filename)))}  ${filename}`);
  fs.writeFileSync(path.join(bundleDir, 'SHA256SUMS'), `${lines.join('\n')}\n`);
}

function createReleaseBundle(root) {
  const bundleDir = path.join(root, 'incoming');
  const releasePath = path.join(root, 'release.json');
  fs.mkdirSync(bundleDir, { recursive: true });
  fs.writeFileSync(releasePath, `${JSON.stringify(RELEASE, null, 2)}\n`);
  for (const [index, record] of RELEASE.articles.entries()) {
    fs.writeFileSync(
      path.join(bundleDir, `${record.enSlug}.md`),
      articleDocument(record, 'en', index)
    );
  }
  writeShaManifest(bundleDir);
  return { root, bundleDir, releasePath };
}

function createStandaloneBundle(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'translation-release-publish-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return createReleaseBundle(root);
}

function rewriteBundleArticle(fixture, index, overrides) {
  const record = RELEASE.articles[index];
  fs.writeFileSync(
    path.join(fixture.bundleDir, `${record.enSlug}.md`),
    articleDocument(record, 'en', index, overrides)
  );
  writeShaManifest(fixture.bundleDir);
}

async function uploadSeedArticle(baseUrl, token, filename, markdown) {
  const form = new FormData();
  form.append('file', new Blob([markdown]), filename);
  return fetch(`${baseUrl}/api/admin/upload`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: form,
    redirect: 'error'
  });
}

async function createPublisherHarness(t) {
  const root = await createProjectFixture(t);
  const init = runNode(root, 'server/scripts/init-db.js', [], {
    INITIAL_ADMIN_PASSWORD: INITIAL_PASSWORD
  });
  assert.equal(init.status, 0, init.stderr);
  const server = await startServer(t, root, { JWT_SECRET });
  const seededPostIds = new Map();
  for (const [index, record] of RELEASE.articles.entries()) {
    const response = await uploadSeedArticle(
      server.baseUrl,
      VALID_TOKEN,
      `${record.zhSlug}.md`,
      articleDocument(record, 'zh', index)
    );
    const body = await response.json();
    assert.equal(response.status, 200, JSON.stringify(body));
    assert.equal(body.article.locale, 'zh');
    assert.equal(body.article.translationKey, record.translationKey);
    assert.equal(body.article.slug, record.zhSlug);
    seededPostIds.set(record.translationKey, body.article.postId);
  }
  return {
    ...createReleaseBundle(root),
    ...server,
    seededPostIds
  };
}

async function spawnPublisher({ root, releasePath, bundleDir, baseUrl, token, keepTokenOpen = false, timeoutMs = 5_000 }) {
  const child = spawn(process.execPath, [
    CLI_PATH,
    '--release', releasePath,
    '--bundle', bundleDir,
    '--base-url', baseUrl,
    '--token-fd', '3'
  ], {
    cwd: root,
    env: { ...process.env, NODE_PATH },
    stdio: ['ignore', 'pipe', 'pipe', 'pipe']
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => { stderr += chunk; });
  child.stdio[3].on('error', () => {});
  if (!keepTokenOpen) child.stdio[3].end(token);

  const closed = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => resolve({ code, signal }));
  });
  let timer;
  try {
    const result = await Promise.race([
      closed,
      new Promise((resolve, reject) => {
        timer = setTimeout(() => reject(new Error('publisher CLI timed out while token fd remained open')), timeoutMs);
      })
    ]);
    return { ...result, stdout, stderr };
  } catch (error) {
    child.kill('SIGKILL');
    child.stdio[3].destroy();
    await closed.catch(() => {});
    throw error;
  } finally {
    clearTimeout(timer);
    child.stdio[3].destroy();
  }
}

function assertNoSensitiveOutput(result, token) {
  const output = `${result.stdout}\n${result.stderr}`;
  if (token) assert.equal(output.includes(token), false, output);
  assert.doesNotMatch(output, /Authorization/i);
  assert.doesNotMatch(output, /\n\s+at\s+\S+/);
  assert.doesNotMatch(output, /node_modules/);
}

function openReadOnlyDatabase(root) {
  return new Database(path.join(root, 'blog.db'), { readonly: true, fileMustExist: true });
}

function assertNoEnglishArticles(root) {
  const db = openReadOnlyDatabase(root);
  try {
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM articles WHERE locale = 'en'").get().count, 0);
  } finally {
    db.close();
  }
}

function safeUploadResponse(record, index, overrides = {}) {
  return {
    id: index + 10,
    postId: index + 100,
    slug: record.enSlug,
    locale: 'en',
    translationKey: record.translationKey,
    status: 'published',
    tags: [...record.tags].reverse(),
    ...overrides
  };
}

function fakeResponse(article, status = 200) {
  return {
    status,
    json: async () => ({
      success: status === 200,
      article,
      debug: 'must not escape the safe response parser'
    })
  };
}

test('argument, loopback, and bounded inherited-fd boundaries are strict', async t => {
  assert.equal(validateLoopbackBaseUrl('http://127.0.0.1:3000/path?ignored=yes'), 'http://127.0.0.1:3000');
  assert.equal(validateLoopbackBaseUrl('http://[::1]:3000/path'), 'http://[::1]:3000');
  for (const value of [
    'https://127.0.0.1:3000',
    'http://localhost:3000',
    'http://127.0.0.2:3000',
    'http://127.0.0.1.example.com:3000',
    'https://example.com'
  ]) {
    assert.throws(() => validateLoopbackBaseUrl(value), /base URL must be loopback HTTP/);
  }

  const parsed = parseArguments([
    '--bundle', 'relative-bundle',
    '--token-fd', '3',
    '--release', 'relative-release.json',
    '--base-url', 'http://127.0.0.1:3000'
  ]);
  assert.deepEqual(parsed, {
    releasePath: path.resolve('relative-release.json'),
    bundleDir: path.resolve('relative-bundle'),
    baseUrl: 'http://127.0.0.1:3000',
    tokenFd: 3
  });
  const invalidArguments = [
    [['--release', 'release.json'], /--bundle is required/],
    [[
      '--release', 'release.json', '--bundle', 'bundle', '--base-url',
      'http://127.0.0.1:3000', '--token-fd'
    ], /missing value for --token-fd/],
    [[
      '--release', 'release.json', '--bundle', 'bundle', '--base-url',
      'http://127.0.0.1:3000', '--token-fd', '3', '--token-fd', '4'
    ], /duplicate flag: --token-fd/],
    [[
      '--release', 'release.json', '--bundle', 'bundle', '--base-url',
      'http://127.0.0.1:3000', '--token-fd', '3', '--unknown', 'value'
    ], /unknown flag: --unknown/],
    [[
      '--release', 'release.json', '--bundle', 'bundle', '--base-url',
      'http://127.0.0.1:3000', '--token-fd', '3.5'
    ], /token-fd.*integer/]
  ];
  for (const [argv, expected] of invalidArguments) {
    assert.throws(() => parseArguments(argv), expected);
  }

  const tokenRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'translation-release-token-'));
  t.after(() => fs.rmSync(tokenRoot, { recursive: true, force: true }));
  const readFile = content => {
    const filePath = path.join(tokenRoot, `${createHash('sha256').update(content).digest('hex')}.token`);
    fs.writeFileSync(filePath, content);
    const fd = fs.openSync(filePath, 'r');
    try {
      return readTokenFromFd(fd);
    } finally {
      fs.closeSync(fd);
    }
  };
  assert.equal(readFile('  inherited-token\n'), 'inherited-token');
  assert.equal(readFile('a'.repeat(16 * 1024)), 'a'.repeat(16 * 1024));
  assert.throws(() => readFile(' \n\t '), /token.*empty/i);
  assert.throws(() => readFile('a'.repeat(16 * 1024 + 1)), /token.*16 KiB/i);
  assert.throws(() => readTokenFromFd(-1), /descriptor.*integer/i);
});

test('direct upload interface rejects non-loopback before token or fetch access', async () => {
  let tokenReads = 0;
  let requests = 0;
  const options = {
    baseUrl: 'https://example.com',
    filename: 'direct-interface.md',
    bytes: Buffer.from('# Direct interface\n'),
    fetchImpl: async () => {
      requests += 1;
      return fakeResponse({});
    }
  };
  Object.defineProperty(options, 'token', {
    get() {
      tokenReads += 1;
      return VALID_TOKEN;
    }
  });

  let error;
  try {
    await uploadArticle(options);
  } catch (caught) {
    error = caught;
  }
  assert.equal(tokenReads, 0);
  assert.equal(requests, 0);
  assert.match(error?.message || '', /base URL must be loopback HTTP/);
});

test('publisher validates the bundle, reads the token once, and uploads sequentially in manifest order', async t => {
  const fixture = createStandaloneBundle(t);
  let tokenReads = 0;
  let activeRequests = 0;
  let maximumActiveRequests = 0;
  const uploadOrder = [];
  const options = {
    baseUrl: 'http://127.0.0.1:3000',
    bundleDir: fixture.bundleDir,
    releasePath: fixture.releasePath,
    fetchImpl: async (url, request) => {
      activeRequests += 1;
      maximumActiveRequests = Math.max(maximumActiveRequests, activeRequests);
      const file = request.body.get('file');
      uploadOrder.push(file.name);
      assert.equal(url, 'http://127.0.0.1:3000/api/admin/upload');
      assert.equal(request.method, 'POST');
      assert.equal(request.redirect, 'error');
      assert.equal(request.headers.Authorization, `Bearer ${VALID_TOKEN}`);
      await new Promise(resolve => setImmediate(resolve));
      activeRequests -= 1;
      const index = RELEASE.articles.findIndex(record => `${record.enSlug}.md` === file.name);
      return fakeResponse(safeUploadResponse(RELEASE.articles[index], index));
    }
  };
  Object.defineProperty(options, 'bearerToken', {
    enumerable: true,
    get() {
      tokenReads += 1;
      return VALID_TOKEN;
    }
  });

  const results = await publishTranslationRelease(options);
  assert.equal(tokenReads, 1);
  assert.equal(maximumActiveRequests, 1);
  assert.deepEqual(uploadOrder, RELEASE.articles.map(record => `${record.enSlug}.md`));
  assert.deepEqual(results, RELEASE.articles.map((record, index) => ({
    filename: `${record.enSlug}.md`,
    id: index + 10,
    postId: index + 100,
    slug: record.enSlug,
    locale: 'en',
    translationKey: record.translationKey
  })));
  for (const result of results) {
    assert.deepEqual(Object.keys(result), [
      'filename', 'id', 'postId', 'slug', 'locale', 'translationKey'
    ]);
  }
});

test('bad SHA fails before reading the bearer token or making any HTTP request', async t => {
  const fixture = createStandaloneBundle(t);
  fs.appendFileSync(
    path.join(fixture.bundleDir, `${RELEASE.articles[0].enSlug}.md`),
    '\nchanged after signing\n'
  );
  let tokenReads = 0;
  let requests = 0;
  const options = {
    baseUrl: 'http://127.0.0.1:3000',
    bundleDir: fixture.bundleDir,
    releasePath: fixture.releasePath,
    fetchImpl: async () => {
      requests += 1;
      throw new Error('fetch must not run');
    }
  };
  Object.defineProperty(options, 'bearerToken', {
    get() {
      tokenReads += 1;
      return VALID_TOKEN;
    }
  });

  await assert.rejects(() => publishTranslationRelease(options), /SHA256SUMS mismatch/);
  assert.equal(tokenReads, 0);
  assert.equal(requests, 0);
});

test('publisher rejects bytes changed immediately after the SHA audit before token or fetch', async t => {
  const fixture = createStandaloneBundle(t);
  const filename = `${RELEASE.articles[0].enSlug}.md`;
  const targetPath = path.join(fixture.bundleDir, filename);
  const originalReadFileSync = fs.readFileSync;
  let mutated = false;
  let tokenReads = 0;
  let requests = 0;
  fs.readFileSync = function mutateAfterAuditRead(file, ...args) {
    const bytes = originalReadFileSync.call(this, file, ...args);
    if (!mutated && typeof file === 'string' && path.resolve(file) === targetPath) {
      mutated = true;
      fs.appendFileSync(targetPath, '\nchanged immediately after the audit hash read\n');
    }
    return bytes;
  };

  const options = {
    baseUrl: 'http://127.0.0.1:3000',
    bundleDir: fixture.bundleDir,
    releasePath: fixture.releasePath,
    fetchImpl: async () => {
      const index = requests;
      requests += 1;
      return fakeResponse(safeUploadResponse(RELEASE.articles[index], index));
    }
  };
  Object.defineProperty(options, 'bearerToken', {
    get() {
      tokenReads += 1;
      return VALID_TOKEN;
    }
  });

  try {
    await assert.rejects(() => publishTranslationRelease(options), /SHA256SUMS mismatch/);
  } finally {
    fs.readFileSync = originalReadFileSync;
  }
  assert.equal(mutated, true);
  assert.equal(tokenReads, 0);
  assert.equal(requests, 0);
});

test('non-loopback base URL is rejected before reading the token', async t => {
  const fixture = createStandaloneBundle(t);
  const result = await spawnPublisher({
    ...fixture,
    baseUrl: 'https://example.com',
    keepTokenOpen: true,
    timeoutMs: 1_500
  });
  assert.equal(result.code, 1, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stderr, /base URL must be loopback HTTP/);
  assertNoSensitiveOutput(result);
});

test('returned identities, locale, translation key, slug, status, and tags are checked safely', async t => {
  const fixture = createStandaloneBundle(t);
  const responseBodyMarker = 'raw-identity-response-SHOULD-NOT-LEAK';
  const identityValues = [
    ['missing', undefined, true],
    ['zero', 0, false],
    ['negative', -1, false],
    ['non-integer', 1.5, false],
    ['unsafe integer', Number.MAX_SAFE_INTEGER + 1, false],
    ['wrong type', '1', false]
  ];
  for (const field of ['id', 'postId']) {
    for (const [description, value, remove] of identityValues) {
      let requests = 0;
      await assert.rejects(() => publishTranslationRelease({
        baseUrl: 'http://127.0.0.1:3000',
        bundleDir: fixture.bundleDir,
        releasePath: fixture.releasePath,
        bearerToken: VALID_TOKEN,
        fetchImpl: async () => {
          const article = safeUploadResponse(RELEASE.articles[0], 0);
          if (remove) delete article[field];
          else article[field] = value;
          requests += 1;
          return {
            status: 200,
            json: async () => ({ article, debug: responseBodyMarker })
          };
        }
      }), error => {
        assert.equal(error.message, `upload identity mismatch for ${RELEASE.articles[0].enSlug}.md: ${field}`);
        assert.equal(error.message.includes(VALID_TOKEN), false);
        assert.equal(error.message.includes(responseBodyMarker), false);
        assert.doesNotMatch(error.message, /authorization|bearer|header/i);
        return true;
      });
      assert.equal(requests, 1, `${field} ${description} should stop after the first response`);
    }
  }

  const cases = [
    ['locale', { locale: 'zh' }],
    ['translationKey', { translationKey: 'wrong-translation-key' }],
    ['slug', { slug: 'wrong-slug' }],
    ['status', { status: 'draft' }],
    ['tags', { tags: RELEASE.articles[0].tags.slice(1) }],
    ['tags', { tags: [...RELEASE.articles[0].tags, RELEASE.articles[0].tags[0]] }]
  ];
  for (const [field, mutation] of cases) {
    let requests = 0;
    await assert.rejects(() => publishTranslationRelease({
      baseUrl: 'http://127.0.0.1:3000',
      bundleDir: fixture.bundleDir,
      releasePath: fixture.releasePath,
      bearerToken: VALID_TOKEN,
      fetchImpl: async () => {
        const index = requests;
        requests += 1;
        return fakeResponse(safeUploadResponse(RELEASE.articles[index], index, mutation));
      }
    }), new RegExp(field));
    assert.equal(requests, 1, `${field} mismatch should stop after the first response`);
  }
});

test('CLI publishes all four English siblings through the real route with safe output', async t => {
  const fixture = await createPublisherHarness(t);
  const result = await spawnPublisher({
    ...fixture,
    baseUrl: fixture.baseUrl,
    token: `  ${VALID_TOKEN}\n`
  });
  assert.equal(result.code, 0, `${result.stdout}\n${result.stderr}`);
  assert.equal(result.signal, null);
  assert.equal(result.stderr, '');
  assertNoSensitiveOutput(result, VALID_TOKEN);

  const lines = result.stdout.trimEnd().split('\n').map(line => JSON.parse(line));
  assert.equal(lines.length, 4);
  assert.deepEqual(lines, RELEASE.articles.map((record, index) => ({
    filename: `${record.enSlug}.md`,
    status: 'published',
    articleId: index + 5,
    slug: record.enSlug,
    translationKey: record.translationKey
  })));
  for (const line of lines) {
    assert.deepEqual(Object.keys(line), [
      'filename', 'status', 'articleId', 'slug', 'translationKey'
    ]);
  }

  const db = openReadOnlyDatabase(fixture.root);
  try {
    const english = db.prepare(`
      SELECT a.id, a.post_id, a.slug, a.locale, a.title, a.content, p.translation_key
      FROM articles a
      JOIN posts p ON p.id = a.post_id
      WHERE a.locale = 'en'
      ORDER BY a.id
    `).all();
    assert.equal(english.length, 4);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM posts').get().count, 4);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM articles').get().count, 8);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM article_fts').get().count, 8);

    for (const [index, record] of RELEASE.articles.entries()) {
      const article = english[index];
      assert.equal(article.locale, 'en');
      assert.equal(article.slug, record.enSlug);
      assert.equal(article.translation_key, record.translationKey);
      assert.equal(article.post_id, fixture.seededPostIds.get(record.translationKey));
      assert.equal(article.title, record.enTitle);
      assert.match(article.content, new RegExp(`Searchable English release body ${index + 1}`));

      const tagIds = db.prepare(
        'SELECT tag_id FROM article_tags WHERE article_id = ? ORDER BY tag_id'
      ).all(article.id).map(row => row.tag_id);
      assert.deepEqual(tagIds, [...record.tags].sort(compareStrings));

      const expectedTaxonomy = db.prepare(`
        SELECT category_labels.name AS category_name, tag_labels.name AS tag_name
        FROM article_tags
        JOIN tags ON tags.id = article_tags.tag_id
        JOIN tag_labels ON tag_labels.tag_id = tags.id AND tag_labels.locale = 'en'
        JOIN categories ON categories.id = tags.category_id
        JOIN category_labels ON category_labels.category_id = categories.id AND category_labels.locale = 'en'
        WHERE article_tags.article_id = ?
        ORDER BY tags.sort_order, tags.id
      `).all(article.id).flatMap(row => [row.category_name, row.tag_name]).join(' ');
      const fts = db.prepare(
        'SELECT title, content, taxonomy FROM article_fts WHERE rowid = ?'
      ).get(article.id);
      assert.deepEqual(fts, {
        title: article.title,
        content: article.content,
        taxonomy: expectedTaxonomy
      });
    }
  } finally {
    db.close();
  }

  assert.deepEqual(
    fs.readdirSync(path.join(fixture.root, 'articles', 'en')).sort(compareStrings),
    RELEASE.articles.map(record => `${record.enSlug}.md`).sort(compareStrings)
  );
  for (const record of RELEASE.articles) {
    const saved = matter(fs.readFileSync(
      path.join(fixture.root, 'articles', 'en', `${record.enSlug}.md`),
      'utf8'
    ));
    assert.equal(saved.data.locale, 'en');
    assert.equal(saved.data.translationKey, record.translationKey);
    assert.equal(saved.data.slug, record.enSlug);
    assert.equal(saved.data.status, 'published');
    assert.deepEqual(saved.data.tags, record.tags);
  }
});

test('missing and invalid tokens fail without token or Authorization disclosure', async t => {
  const fixture = await createPublisherHarness(t);
  const missing = await spawnPublisher({
    ...fixture,
    baseUrl: fixture.baseUrl,
    token: ' \n\t '
  });
  assert.equal(missing.code, 1, `${missing.stdout}\n${missing.stderr}`);
  assertNoSensitiveOutput(missing);
  assertNoEnglishArticles(fixture.root);

  const invalidToken = 'task-3-invalid-token-SHOULD-NOT-LEAK';
  const invalid = await spawnPublisher({
    ...fixture,
    baseUrl: fixture.baseUrl,
    token: invalidToken
  });
  assert.equal(invalid.code, 1, `${invalid.stdout}\n${invalid.stderr}`);
  assertNoSensitiveOutput(invalid, invalidToken);
  assertNoEnglishArticles(fixture.root);
});

test('unknown stable tag stops immediately before any English publication', async t => {
  const fixture = await createPublisherHarness(t);
  rewriteBundleArticle(fixture, 0, {
    tags: [...RELEASE.articles[0].tags, 'not-a-stable-tag-id']
  });
  const result = await spawnPublisher({
    ...fixture,
    baseUrl: fixture.baseUrl,
    token: VALID_TOKEN
  });
  assert.equal(result.code, 1, `${result.stdout}\n${result.stderr}`);
  assertNoSensitiveOutput(result, VALID_TOKEN);
  assertNoEnglishArticles(fixture.root);
  assert.deepEqual(fs.readdirSync(path.join(fixture.root, 'articles', 'en')), []);
});

test('identity conflict stops immediately and leaves the earlier successful upload intact', async t => {
  const fixture = await createPublisherHarness(t);
  rewriteBundleArticle(fixture, 1, {
    translationKey: RELEASE.articles[0].translationKey
  });
  const result = await spawnPublisher({
    ...fixture,
    baseUrl: fixture.baseUrl,
    token: VALID_TOKEN
  });
  assert.equal(result.code, 1, `${result.stdout}\n${result.stderr}`);
  assertNoSensitiveOutput(result, VALID_TOKEN);

  const db = openReadOnlyDatabase(fixture.root);
  try {
    const english = db.prepare(`
      SELECT a.id, a.slug, a.post_id, p.translation_key
      FROM articles a
      JOIN posts p ON p.id = a.post_id
      WHERE a.locale = 'en'
      ORDER BY a.id
    `).all();
    assert.deepEqual(english, [{
      id: 5,
      slug: RELEASE.articles[0].enSlug,
      post_id: fixture.seededPostIds.get(RELEASE.articles[0].translationKey),
      translation_key: RELEASE.articles[0].translationKey
    }]);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM article_fts').get().count, 5);
  } finally {
    db.close();
  }

  assert.deepEqual(fs.readdirSync(path.join(fixture.root, 'articles', 'en')), [
    `${RELEASE.articles[0].enSlug}.md`
  ]);
});

test('package exposes the protected translation publisher command', () => {
  const pkg = JSON.parse(fs.readFileSync(PACKAGE_PATH, 'utf8'));
  assert.equal(
    pkg.scripts['publish-translation-release'],
    'node scripts/publish-translation-release.js'
  );
});

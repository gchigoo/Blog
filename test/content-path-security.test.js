const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const test = require('node:test');
const AdmZip = require('adm-zip');
const matter = require('gray-matter');
const jwt = require('jsonwebtoken');
const {
  MarkdownMetadataError,
  parseMarkdown,
  replaceHtmlImagePaths,
  serializeMarkdownDocument
} = require('../server/utils/markdown');
const { createProjectFixture, runNode, startServer } = require('./helpers/project-fixture');

const INITIAL_PASSWORD = 'S3cure!Node24';
const JWT_SECRET = 'test-only-jwt-secret-with-at-least-32-characters';

function authCookie() {
  const token = jwt.sign({ id: 1, username: 'admin' }, JWT_SECRET, { expiresIn: '5m' });
  return `token=${token}`;
}

async function prepareServer(t) {
  const root = await createProjectFixture(t);
  const init = runNode(root, 'server/scripts/init-db.js', [], {
    INITIAL_ADMIN_PASSWORD: INITIAL_PASSWORD
  });
  assert.equal(init.status, 0, init.stderr);
  const server = await startServer(t, root, { JWT_SECRET });
  return { root, ...server };
}

async function upload(baseUrl, name, bytes, endpoint = '/api/admin/upload') {
  const form = new FormData();
  form.append('file', new Blob([bytes]), name);
  return fetch(`${baseUrl}${endpoint}`, {
    method: 'POST',
    headers: { cookie: authCookie() },
    body: form
  });
}

function zipWithRawEntryName(entryName, content) {
  const entryNameBytes = Buffer.from(entryName);
  const placeholder = `${'x'.repeat(entryNameBytes.length - 3)}.md`;
  const zip = new AdmZip();
  zip.addFile(placeholder, Buffer.from(content));
  const buffer = zip.toBuffer();
  const placeholderBytes = Buffer.from(placeholder);
  let offset = 0;
  let replacements = 0;

  while ((offset = buffer.indexOf(placeholderBytes, offset)) !== -1) {
    entryNameBytes.copy(buffer, offset);
    offset += entryNameBytes.length;
    replacements += 1;
  }

  assert.ok(replacements >= 2, 'ZIP local and central directory names must both be replaced');
  assert.equal(new AdmZip(buffer).getEntries()[0].entryName, entryName);
  return buffer;
}

test('raw Markdown HTML is escaped while normal Markdown images still render', () => {
  const markdown = `---\ntitle: Security\nslug: security\n---\n\n<img src=x onerror=alert(1)>\n<script>alert(2)</script>\n\n![safe](./safe.png)`;
  const parsed = parseMarkdown(markdown);

  assert.doesNotMatch(parsed.html, /<script|<img src=x|<[^>]+\sonerror\s*=/i);
  assert.match(parsed.html, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.match(parsed.html, /<img src="\.\/safe\.png" alt="safe">/);
});

test('rejects malformed article metadata as author input', () => {
  for (const frontMatter of [
    'title: 42',
    'title: Valid\ntags: 42',
    'title: Valid\ndate: not-a-date'
  ]) {
    assert.throws(
      () => parseMarkdown(`---\n${frontMatter}\n---\nbody`),
      MarkdownMetadataError
    );
  }
});

test('serializes YAML-sensitive article metadata without corrupting Front Matter', () => {
  const serialized = serializeMarkdownDocument('body\n', {
    title: 'Question: why now?',
    slug: 'question-why-now',
    tags: ['notes'],
    date: '2026-07-20T00:00:00.000Z'
  });
  const parsed = matter(serialized);

  assert.equal(parsed.data.title, 'Question: why now?');
  assert.equal(parsed.data.slug, 'question-why-now');
  assert.deepEqual(parsed.data.tags, ['notes']);
  assert.equal(parsed.content, 'body\n');
});

test('replaces URI-encoded Windows image paths in rendered HTML', () => {
  const sourcePath = 'C:\\Users\\HAT\\Desktop\\快充\\image-20191126101337709.png';
  const html = parseMarkdown(`![diagram](${sourcePath})`).html;
  const updated = replaceHtmlImagePaths(html, {
    [sourcePath]: '/images/converted.webp'
  });

  assert.match(html, /C:%5CUsers%5CHAT%5CDesktop/);
  assert.match(updated, /src="\/images\/converted\.webp"/);
  assert.doesNotMatch(updated, /C:%5CUsers%5CHAT%5CDesktop/);
});

test('upload reports malformed Front Matter as a stable 400 response', async t => {
  const { baseUrl } = await prepareServer(t);
  const markdown = '---\ntitle: Invalid date\nslug: invalid-date\ndate: not-a-date\n---\nbody';
  const response = await upload(baseUrl, 'invalid-date.md', markdown);
  const body = await response.json();

  assert.equal(response.status, 400, JSON.stringify(body));
  assert.equal(body.code, 'invalid_article_metadata');
});

test('upload rejects slugs outside the fixed safe format', async t => {
  const { root, baseUrl } = await prepareServer(t);
  const invalidSlugs = [
    '../outside-target',
    'Unsafe',
    'double--dash',
    '-leading',
    'trailing-',
    'with_under',
    'nested/path',
    'back\\slash'
  ];

  for (const [index, slug] of invalidSlugs.entries()) {
    const markdown = `---\ntitle: Invalid ${index}\nslug: ${slug}\n---\n\nbody`;
    const response = await upload(baseUrl, `invalid-${index}.md`, markdown);
    assert.equal(response.status, 400, `${slug}: ${await response.text()}`);
  }

  await assert.rejects(fs.access(path.join(root, 'outside-target.md')), { code: 'ENOENT' });
});

test('delete refuses an unsafe stored slug without touching files or the database row', async t => {
  const { root, baseUrl } = await prepareServer(t);
  const Database = require('better-sqlite3');
  const protectedFile = path.join(root, 'protected.md');
  await fs.writeFile(protectedFile, 'keep');

  const db = new Database(path.join(root, 'blog.db'));
  const result = db.prepare(`
    INSERT INTO articles (title, slug, content, html, tags)
    VALUES (?, ?, ?, ?, ?)
  `).run('Unsafe stored article', '../protected', 'body', '<p>body</p>', '[]');
  db.close();

  const response = await fetch(`${baseUrl}/api/admin/articles/${result.lastInsertRowid}`, {
    method: 'DELETE',
    headers: { cookie: authCookie() }
  });

  assert.equal(response.status, 400, await response.text());
  assert.equal(await fs.readFile(protectedFile, 'utf8'), 'keep');
  const verifyDb = new Database(path.join(root, 'blog.db'));
  assert.ok(verifyDb.prepare('SELECT id FROM articles WHERE id = ?').get(result.lastInsertRowid));
  verifyDb.close();
});

test('preview returns a stable author error for ambiguous ZIP entries', async t => {
  const { baseUrl } = await prepareServer(t);
  const zip = new AdmZip();
  zip.addFile('first.md', Buffer.from('---\ntitle: First\nslug: first\n---\nbody'));
  zip.addFile('other.md', Buffer.from('---\ntitle: Other\nslug: other\n---\nbody'));
  const buffer = zip.toBuffer();
  const originalName = Buffer.from('other.md');
  const duplicateName = Buffer.from('first.md');
  let offset = 0;
  let replacements = 0;
  while ((offset = buffer.indexOf(originalName, offset)) !== -1) {
    duplicateName.copy(buffer, offset);
    offset += duplicateName.length;
    replacements += 1;
  }
  assert.ok(replacements >= 2);

  const response = await upload(baseUrl, 'ambiguous.zip', buffer, '/api/admin/preview');
  const body = await response.json();

  assert.equal(response.status, 400, JSON.stringify(body));
  assert.equal(body.code, 'audio_archive_ambiguous');
});

test('upload rejects a ZIP traversal entry before extraction', async t => {
  const { root, baseUrl } = await prepareServer(t);
  const zip = zipWithRawEntryName(
    '../../outside.md',
    '---\ntitle: Outside\nslug: outside\n---\nbody'
  );

  const response = await upload(baseUrl, 'traversal.zip', zip);

  assert.equal(response.status, 400, await response.text());
  await assert.rejects(fs.access(path.join(root, 'outside.md')), { code: 'ENOENT' });
});

test('upload rejects backslash ZIP traversal before extraction', async t => {
  const { baseUrl } = await prepareServer(t);
  const zip = zipWithRawEntryName(
    '..\\outside.md',
    '---\ntitle: Backslash\nslug: backslash\n---\nbody'
  );

  const response = await upload(baseUrl, 'backslash.zip', zip);

  assert.equal(response.status, 400, await response.text());
});

test('upload rejects an absolute ZIP entry before extraction', async t => {
  const { baseUrl } = await prepareServer(t);
  const zip = zipWithRawEntryName(
    '/absolute.md',
    '---\ntitle: Absolute\nslug: absolute\n---\nbody'
  );

  const response = await upload(baseUrl, 'absolute.zip', zip);

  assert.equal(response.status, 400, await response.text());
});

test('image conversion failures are returned as explicit upload warnings', async t => {
  const { baseUrl } = await prepareServer(t);
  const zip = new AdmZip();
  zip.addFile('article.md', Buffer.from('---\ntitle: Warning ZIP\nslug: warning-zip\n---\n\n![bad](images/bad.png)'));
  zip.addFile('images/bad.png', Buffer.from('not a valid png'));

  const response = await upload(baseUrl, 'warning.zip', zip.toBuffer());
  const body = await response.json();
  assert.equal(response.status, 200, JSON.stringify(body));
  assert.deepEqual(body.article.imageWarnings, ['images/bad.png']);
  assert.equal(body.article.imagesConverted, 0);
});

test('normal ZIP upload preserves Markdown image conversion workflow', async t => {
  const { root, baseUrl } = await prepareServer(t);
  const zip = new AdmZip();
  const markdown = `---\ntitle: Normal ZIP\nslug: normal-zip\ntags: [smoke]\n---\n\n![pixel](images/pixel.png)`;
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
  zip.addFile('article.md', Buffer.from(markdown));
  zip.addFile('other/pixel.png', Buffer.from('not an image'));
  zip.addFile('images/pixel.png', png);

  const response = await upload(baseUrl, 'normal.zip', zip.toBuffer());
  const body = await response.json();

  assert.equal(response.status, 200, JSON.stringify(body));
  assert.equal(body.article.slug, 'normal-zip');
  assert.equal(body.article.imagesConverted, 1);
  const saved = await fs.readFile(path.join(root, 'articles', 'normal-zip.md'), 'utf8');
  assert.match(saved, /\/images\/[a-f0-9]+\.webp/);
});

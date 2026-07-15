const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const test = require('node:test');
const AdmZip = require('adm-zip');
const jwt = require('jsonwebtoken');
const { parseMarkdown } = require('../server/utils/markdown');
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

async function upload(baseUrl, name, bytes) {
  const form = new FormData();
  form.append('file', new Blob([bytes]), name);
  return fetch(`${baseUrl}/api/admin/upload`, {
    method: 'POST',
    headers: { cookie: authCookie() },
    body: form
  });
}

test('raw Markdown HTML is escaped while normal Markdown images still render', () => {
  const markdown = `---\ntitle: Security\nslug: security\n---\n\n<img src=x onerror=alert(1)>\n<script>alert(2)</script>\n\n![safe](./safe.png)`;
  const parsed = parseMarkdown(markdown);

  assert.doesNotMatch(parsed.html, /<script|<img src=x|onerror=/i);
  assert.match(parsed.html, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.match(parsed.html, /<img src="\.\/safe\.png" alt="safe">/);
});

test('upload rejects a traversal slug without writing outside articles root', async t => {
  const { root, baseUrl } = await prepareServer(t);
  const outside = path.join(root, 'outside-target.md');
  const markdown = `---\ntitle: Traversal\nslug: ../outside-target\n---\n\nbody`;

  const response = await upload(baseUrl, 'traversal.md', markdown);

  assert.equal(response.status, 400, await response.text());
  await assert.rejects(fs.access(outside), { code: 'ENOENT' });
});

test('upload rejects a ZIP traversal entry before extraction', async t => {
  const { root, baseUrl } = await prepareServer(t);
  const zip = new AdmZip();
  zip.addFile('../../outside.md', Buffer.from('---\ntitle: Outside\nslug: outside\n---\nbody'));

  const response = await upload(baseUrl, 'traversal.zip', zip.toBuffer());

  assert.equal(response.status, 400, await response.text());
  await assert.rejects(fs.access(path.join(root, 'outside.md')), { code: 'ENOENT' });
});

test('upload rejects an absolute ZIP entry before extraction', async t => {
  const { baseUrl } = await prepareServer(t);
  const zip = new AdmZip();
  zip.addFile('/absolute.md', Buffer.from('---\ntitle: Absolute\nslug: absolute\n---\nbody'));

  const response = await upload(baseUrl, 'absolute.zip', zip.toBuffer());

  assert.equal(response.status, 400, await response.text());
});

test('normal ZIP upload preserves Markdown image conversion workflow', async t => {
  const { root, baseUrl } = await prepareServer(t);
  const zip = new AdmZip();
  const markdown = `---\ntitle: Normal ZIP\nslug: normal-zip\ntags: [smoke]\n---\n\n![pixel](images/pixel.png)`;
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
  zip.addFile('article.md', Buffer.from(markdown));
  zip.addFile('images/pixel.png', png);

  const response = await upload(baseUrl, 'normal.zip', zip.toBuffer());
  const body = await response.json();

  assert.equal(response.status, 200, JSON.stringify(body));
  assert.equal(body.article.slug, 'normal-zip');
  assert.equal(body.article.imagesConverted, 1);
  const saved = await fs.readFile(path.join(root, 'articles', 'normal-zip.md'), 'utf8');
  assert.match(saved, /\/images\/[a-f0-9]+\.webp/);
});

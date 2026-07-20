const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const { Readable } = require('node:stream');
const test = require('node:test');
const AdmZip = require('adm-zip');
const Database = require('better-sqlite3');
const jwt = require('jsonwebtoken');
const { createProjectFixture, runNode, startServer } = require('./helpers/project-fixture');
const { validMp3 } = require('./helpers/article-audio-fixtures');

const INITIAL_PASSWORD = 'S3cure!Node24';
const JWT_SECRET = 'test-only-jwt-secret-with-at-least-32-characters';
const MAX_UPLOAD_BYTES = 100 * 1024 * 1024;

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

async function uploadGeneratedBytes(baseUrl, name, byteLength) {
  const boundary = `codex-audio-boundary-${Date.now()}`;
  const prefix = Buffer.from(
    `--${boundary}\r\n` +
    `Content-Disposition: form-data; name="file"; filename="${name}"\r\n` +
    'Content-Type: application/octet-stream\r\n\r\n'
  );
  const suffix = Buffer.from(`\r\n--${boundary}--\r\n`);
  const chunk = Buffer.alloc(1024 * 1024);

  async function* body() {
    yield prefix;
    let remaining = byteLength;
    while (remaining > 0) {
      const length = Math.min(remaining, chunk.length);
      yield chunk.subarray(0, length);
      remaining -= length;
    }
    yield suffix;
  }

  return fetch(`${baseUrl}/api/admin/upload`, {
    method: 'POST',
    headers: {
      cookie: authCookie(),
      'content-type': `multipart/form-data; boundary=${boundary}`
    },
    body: Readable.from(body()),
    duplex: 'half'
  });
}

test('uploads an article ZIP with a hashed MP3 and resolved audio HTML', async t => {
  const { root, baseUrl } = await prepareServer(t);
  const mp3 = validMp3();
  const hash = crypto.createHash('sha256').update(mp3).digest('hex');
  const markdown = `---
title: AI Song Experiment
slug: ai-song-experiment
tags: [AI, music]
---

# Making the song

:::audio
title: Stay Until Tomorrow
artist: AI Experiment
src: ./audio/final.mp3
caption: Final mix
:::`;
  const zip = new AdmZip();
  zip.addFile('posts/article.md', Buffer.from(markdown));
  zip.addFile('posts/audio/final.mp3', mp3);

  const response = await upload(baseUrl, 'article-with-audio.zip', zip.toBuffer());
  const body = await response.json();

  assert.equal(response.status, 200, JSON.stringify(body));
  assert.equal(body.article.audioPublished, 1);
  assert.equal(body.article.imagesConverted, 0);
  assert.equal(body.article.slug, 'ai-song-experiment');

  const db = new Database(path.join(root, 'blog.db'));
  const article = db.prepare('SELECT content, html FROM articles WHERE slug = ?').get('ai-song-experiment');
  db.close();
  assert.match(article.content, /src: \.\/audio\/final\.mp3/);
  assert.match(article.html, new RegExp(`/audio/ai-song-experiment/${hash}\\.mp3`));
  assert.match(article.html, /<figure class="article-audio">/);
  assert.doesNotMatch(article.html, /src="\.\/audio\/final\.mp3"/);

  const savedMarkdown = await fs.readFile(path.join(root, 'articles', 'ai-song-experiment.md'), 'utf8');
  assert.match(savedMarkdown, /src: \.\/audio\/final\.mp3/);
  assert.deepEqual(
    await fs.readFile(path.join(root, 'public', 'audio', 'ai-song-experiment', `${hash}.mp3`)),
    mp3
  );

  const audioUrl = `${baseUrl}/audio/ai-song-experiment/${hash}.mp3`;
  const getResponse = await fetch(audioUrl);
  assert.equal(getResponse.status, 200);
  assert.match(getResponse.headers.get('content-type'), /^audio\/mpeg\b/);
  assert.deepEqual(Buffer.from(await getResponse.arrayBuffer()), mp3);

  const headResponse = await fetch(audioUrl, { method: 'HEAD' });
  assert.equal(headResponse.status, 200);
  assert.equal(headResponse.headers.get('accept-ranges'), 'bytes');
  assert.equal(await headResponse.text(), '');

  const rangeResponse = await fetch(audioUrl, { headers: { range: 'bytes=0-3' } });
  assert.equal(rangeResponse.status, 206);
  assert.equal(rangeResponse.headers.get('content-range'), `bytes 0-3/${mp3.length}`);
  assert.deepEqual(Buffer.from(await rangeResponse.arrayBuffer()), mp3.subarray(0, 4));

  const deleteResponse = await fetch(`${baseUrl}/api/admin/articles/${body.article.id}`, {
    method: 'DELETE',
    headers: { cookie: authCookie() }
  });
  assert.equal(deleteResponse.status, 200, await deleteResponse.text());
  await assert.rejects(
    fs.access(path.join(root, 'public', 'audio', 'ai-song-experiment')),
    { code: 'ENOENT' }
  );
  assert.equal((await fetch(audioUrl)).status, 404);
});

test('publishes, serves, and deletes one article containing all supported audio formats', async t => {
  const { root, baseUrl } = await prepareServer(t);
  const fixtureDirectory = path.join(__dirname, 'fixtures', 'article-audio');
  const formats = await Promise.all([
    ['mp3', 'audio/mpeg'],
    ['aac', 'audio/aac'],
    ['m4a', 'audio/mp4'],
    ['flac', 'audio/flac']
  ].map(async ([extension, mimeType]) => [
    extension,
    mimeType,
    await fs.readFile(path.join(fixtureDirectory, `tone.${extension}`))
  ]));
  const markdown = `---
title: Multi Format Audio
slug: multi-format-audio
tags: [audio]
---

${formats.map(([extension], index) => `:::audio
title: Track ${index + 1}
src: ./audio/track.${extension}
:::`).join('\n\n')}`;
  const zip = new AdmZip();
  zip.addFile('posts/article.md', Buffer.from(markdown));
  for (const [extension, , bytes] of formats) {
    zip.addFile(`posts/audio/track.${extension}`, bytes);
  }

  const response = await upload(baseUrl, 'multi-format-audio.zip', zip.toBuffer());
  const body = await response.json();
  assert.equal(response.status, 200, JSON.stringify(body));
  assert.equal(body.article.audioPublished, 4);

  const db = new Database(path.join(root, 'blog.db'));
  const article = db.prepare('SELECT html FROM articles WHERE slug = ?').get('multi-format-audio');
  db.close();
  assert.equal((article.html.match(/data-article-audio-styles/g) || []).length, 1);

  const urls = [];
  for (const [extension, mimeType, bytes] of formats) {
    const hash = crypto.createHash('sha256').update(bytes).digest('hex');
    const url = `${baseUrl}/audio/multi-format-audio/${hash}.${extension}`;
    urls.push(url);
    assert.match(article.html, new RegExp(`<source src="/audio/multi-format-audio/${hash}\\.${extension}" type="${mimeType}">`));
    assert.deepEqual(
      await fs.readFile(path.join(root, 'public', 'audio', 'multi-format-audio', `${hash}.${extension}`)),
      bytes
    );
    const audioResponse = await fetch(url);
    assert.equal(audioResponse.status, 200);
    assert.equal(audioResponse.headers.get('content-type'), mimeType);
  }

  const deleteResponse = await fetch(`${baseUrl}/api/admin/articles/${body.article.id}`, {
    method: 'DELETE',
    headers: { cookie: authCookie() }
  });
  assert.equal(deleteResponse.status, 200, await deleteResponse.text());
  for (const url of urls) assert.equal((await fetch(url)).status, 404);
});

test('allows a 100 MiB upload and rejects the next byte with a stable 413 code', async t => {
  const { root, baseUrl } = await prepareServer(t);

  const exactResponse = await uploadGeneratedBytes(baseUrl, 'exact-limit.txt', MAX_UPLOAD_BYTES);
  assert.equal(exactResponse.status, 400, await exactResponse.text());

  const oversizedResponse = await uploadGeneratedBytes(
    baseUrl,
    'over-limit.txt',
    MAX_UPLOAD_BYTES + 1
  );
  const oversizedBody = await oversizedResponse.json();
  assert.equal(oversizedResponse.status, 413, JSON.stringify(oversizedBody));
  assert.equal(oversizedBody.code, 'upload_file_too_large');
  assert.deepEqual(await fs.readdir(path.join(root, 'uploads', 'temp')), []);
});

test('/audio returns canonical MIME with exact HEAD, Range, and 416 semantics', async t => {
  const { root, baseUrl } = await prepareServer(t);
  const hash = 'c'.repeat(64);
  const directory = path.join(root, 'public', 'audio', 'static-audio');
  await fs.mkdir(directory, { recursive: true });
  const formats = [
    ['mp3', 'audio/mpeg'],
    ['aac', 'audio/aac'],
    ['m4a', 'audio/mp4'],
    ['flac', 'audio/flac']
  ];

  for (const [extension, mimeType] of formats) {
    const bytes = Buffer.from(`${extension}-audio-bytes`);
    await fs.writeFile(path.join(directory, `${hash}.${extension}`), bytes);
    const url = `${baseUrl}/audio/static-audio/${hash}.${extension}`;

    const getResponse = await fetch(url);
    assert.equal(getResponse.status, 200);
    assert.equal(getResponse.headers.get('content-type'), mimeType);
    assert.equal(Number(getResponse.headers.get('content-length')), bytes.length);

    const headResponse = await fetch(url, { method: 'HEAD' });
    assert.equal(headResponse.status, 200);
    assert.equal(Number(headResponse.headers.get('content-length')), bytes.length);
    assert.equal(await headResponse.text(), '');

    const rangeResponse = await fetch(url, { headers: { range: 'bytes=0-3' } });
    assert.equal(rangeResponse.status, 206);
    assert.equal(rangeResponse.headers.get('accept-ranges'), 'bytes');
    assert.equal(rangeResponse.headers.get('content-range'), `bytes 0-3/${bytes.length}`);
    assert.deepEqual(Buffer.from(await rangeResponse.arrayBuffer()), bytes.subarray(0, 4));

    const unsatisfiedResponse = await fetch(url, { headers: { range: 'bytes=999-1000' } });
    assert.equal(unsatisfiedResponse.status, 416);
    assert.equal(unsatisfiedResponse.headers.get('content-range'), `bytes */${bytes.length}`);
  }

  await fs.writeFile(path.join(directory, `${hash}.wav`), Buffer.from('unsupported'));
  await fs.writeFile(path.join(directory, `${hash}.FLAC`), Buffer.from('wrong-case'));
  assert.equal((await fetch(`${baseUrl}/audio/static-audio/${hash}.wav`)).status, 404);
  assert.equal((await fetch(`${baseUrl}/audio/static-audio/${hash}.FLAC`)).status, 404);
});

test('rejects an audio block in a standalone Markdown upload without leaving state', async t => {
  const { root, baseUrl } = await prepareServer(t);
  const markdown = `---
title: Missing Archive
slug: missing-archive
---

:::audio
title: Missing
src: ./missing.mp3
:::`;

  const response = await upload(baseUrl, 'missing-archive.md', markdown);
  const body = await response.json();

  assert.equal(response.status, 400, JSON.stringify(body));
  assert.equal(body.code, 'audio_archive_required');
  const db = new Database(path.join(root, 'blog.db'));
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM articles WHERE slug = ?').get('missing-archive').count, 0);
  db.close();
  await assert.rejects(fs.access(path.join(root, 'articles', 'missing-archive.md')), { code: 'ENOENT' });
  await assert.rejects(fs.access(path.join(root, 'public', 'audio', 'missing-archive')), { code: 'ENOENT' });
});

test('serializes concurrent uploads that request the same slug', async t => {
  const { root, baseUrl } = await prepareServer(t);
  const mp3 = validMp3();
  const markdown = `---
title: Concurrent Song
slug: concurrent-song
---

:::audio
title: Concurrent
src: ./audio/final.mp3
:::`;
  const zip = new AdmZip();
  zip.addFile('article.md', Buffer.from(markdown));
  zip.addFile('audio/final.mp3', mp3);
  const bytes = zip.toBuffer();

  const responses = await Promise.all([
    upload(baseUrl, 'concurrent-one.zip', bytes),
    upload(baseUrl, 'concurrent-two.zip', bytes)
  ]);
  const bodies = await Promise.all(responses.map(response => response.json()));
  assert.deepEqual(responses.map(response => response.status), [200, 200], JSON.stringify(bodies));

  const slugs = bodies.map(body => body.article.slug).sort();
  assert.equal(new Set(slugs).size, 2);
  assert.ok(slugs.includes('concurrent-song'));
  assert.ok(slugs.some(slug => /^concurrent-song-\d+$/.test(slug)));

  const db = new Database(path.join(root, 'blog.db'));
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM articles WHERE title = ?').get('Concurrent Song').count, 2);
  db.close();
  for (const slug of slugs) {
    await assert.doesNotReject(() => fs.access(path.join(root, 'articles', `${slug}.md`)));
    const audioFiles = await fs.readdir(path.join(root, 'public', 'audio', slug));
    assert.equal(audioFiles.length, 1);
  }
});

test('serializes deletion against a same-slug replacement upload', async t => {
  const { root, baseUrl } = await prepareServer(t);
  const mp3 = validMp3();
  const hash = crypto.createHash('sha256').update(mp3).digest('hex');
  const markdown = `---
title: Replacement Song
slug: replacement-song
---

:::audio
title: Replacement
src: ./audio/final.mp3
:::`;
  const zip = new AdmZip();
  zip.addFile('article.md', Buffer.from(markdown));
  zip.addFile('audio/final.mp3', mp3);
  const bytes = zip.toBuffer();

  const originalResponse = await upload(baseUrl, 'original.zip', bytes);
  const original = await originalResponse.json();
  assert.equal(originalResponse.status, 200, JSON.stringify(original));

  const [deleteResponse, replacementResponse] = await Promise.all([
    fetch(`${baseUrl}/api/admin/articles/${original.article.id}`, {
      method: 'DELETE',
      headers: { cookie: authCookie() }
    }),
    upload(baseUrl, 'replacement.zip', bytes)
  ]);
  const replacement = await replacementResponse.json();
  assert.equal(deleteResponse.status, 200, await deleteResponse.text());
  assert.equal(replacementResponse.status, 200, JSON.stringify(replacement));

  const db = new Database(path.join(root, 'blog.db'));
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM articles WHERE id = ?').get(original.article.id).count, 0);
  const winner = db.prepare('SELECT id, slug FROM articles WHERE id = ?').get(replacement.article.id);
  db.close();
  assert.equal(winner.slug, replacement.article.slug);
  assert.deepEqual(
    await fs.readFile(path.join(root, 'public', 'audio', winner.slug, `${hash}.mp3`)),
    mp3
  );
  assert.equal((await fetch(`${baseUrl}/audio/${winner.slug}/${hash}.mp3`)).status, 200);

  const articleFiles = await fs.readdir(path.join(root, 'articles'));
  const audioDirectories = await fs.readdir(path.join(root, 'public', 'audio'));
  assert.equal(articleFiles.some(name => name.startsWith('.deleting-')), false);
  assert.equal(audioDirectories.some(name => name.startsWith('.deleting-')), false);
});

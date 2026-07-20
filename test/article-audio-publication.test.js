const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  deleteArticlePublication,
  publishArticle,
  serializeArticlePublication
} = require('../server/article-audio/publication');

async function createFixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'article-audio-publication-'));
  const stagingRoot = path.join(root, 'staging');
  const articlesRoot = path.join(root, 'articles');
  const audioDirectory = path.join(root, 'public', 'audio', 'example-song');
  await fs.mkdir(stagingRoot, { recursive: true });
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return { root, stagingRoot, articlesRoot, audioDirectory };
}

function createAudioAssets(audioDirectory, events, { promoteError, rollbackError } = {}) {
  return {
    async promote() {
      events.push('audio-promote');
      if (promoteError) throw promoteError;
      await fs.mkdir(audioDirectory, { recursive: true });
      await fs.writeFile(path.join(audioDirectory, 'track.mp3'), 'audio');
    },
    async rollback() {
      events.push('audio-rollback');
      if (rollbackError) throw rollbackError;
      await fs.rm(audioDirectory, { recursive: true, force: true });
    }
  };
}

test('publishes staged Markdown and audio before committing SQLite last', async t => {
  const fixture = await createFixture(t);
  const events = [];
  const result = await publishArticle({
    articleSlug: 'example-song',
    markdown: '# Example',
    stagingRoot: fixture.stagingRoot,
    articlesRoot: fixture.articlesRoot,
    audioAssets: createAudioAssets(fixture.audioDirectory, events),
    commitDatabase() {
      events.push('database-commit');
      return { id: 42 };
    }
  });

  assert.deepEqual(result, { id: 42 });
  assert.deepEqual(events, ['audio-promote', 'database-commit']);
  assert.equal(
    await fs.readFile(path.join(fixture.articlesRoot, 'example-song.md'), 'utf8'),
    '# Example'
  );
  assert.equal(await fs.readFile(path.join(fixture.audioDirectory, 'track.mp3'), 'utf8'), 'audio');
});

test('rolls back Markdown and audio when audio promotion fails', async t => {
  const fixture = await createFixture(t);
  const events = [];
  let databaseCalled = false;

  await assert.rejects(
    publishArticle({
      articleSlug: 'example-song',
      markdown: '# Example',
      stagingRoot: fixture.stagingRoot,
      articlesRoot: fixture.articlesRoot,
      audioAssets: createAudioAssets(fixture.audioDirectory, events, {
        promoteError: new Error('injected audio promotion failure')
      }),
      commitDatabase() {
        databaseCalled = true;
      }
    }),
    error => error.code === 'audio_publish_failed'
  );

  assert.equal(databaseCalled, false);
  assert.deepEqual(events, ['audio-promote', 'audio-rollback']);
  await assert.rejects(fs.access(path.join(fixture.articlesRoot, 'example-song.md')), { code: 'ENOENT' });
  await assert.rejects(fs.access(fixture.audioDirectory), { code: 'ENOENT' });
});

test('cleans the Markdown stage and skips later steps when Markdown promotion fails', async t => {
  const fixture = await createFixture(t);
  const events = [];
  let databaseCalled = false;
  const fileSystem = {
    ...fs,
    async link() {
      events.push('markdown-promote');
      throw new Error('injected Markdown promotion failure');
    }
  };

  await assert.rejects(
    publishArticle({
      articleSlug: 'example-song',
      markdown: '# Example',
      stagingRoot: fixture.stagingRoot,
      articlesRoot: fixture.articlesRoot,
      audioAssets: createAudioAssets(fixture.audioDirectory, events),
      commitDatabase() {
        databaseCalled = true;
      },
      fileSystem
    }),
    error => error.code === 'audio_publish_failed'
  );

  assert.equal(databaseCalled, false);
  assert.deepEqual(events, ['markdown-promote', 'audio-rollback']);
  await assert.rejects(fs.access(path.join(fixture.stagingRoot, 'article.md')), { code: 'ENOENT' });
  await assert.rejects(fs.access(path.join(fixture.articlesRoot, 'example-song.md')), { code: 'ENOENT' });
});

test('rolls back promoted files when the SQLite transaction fails', async t => {
  const fixture = await createFixture(t);
  const events = [];

  await assert.rejects(
    publishArticle({
      articleSlug: 'example-song',
      markdown: '# Example',
      stagingRoot: fixture.stagingRoot,
      articlesRoot: fixture.articlesRoot,
      audioAssets: createAudioAssets(fixture.audioDirectory, events),
      commitDatabase() {
        events.push('database-commit');
        throw new Error('injected SQLite failure');
      }
    }),
    error => error.code === 'audio_publish_failed'
  );

  assert.deepEqual(events, ['audio-promote', 'database-commit', 'audio-rollback']);
  await assert.rejects(fs.access(path.join(fixture.articlesRoot, 'example-song.md')), { code: 'ENOENT' });
  await assert.rejects(fs.access(fixture.audioDirectory), { code: 'ENOENT' });
});

test('reports rollback failure without claiming that publication left no residue', async t => {
  const fixture = await createFixture(t);
  const events = [];

  await assert.rejects(
    publishArticle({
      articleSlug: 'example-song',
      markdown: '# Example',
      stagingRoot: fixture.stagingRoot,
      articlesRoot: fixture.articlesRoot,
      audioAssets: createAudioAssets(fixture.audioDirectory, events, {
        rollbackError: new Error('injected rollback failure')
      }),
      commitDatabase() {
        throw new Error('injected SQLite failure');
      }
    }),
    error => error.code === 'article_publish_rollback_failed' && error.status === 500
  );

  assert.deepEqual(events, ['audio-promote', 'audio-rollback']);
  assert.equal(await fs.readFile(path.join(fixture.audioDirectory, 'track.mp3'), 'utf8'), 'audio');
});

test('deletes public article paths before committing the database and removes tombstones', async t => {
  const fixture = await createFixture(t);
  const markdownPath = path.join(fixture.articlesRoot, 'example-song.md');
  await fs.mkdir(fixture.articlesRoot, { recursive: true });
  await fs.writeFile(markdownPath, 'article');
  await fs.mkdir(fixture.audioDirectory, { recursive: true });
  await fs.writeFile(path.join(fixture.audioDirectory, 'track.flac'), 'audio');

  let databaseCommitted = false;
  const result = await deleteArticlePublication({
    articleSlug: 'example-song',
    articlesRoot: fixture.articlesRoot,
    publicAudioRoot: path.dirname(fixture.audioDirectory),
    tombstoneId: 'success',
    async commitDatabase() {
      await assert.rejects(fs.access(markdownPath), { code: 'ENOENT' });
      await assert.rejects(fs.access(fixture.audioDirectory), { code: 'ENOENT' });
      databaseCommitted = true;
      return { changes: 1 };
    }
  });

  assert.equal(databaseCommitted, true);
  assert.deepEqual(result, { changes: 1, cleanupFailed: false });
  assert.deepEqual(await fs.readdir(fixture.articlesRoot), []);
  assert.deepEqual(await fs.readdir(path.dirname(fixture.audioDirectory)), []);
});

test('deletes a long-slug article without exceeding filesystem component limits', async t => {
  const fixture = await createFixture(t);
  const articleSlug = 'a'.repeat(210);
  const markdownPath = path.join(fixture.articlesRoot, `${articleSlug}.md`);
  const audioDirectory = path.join(fixture.root, 'public', 'audio', articleSlug);
  await fs.mkdir(fixture.articlesRoot, { recursive: true });
  await fs.writeFile(markdownPath, 'article');
  await fs.mkdir(audioDirectory, { recursive: true });
  await fs.writeFile(path.join(audioDirectory, 'track.mp3'), 'audio');

  const result = await deleteArticlePublication({
    articleSlug,
    articlesRoot: fixture.articlesRoot,
    publicAudioRoot: path.dirname(audioDirectory),
    commitDatabase: () => ({ changes: 1 })
  });

  assert.deepEqual(result, { changes: 1, cleanupFailed: false });
  await assert.rejects(fs.access(markdownPath), { code: 'ENOENT' });
  await assert.rejects(fs.access(audioDirectory), { code: 'ENOENT' });
});

test('does not treat a rename ENOENT as a missing source when the source still exists', async t => {
  const fixture = await createFixture(t);
  const markdownPath = path.join(fixture.articlesRoot, 'example-song.md');
  await fs.mkdir(fixture.articlesRoot, { recursive: true });
  await fs.writeFile(markdownPath, 'article');
  await fs.mkdir(fixture.audioDirectory, { recursive: true });
  await fs.writeFile(path.join(fixture.audioDirectory, 'track.mp3'), 'audio');
  let databaseCalled = false;
  const fileSystem = {
    ...fs,
    async rename(source, destination) {
      if (source === markdownPath) {
        throw Object.assign(new Error('injected rename ENOENT'), { code: 'ENOENT' });
      }
      return fs.rename(source, destination);
    }
  };

  await assert.rejects(
    deleteArticlePublication({
      articleSlug: 'example-song',
      articlesRoot: fixture.articlesRoot,
      publicAudioRoot: path.dirname(fixture.audioDirectory),
      fileSystem,
      commitDatabase() {
        databaseCalled = true;
        return { changes: 1 };
      }
    }),
    error => error.code === 'article_delete_failed'
  );

  assert.equal(databaseCalled, false);
  assert.equal(await fs.readFile(markdownPath, 'utf8'), 'article');
  assert.equal(await fs.readFile(path.join(fixture.audioDirectory, 'track.mp3'), 'utf8'), 'audio');
});

test('continues database deletion when public resources are genuinely missing', async t => {
  const fixture = await createFixture(t);
  let databaseCalled = false;

  const result = await deleteArticlePublication({
    articleSlug: 'missing-song',
    articlesRoot: fixture.articlesRoot,
    publicAudioRoot: path.join(fixture.root, 'public', 'audio'),
    async commitDatabase() {
      databaseCalled = true;
      return { changes: 1 };
    }
  });

  assert.equal(databaseCalled, true);
  assert.deepEqual(result, { changes: 1, cleanupFailed: false });
});

test('restores article paths when the database delete fails', async t => {
  const fixture = await createFixture(t);
  const markdownPath = path.join(fixture.articlesRoot, 'example-song.md');
  await fs.mkdir(fixture.articlesRoot, { recursive: true });
  await fs.writeFile(markdownPath, 'article');
  await fs.mkdir(fixture.audioDirectory, { recursive: true });
  await fs.writeFile(path.join(fixture.audioDirectory, 'track.aac'), 'audio');

  await assert.rejects(
    deleteArticlePublication({
      articleSlug: 'example-song',
      articlesRoot: fixture.articlesRoot,
      publicAudioRoot: path.dirname(fixture.audioDirectory),
      tombstoneId: 'database-failure',
      commitDatabase() {
        throw new Error('injected database delete failure');
      }
    }),
    error => error.code === 'article_delete_failed'
  );

  assert.equal(await fs.readFile(markdownPath, 'utf8'), 'article');
  assert.equal(await fs.readFile(path.join(fixture.audioDirectory, 'track.aac'), 'utf8'), 'audio');
});

test('does not delete the database when moving a public path fails', async t => {
  const fixture = await createFixture(t);
  const markdownPath = path.join(fixture.articlesRoot, 'example-song.md');
  await fs.mkdir(fixture.articlesRoot, { recursive: true });
  await fs.writeFile(markdownPath, 'article');
  await fs.mkdir(fixture.audioDirectory, { recursive: true });
  await fs.writeFile(path.join(fixture.audioDirectory, 'track.m4a'), 'audio');
  let databaseCalled = false;
  let renameCount = 0;
  const fileSystem = {
    ...fs,
    async rename(source, destination) {
      renameCount += 1;
      if (renameCount === 2) throw Object.assign(new Error('injected rename failure'), { code: 'EACCES' });
      return fs.rename(source, destination);
    }
  };

  await assert.rejects(
    deleteArticlePublication({
      articleSlug: 'example-song',
      articlesRoot: fixture.articlesRoot,
      publicAudioRoot: path.dirname(fixture.audioDirectory),
      tombstoneId: 'rename-failure',
      fileSystem,
      commitDatabase() {
        databaseCalled = true;
      }
    }),
    error => error.code === 'article_delete_failed'
  );

  assert.equal(databaseCalled, false);
  assert.equal(await fs.readFile(markdownPath, 'utf8'), 'article');
  assert.equal(await fs.readFile(path.join(fixture.audioDirectory, 'track.m4a'), 'utf8'), 'audio');
});

test('reports tombstone cleanup debt only after public paths are inaccessible', async t => {
  const fixture = await createFixture(t);
  const markdownPath = path.join(fixture.articlesRoot, 'example-song.md');
  await fs.mkdir(fixture.articlesRoot, { recursive: true });
  await fs.writeFile(markdownPath, 'article');
  await fs.mkdir(fixture.audioDirectory, { recursive: true });
  await fs.writeFile(path.join(fixture.audioDirectory, 'track.flac'), 'audio');
  const fileSystem = {
    ...fs,
    async rm(target, options) {
      if (path.basename(target).startsWith('.deleting-')) {
        throw Object.assign(new Error('injected tombstone cleanup failure'), { code: 'EACCES' });
      }
      return fs.rm(target, options);
    }
  };

  const result = await deleteArticlePublication({
    articleSlug: 'example-song',
    articlesRoot: fixture.articlesRoot,
    publicAudioRoot: path.dirname(fixture.audioDirectory),
    tombstoneId: 'cleanup-failure',
    fileSystem,
    commitDatabase: () => ({ changes: 1 })
  });

  assert.deepEqual(result, { changes: 1, cleanupFailed: true });
  await assert.rejects(fs.access(markdownPath), { code: 'ENOENT' });
  await assert.rejects(fs.access(fixture.audioDirectory), { code: 'ENOENT' });
  assert.equal(
    (await fs.readdir(fixture.articlesRoot)).some(name => name.startsWith('.deleting-')),
    true
  );
  assert.equal(
    (await fs.readdir(path.dirname(fixture.audioDirectory))).some(name => name.startsWith('.deleting-')),
    true
  );
});

test('a losing concurrent publication cannot remove the winner Markdown', async t => {
  const fixture = await createFixture(t);
  let releaseWinner;
  const winnerMayCommit = new Promise(resolve => { releaseWinner = resolve; });
  let winnerPromoted;
  const winnerPromotedPromise = new Promise(resolve => { winnerPromoted = resolve; });

  const winner = publishArticle({
    articleSlug: 'example-song',
    markdown: 'winner',
    stagingRoot: path.join(fixture.root, 'winner-stage'),
    articlesRoot: fixture.articlesRoot,
    audioAssets: createAudioAssets(path.join(fixture.root, 'winner-audio'), []),
    async commitDatabase() {
      winnerPromoted();
      await winnerMayCommit;
      return { id: 1 };
    }
  });
  await winnerPromotedPromise;

  const loser = publishArticle({
    articleSlug: 'example-song',
    markdown: 'loser',
    stagingRoot: path.join(fixture.root, 'loser-stage'),
    articlesRoot: fixture.articlesRoot,
    audioAssets: createAudioAssets(path.join(fixture.root, 'loser-audio'), []),
    commitDatabase() {
      throw new Error('injected SQLite UNIQUE failure');
    }
  });

  await assert.rejects(loser, error => error.code === 'audio_publish_failed');
  releaseWinner();
  await winner;
  assert.equal(
    await fs.readFile(path.join(fixture.articlesRoot, 'example-song.md'), 'utf8'),
    'winner'
  );
});

test('serializes slug selection and publication work in call order', async () => {
  const events = [];
  let releaseFirst;
  const firstMayFinish = new Promise(resolve => { releaseFirst = resolve; });

  const first = serializeArticlePublication(async () => {
    events.push('first-start');
    await firstMayFinish;
    events.push('first-end');
  });
  const second = serializeArticlePublication(async () => {
    events.push('second-start');
    events.push('second-end');
  });

  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(events, ['first-start']);
  releaseFirst();
  await Promise.all([first, second]);
  assert.deepEqual(events, ['first-start', 'first-end', 'second-start', 'second-end']);
});

test('the admin route never retries final-resource rollback after releasing the serializer', async () => {
  const source = await fs.readFile(
    path.resolve(__dirname, '..', 'server', 'routes', 'admin.js'),
    'utf8'
  );
  const serializedStart = source.indexOf('serializeArticlePublication(async () => {');
  const serializedEnd = source.indexOf('\n    });\n    \n    return res.json', serializedStart);
  const rollbackOffsets = [...source.matchAll(/audioAssets\.rollback\(\)/g)].map(match => match.index);

  assert.ok(serializedStart >= 0 && serializedEnd > serializedStart);
  assert.equal(rollbackOffsets.length, 1);
  assert.ok(rollbackOffsets[0] > serializedStart && rollbackOffsets[0] < serializedEnd);

  const deleteRouteStart = source.indexOf("router.delete('/articles/:id'");
  const deleteSerializedStart = source.indexOf(
    'serializeArticlePublication(async () => {',
    deleteRouteStart
  );
  const deleteCall = source.indexOf('deleteArticlePublication({', deleteSerializedStart);
  const deleteSerializedEnd = source.indexOf('\n    });', deleteCall);
  assert.ok(deleteRouteStart >= 0);
  assert.ok(deleteSerializedStart > deleteRouteStart);
  assert.ok(deleteCall > deleteSerializedStart && deleteCall < deleteSerializedEnd);
});

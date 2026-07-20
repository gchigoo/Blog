const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const {
  buildArchiveEntryIndex,
  prepareArticleAudioAssets,
  resolveAudioEntryName,
  validateMp3Buffer
} = require('../server/article-audio/assets');
const {
  mpeg1Layer3Frame,
  validAac,
  validFlac,
  validMp3
} = require('./helpers/article-audio-fixtures');

function entry(entryName, size = 1) {
  return { entryName, isDirectory: false, header: { size } };
}

function dataEntry(entryName, data, declaredSize = data.length) {
  return {
    entryName,
    isDirectory: false,
    header: { size: declaredSize },
    getData: () => Buffer.from(data)
  };
}

test('resolves audio paths relative to the Markdown entry directory', () => {
  assert.equal(
    resolveAudioEntryName('posts/entry.md', './audio/song.mp3'),
    'posts/audio/song.mp3'
  );
  assert.equal(
    resolveAudioEntryName('posts/deep/entry.md', '../audio/song%20mix.mp3'),
    'posts/audio/song%20mix.mp3'
  );
  assert.equal(
    resolveAudioEntryName('entry.md', 'audio/song.mp3'),
    'audio/song.mp3'
  );
});

test('rejects unsafe or ambiguous author audio paths', () => {
  for (const source of [
    '/audio/song.mp3',
    '../../song.mp3',
    'audio\\song.mp3',
    'https://example.com/song.mp3',
    'audio/song.mp3?download=1',
    'audio/song.mp3#clip'
  ]) {
    assert.throws(
      () => resolveAudioEntryName('posts/entry.md', source),
      error => error.code === 'audio_path_invalid' && error.status === 400
    );
  }
});

test('indexes ZIP entries case-sensitively and rejects normalized duplicates', () => {
  const index = buildArchiveEntryIndex([
    entry('posts/entry.md', 10),
    entry('posts/audio/Song.mp3', 20),
    entry('posts/audio/song.mp3', 30)
  ]);

  assert.equal(index.get('posts/audio/Song.mp3').header.size, 20);
  assert.equal(index.get('posts/audio/song.mp3').header.size, 30);

  assert.throws(
    () => buildArchiveEntryIndex([
      entry('posts/audio/song.mp3'),
      entry('posts/audio/./song.mp3')
    ]),
    error => error.code === 'audio_archive_ambiguous' && error.status === 400
  );
});

test('rejects archives whose declared expanded size exceeds 100 MiB', () => {
  assert.doesNotThrow(() => buildArchiveEntryIndex([
    entry('entry.md', 60 * 1024 * 1024),
    entry('audio/song.mp3', 40 * 1024 * 1024)
  ]));
  assert.throws(
    () => buildArchiveEntryIndex([
      entry('entry.md', 60 * 1024 * 1024),
      entry('audio/song.mp3', 41 * 1024 * 1024)
    ]),
    error => error.code === 'archive_expanded_too_large' && error.status === 413
  );
});

test('applies inclusive declared and actual size limits for lossy and FLAC assets', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'blog-audio-limits-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const publicAudioRoot = path.join(root, 'public', 'audio');

  const exactMp3 = await prepareArticleAudioAssets({
    articleSlug: 'exact-mp3',
    markdownEntryName: 'entry.md',
    audioBlocks: [{ title: 'MP3', src: './audio/song.mp3' }],
    archiveEntries: [
      dataEntry('entry.md', Buffer.from('# post')),
      dataEntry('audio/song.mp3', validMp3(), 20 * 1024 * 1024)
    ],
    stagingRoot: path.join(root, 'stage-mp3'),
    publicAudioRoot
  });
  await exactMp3.rollback();

  const exactFlac = await prepareArticleAudioAssets({
    articleSlug: 'exact-flac',
    markdownEntryName: 'entry.md',
    audioBlocks: [{ title: 'FLAC', src: './audio/song.flac' }],
    archiveEntries: [
      dataEntry('entry.md', Buffer.from('# post')),
      dataEntry('audio/song.flac', validFlac(), 50 * 1024 * 1024)
    ],
    stagingRoot: path.join(root, 'stage-flac'),
    publicAudioRoot
  });
  await exactFlac.rollback();

  const base = {
    markdownEntryName: 'entry.md',
    audioBlocks: [{ title: 'Too large', src: './audio/song.mp3' }],
    publicAudioRoot
  };
  await assert.rejects(
    () => prepareArticleAudioAssets({
      ...base,
      articleSlug: 'declared-mp3-large',
      archiveEntries: [
        dataEntry('entry.md', Buffer.from('# post')),
        dataEntry('audio/song.mp3', validMp3(), 20 * 1024 * 1024 + 1)
      ],
      stagingRoot: path.join(root, 'stage-declared-mp3')
    }),
    error => error.code === 'audio_asset_too_large' && error.status === 413
  );

  await assert.rejects(
    () => prepareArticleAudioAssets({
      ...base,
      articleSlug: 'declared-flac-large',
      audioBlocks: [{ title: 'Too large', src: './audio/song.flac' }],
      archiveEntries: [
        dataEntry('entry.md', Buffer.from('# post')),
        dataEntry('audio/song.flac', validFlac(), 50 * 1024 * 1024 + 1)
      ],
      stagingRoot: path.join(root, 'stage-declared-flac')
    }),
    error => error.code === 'audio_asset_too_large' && error.status === 413
  );

  const actualLarge = Buffer.alloc(20 * 1024 * 1024 + 1);
  await assert.rejects(
    () => prepareArticleAudioAssets({
      ...base,
      articleSlug: 'actual-large',
      archiveEntries: [
        dataEntry('entry.md', Buffer.from('# post')),
        dataEntry('audio/song.mp3', actualLarge, 1)
      ],
      stagingRoot: path.join(root, 'stage-actual')
    }),
    error => error.code === 'audio_asset_too_large' && error.status === 413
  );
});

test('accepts two complete consecutive MPEG frames and rejects weak signatures', () => {
  assert.doesNotThrow(() => validateMp3Buffer(validMp3()));

  const id3 = Buffer.from([0x49, 0x44, 0x33, 0x04, 0x00, 0x00, 0, 0, 0, 0]);
  assert.doesNotThrow(() => validateMp3Buffer(Buffer.concat([id3, validMp3()])));

  for (const invalid of [
    Buffer.alloc(0),
    mpeg1Layer3Frame(),
    Buffer.concat([mpeg1Layer3Frame(), Buffer.alloc(20), mpeg1Layer3Frame()]),
    Buffer.from('ID3\x04\x00\x00\x00\x00\x00\x00')
  ]) {
    assert.throws(
      () => validateMp3Buffer(invalid),
      error => error.code === 'audio_content_invalid' && error.status === 400
    );
  }
});

test('stages, deduplicates, promotes, and idempotently rolls back article audio', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'blog-audio-assets-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const stagingRoot = path.join(root, 'staging');
  const publicAudioRoot = path.join(root, 'public', 'audio');
  const audio = validMp3();
  const hash = crypto.createHash('sha256').update(audio).digest('hex');

  const prepared = await prepareArticleAudioAssets({
    articleSlug: 'audio-post',
    markdownEntryName: 'posts/entry.md',
    audioBlocks: [
      { title: 'One', src: './audio/song.mp3' },
      { title: 'Again', src: './audio/song.mp3' }
    ],
    archiveEntries: [
      dataEntry('posts/entry.md', Buffer.from('# post')),
      dataEntry('posts/audio/song.mp3', audio)
    ],
    stagingRoot,
    publicAudioRoot
  });

  assert.equal(prepared.publishedCount, 1);
  assert.deepEqual(prepared.resolvedBlocks.map(block => block.src), [
    `/audio/audio-post/${hash}.mp3`,
    `/audio/audio-post/${hash}.mp3`
  ]);
  await assert.doesNotReject(() => fs.access(path.join(stagingRoot, 'article-audio', `${hash}.mp3`)));
  await assert.rejects(() => fs.access(path.join(publicAudioRoot, 'audio-post', `${hash}.mp3`)));

  await prepared.promote();
  await prepared.promote();
  await assert.doesNotReject(() => fs.access(path.join(publicAudioRoot, 'audio-post', `${hash}.mp3`)));

  await prepared.rollback();
  await prepared.rollback();
  await assert.rejects(() => fs.access(path.join(publicAudioRoot, 'audio-post')));
});

test('stages mixed AAC and FLAC assets with canonical MIME and original extensions', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'blog-audio-mixed-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const stagingRoot = path.join(root, 'staging');
  const publicAudioRoot = path.join(root, 'public', 'audio');
  const aac = validAac();
  const flac = validFlac();
  let aacReads = 0;

  const prepared = await prepareArticleAudioAssets({
    articleSlug: 'mixed-audio',
    markdownEntryName: 'entry.md',
    audioBlocks: [
      { title: 'AAC', src: './audio/song.aac' },
      { title: 'AAC again', src: './audio/song.aac' },
      { title: 'FLAC', src: './audio/song.flac' }
    ],
    archiveEntries: [
      dataEntry('entry.md', Buffer.from('# post')),
      {
        ...dataEntry('audio/song.aac', aac),
        getData: () => {
          aacReads += 1;
          return Buffer.from(aac);
        }
      },
      dataEntry('audio/song.flac', flac)
    ],
    stagingRoot,
    publicAudioRoot
  });

  assert.equal(prepared.publishedCount, 2);
  assert.equal(aacReads, 1);
  assert.deepEqual(
    prepared.resolvedBlocks.map(block => ({ src: block.src, mimeType: block.mimeType })),
    [
      { src: `/audio/mixed-audio/${crypto.createHash('sha256').update(aac).digest('hex')}.aac`, mimeType: 'audio/aac' },
      { src: `/audio/mixed-audio/${crypto.createHash('sha256').update(aac).digest('hex')}.aac`, mimeType: 'audio/aac' },
      { src: `/audio/mixed-audio/${crypto.createHash('sha256').update(flac).digest('hex')}.flac`, mimeType: 'audio/flac' }
    ]
  );
  await prepared.promote();
  await assert.doesNotReject(() => fs.access(path.join(
    publicAudioRoot,
    'mixed-audio',
    `${crypto.createHash('sha256').update(aac).digest('hex')}.aac`
  )));
  await assert.doesNotReject(() => fs.access(path.join(
    publicAudioRoot,
    'mixed-audio',
    `${crypto.createHash('sha256').update(flac).digest('hex')}.flac`
  )));
  await prepared.rollback();
  await assert.rejects(fs.access(path.join(publicAudioRoot, 'mixed-audio')), { code: 'ENOENT' });
});

test('removes already staged mixed-format assets when a later entry is invalid', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'blog-audio-stage-cleanup-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const stagingRoot = path.join(root, 'staging');

  await assert.rejects(
    () => prepareArticleAudioAssets({
      articleSlug: 'mixed-invalid',
      markdownEntryName: 'entry.md',
      audioBlocks: [
        { title: 'AAC', src: './audio/song.aac' },
        { title: 'Bad FLAC', src: './audio/bad.flac' }
      ],
      archiveEntries: [
        dataEntry('entry.md', Buffer.from('# post')),
        dataEntry('audio/song.aac', validAac()),
        dataEntry('audio/bad.flac', Buffer.from('fLaC'))
      ],
      stagingRoot,
      publicAudioRoot: path.join(root, 'public', 'audio')
    }),
    error => error.code === 'audio_content_invalid' && error.status === 400
  );
  await assert.rejects(fs.access(path.join(stagingRoot, 'article-audio')), { code: 'ENOENT' });
});

test('reuses an identical published hash without claiming ownership during rollback', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'blog-audio-reuse-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const stagingRoot = path.join(root, 'staging');
  const publicAudioRoot = path.join(root, 'public', 'audio');
  const finalDirectory = path.join(publicAudioRoot, 'audio-post');
  const audio = validMp3();
  const hash = crypto.createHash('sha256').update(audio).digest('hex');
  await fs.mkdir(finalDirectory, { recursive: true });
  await fs.writeFile(path.join(finalDirectory, `${hash}.mp3`), audio);

  const prepared = await prepareArticleAudioAssets({
    articleSlug: 'audio-post',
    markdownEntryName: 'entry.md',
    audioBlocks: [{ title: 'Existing', src: './audio/song.mp3' }],
    archiveEntries: [
      dataEntry('entry.md', Buffer.from('# post')),
      dataEntry('audio/song.mp3', audio)
    ],
    stagingRoot,
    publicAudioRoot
  });

  await prepared.promote();
  await prepared.promote();
  await prepared.rollback();
  assert.deepEqual(await fs.readFile(path.join(finalDirectory, `${hash}.mp3`)), audio);
});

test('reuses an existing mixed-format directory without claiming its files', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'blog-audio-mixed-reuse-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const stagingRoot = path.join(root, 'staging');
  const publicAudioRoot = path.join(root, 'public', 'audio');
  const finalDirectory = path.join(publicAudioRoot, 'mixed-audio');
  const aac = validAac();
  const flac = validFlac();
  const aacName = `${crypto.createHash('sha256').update(aac).digest('hex')}.aac`;
  const flacName = `${crypto.createHash('sha256').update(flac).digest('hex')}.flac`;
  await fs.mkdir(finalDirectory, { recursive: true });
  await fs.writeFile(path.join(finalDirectory, aacName), aac);
  await fs.writeFile(path.join(finalDirectory, flacName), flac);

  const prepared = await prepareArticleAudioAssets({
    articleSlug: 'mixed-audio',
    markdownEntryName: 'entry.md',
    audioBlocks: [
      { title: 'AAC', src: './audio/song.aac' },
      { title: 'FLAC', src: './audio/song.flac' }
    ],
    archiveEntries: [
      dataEntry('entry.md', Buffer.from('# post')),
      dataEntry('audio/song.aac', aac),
      dataEntry('audio/song.flac', flac)
    ],
    stagingRoot,
    publicAudioRoot
  });

  await prepared.promote();
  await prepared.rollback();
  assert.deepEqual(await fs.readFile(path.join(finalDirectory, aacName)), aac);
  assert.deepEqual(await fs.readFile(path.join(finalDirectory, flacName)), flac);
});

test('rejects a conflicting published hash without overwriting either side', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'blog-audio-conflict-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const stagingRoot = path.join(root, 'staging');
  const publicAudioRoot = path.join(root, 'public', 'audio');
  const finalDirectory = path.join(publicAudioRoot, 'audio-post');
  const audio = validMp3();
  const hash = crypto.createHash('sha256').update(audio).digest('hex');
  const conflict = Buffer.from('conflicting published file');
  await fs.mkdir(finalDirectory, { recursive: true });
  await fs.writeFile(path.join(finalDirectory, `${hash}.mp3`), conflict);

  const prepared = await prepareArticleAudioAssets({
    articleSlug: 'audio-post',
    markdownEntryName: 'entry.md',
    audioBlocks: [{ title: 'Conflict', src: './audio/song.mp3' }],
    archiveEntries: [
      dataEntry('entry.md', Buffer.from('# post')),
      dataEntry('audio/song.mp3', audio)
    ],
    stagingRoot,
    publicAudioRoot
  });

  await assert.rejects(
    () => prepared.promote(),
    error => error.code === 'audio_publish_failed' && error.status === 500
  );
  assert.deepEqual(await fs.readFile(path.join(finalDirectory, `${hash}.mp3`)), conflict);
  await assert.doesNotReject(() => fs.access(path.join(stagingRoot, 'article-audio', `${hash}.mp3`)));
  await prepared.rollback();
  assert.deepEqual(await fs.readFile(path.join(finalDirectory, `${hash}.mp3`)), conflict);
});

test('rejects missing, unsupported, oversized, and forged audio assets before staging', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'blog-audio-invalid-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));

  const base = {
    articleSlug: 'audio-post',
    markdownEntryName: 'entry.md',
    stagingRoot: path.join(root, 'staging'),
    publicAudioRoot: path.join(root, 'public', 'audio')
  };

  const cases = [
    {
      block: { title: 'Missing', src: './audio/missing.mp3' },
      entries: [],
      code: 'audio_asset_missing',
      status: 400
    },
    {
      block: { title: 'Wave', src: './audio/song.wav' },
      entries: [dataEntry('audio/song.wav', validMp3())],
      code: 'audio_format_unsupported',
      status: 400
    },
    {
      block: { title: 'Uppercase', src: './audio/song.FLAC' },
      entries: [dataEntry('audio/song.FLAC', validFlac())],
      code: 'audio_format_unsupported',
      status: 400
    },
    {
      block: { title: 'Large', src: './audio/song.mp3' },
      entries: [dataEntry('audio/song.mp3', validMp3(), 20 * 1024 * 1024 + 1)],
      code: 'audio_asset_too_large',
      status: 413
    },
    {
      block: { title: 'Forged', src: './audio/song.mp3' },
      entries: [dataEntry('audio/song.mp3', Buffer.from([0xff, 0xfb, 0x90, 0x64]))],
      code: 'audio_content_invalid',
      status: 400
    },
    {
      block: { title: 'Mismatched', src: './audio/song.aac' },
      entries: [dataEntry('audio/song.aac', validMp3())],
      code: 'audio_content_invalid',
      status: 400
    }
  ];

  for (const item of cases) {
    await assert.rejects(
      () => prepareArticleAudioAssets({
        ...base,
        audioBlocks: [item.block],
        archiveEntries: [dataEntry('entry.md', Buffer.from('# post')), ...item.entries]
      }),
      error => error.code === item.code && error.status === item.status
    );
  }

  await assert.rejects(() => fs.access(path.join(base.stagingRoot, 'article-audio')));
});

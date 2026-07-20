const test = require('node:test');
const assert = require('node:assert/strict');

const {
  parseMarkdown,
  parseMarkdownDocument,
  renderMarkdown
} = require('../server/utils/markdown');

const VALID_BLOCK = `:::audio
title: Stay Until Tomorrow
artist: AI Bieber Experiment
src: ./audio/stay.mp3
caption: Final mix
:::`;
const HASH_ONE = 'a'.repeat(64);
const HASH_TWO = 'b'.repeat(64);

test('collects article audio blocks without treating fenced code as audio', () => {
  const document = parseMarkdownDocument(`---
title: Audio Post
slug: audio-post
---

\`\`\`markdown
${VALID_BLOCK}
\`\`\`

${VALID_BLOCK}`);

  assert.equal(document.audioBlocks.length, 1);
  assert.deepEqual(document.audioBlocks[0], {
    title: 'Stay Until Tomorrow',
    artist: 'AI Bieber Experiment',
    src: './audio/stay.mp3',
    caption: 'Final mix'
  });
});

test('renders fixed safe audio DOM and emits the stylesheet once', () => {
  const markdown = `${VALID_BLOCK}

:::audio
title: <img src=x onerror=alert(1)>
src: ./audio/second.flac
:::`;
  const html = renderMarkdown(markdown, {
    resolvedAudioBlocks: [
      {
        title: 'Stay Until Tomorrow',
        artist: 'AI Bieber Experiment',
        src: `/audio/audio-post/${HASH_ONE}.mp3`,
        mimeType: 'audio/mpeg',
        caption: 'Final mix'
      },
      {
        title: '<img src=x onerror=alert(1)>',
        src: `/audio/audio-post/${HASH_TWO}.flac`,
        mimeType: 'audio/flac'
      }
    ]
  });

  assert.equal((html.match(/data-article-audio-styles/g) || []).length, 1);
  assert.equal((html.match(/<figure class="article-audio">/g) || []).length, 2);
  assert.match(html, /id="article-audio-title-1"/);
  assert.match(html, /aria-labelledby="article-audio-title-2"/);
  assert.match(html, /controls preload="metadata"/);
  assert.match(html, new RegExp(`<source src="/audio/audio-post/${HASH_ONE}\\.mp3" type="audio/mpeg">`));
  assert.match(html, new RegExp(`<source src="/audio/audio-post/${HASH_TWO}\\.flac" type="audio/flac">`));
  assert.match(html, new RegExp(`</audio>\\s*<a class="article-audio__fallback" href="/audio/audio-post/${HASH_TWO}\\.flac"`));
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.doesNotMatch(html, /<img src=x/);
  assert.doesNotMatch(html, /autoplay/i);
});

test('rejects unresolved and malformed article audio blocks with stable codes', () => {
  assert.throws(
    () => parseMarkdown(`---\ntitle: Audio\n---\n\n${VALID_BLOCK}`),
    error => error.code === 'audio_archive_required' && error.status === 400
  );

  for (const markdown of [
    ':::audio\nsrc: ./audio/a.mp3\n:::',
    ':::audio\ntitle: A\nsrc: ./audio/a.mp3\nunknown: x\n:::',
    ':::audio\ntitle: A\ntitle: B\nsrc: ./audio/a.mp3\n:::',
    ':::audio\ntitle: A\nsrc: ./audio/a.mp3'
  ]) {
    assert.throws(
      () => parseMarkdownDocument(markdown),
      error => error.code === 'audio_block_invalid' && error.status === 400
    );
  }
});

test('keeps raw Markdown HTML disabled when audio rendering is enabled', () => {
  const html = renderMarkdown(`<script>alert(1)</script>

${VALID_BLOCK}`, {
    resolvedAudioBlocks: [{
      title: 'Stay Until Tomorrow',
      artist: 'AI Bieber Experiment',
      src: `/audio/audio-post/${HASH_ONE}.mp3`,
      mimeType: 'audio/mpeg',
      caption: 'Final mix'
    }]
  });

  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.doesNotMatch(html, /<script>/);
});

test('rejects author paths, unsupported casing, and MIME mismatches at render time', () => {
  for (const resolved of [
    { src: './audio/stay.mp3', mimeType: 'audio/mpeg' },
    { src: `/audio/audio-post/${HASH_ONE}.FLAC`, mimeType: 'audio/flac' },
    { src: `/audio/audio-post/${HASH_ONE}.flac`, mimeType: 'audio/mpeg' }
  ]) {
    assert.throws(
      () => renderMarkdown(VALID_BLOCK, { resolvedAudioBlocks: [resolved] }),
      error => error.code === 'audio_publish_failed' && error.status === 500
    );
  }
});

test('derives typed sources for every registered article audio format', () => {
  const formats = [
    ['mp3', 'audio/mpeg'],
    ['aac', 'audio/aac'],
    ['m4a', 'audio/mp4'],
    ['flac', 'audio/flac']
  ];
  const markdown = formats
    .map(([extension], index) => `:::audio\ntitle: Track ${index}\nsrc: ./track.${extension}\n:::`)
    .join('\n\n');
  const html = renderMarkdown(markdown, {
    resolvedAudioBlocks: formats.map(([extension, mimeType], index) => ({
      src: `/audio/audio-post/${String(index + 1).repeat(64)}.${extension}`,
      mimeType
    }))
  });

  for (const [extension, mimeType] of formats) {
    assert.match(html, new RegExp(`\\.${extension}" type="${mimeType}"`));
  }
});

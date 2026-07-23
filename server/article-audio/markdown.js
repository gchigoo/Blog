const { articleAudioError } = require('./errors');
const { AUDIO_FORMATS } = require('./formats');
const { assetUrl } = require('../utils/presentation');

const AUDIO_OPEN_MARKER = ':::audio';
const AUDIO_CLOSE_MARKER = ':::';
const AUDIO_FIELDS = new Set(['title', 'artist', 'src', 'caption']);
const PUBLISHED_AUDIO_PATH = new RegExp(
  `^/audio/[a-z0-9]+(?:-[a-z0-9]+)*/[a-f0-9]{64}(${Object.keys(AUDIO_FORMATS)
    .map(extension => extension.replace('.', '\\.'))
    .join('|')})$`
);

const FIELD_LIMITS = Object.freeze({
  title: 120,
  artist: 120,
  caption: 300
});

function invalidBlock(message) {
  return articleAudioError(400, 'audio_block_invalid', message);
}

function lineText(state, line) {
  const start = state.bMarks[line] + state.tShift[line];
  return state.src.slice(start, state.eMarks[line]);
}

function parseFields(state, startLine, closeLine) {
  const fields = Object.create(null);

  for (let line = startLine + 1; line < closeLine; line += 1) {
    const text = lineText(state, line).trim();
    if (!text) continue;

    const separator = text.indexOf(':');
    if (separator <= 0) {
      throw invalidBlock('音频块字段必须使用 key: value 格式');
    }

    const key = text.slice(0, separator).trim();
    const value = text.slice(separator + 1).trim();
    if (!AUDIO_FIELDS.has(key)) {
      throw invalidBlock(`音频块包含未知字段: ${key}`);
    }
    if (Object.hasOwn(fields, key)) {
      throw invalidBlock(`音频块字段重复: ${key}`);
    }
    if (!value) {
      throw invalidBlock(`音频块字段不能为空: ${key}`);
    }
    fields[key] = value;
  }

  for (const required of ['title', 'src']) {
    if (!Object.hasOwn(fields, required)) {
      throw invalidBlock(`音频块缺少必填字段: ${required}`);
    }
  }

  for (const [field, limit] of Object.entries(FIELD_LIMITS)) {
    if (fields[field] && [...fields[field]].length > limit) {
      throw invalidBlock(`音频块字段过长: ${field}`);
    }
  }

  return {
    title: fields.title,
    ...(fields.artist ? { artist: fields.artist } : {}),
    src: fields.src,
    ...(fields.caption ? { caption: fields.caption } : {})
  };
}

function articleAudioBlockRule(state, startLine, endLine, silent) {
  if (lineText(state, startLine).trim() !== AUDIO_OPEN_MARKER) return false;

  let closeLine = startLine + 1;
  while (closeLine < endLine && lineText(state, closeLine).trim() !== AUDIO_CLOSE_MARKER) {
    closeLine += 1;
  }
  if (closeLine >= endLine) {
    throw invalidBlock('音频块缺少结束标记 :::');
  }
  if (silent) return true;

  const block = parseFields(state, startLine, closeLine);
  const articleAudio = state.env.articleAudio || (state.env.articleAudio = {});
  const blocks = articleAudio.blocks || (articleAudio.blocks = []);
  const index = blocks.length;
  blocks.push(block);

  const token = state.push('article_audio', '', 0);
  token.block = true;
  token.map = [startLine, closeLine + 1];
  token.meta = { block, index };
  state.line = closeLine + 1;
  return true;
}

function renderArticleAudio(tokens, index, _options, env, renderer) {
  const { block, index: blockIndex } = tokens[index].meta;
  const articleAudio = env.articleAudio || {};
  const resolved = articleAudio.resolvedAudioBlocks?.[blockIndex];
  if (!resolved) {
    throw articleAudioError(400, 'audio_archive_required', '包含音频块的文章必须使用 ZIP 上传');
  }
  const pathMatch = PUBLISHED_AUDIO_PATH.exec(resolved.src);
  const format = pathMatch ? AUDIO_FORMATS[pathMatch[1]] : null;
  if (!format || resolved.mimeType !== format.mimeType) {
    throw articleAudioError(500, 'audio_publish_failed', '音频发布路径无效');
  }

  const escape = renderer.utils.escapeHtml;
  const titleId = `article-audio-title-${blockIndex + 1}`;
  const src = escape(resolved.src);
  const mimeType = escape(format.mimeType);
  const parts = [];

  if (!articleAudio.styleEmitted) {
    parts.push(`<link rel="stylesheet" href="${assetUrl('/css/article-audio.css')}" data-article-audio-styles>`);
    articleAudio.styleEmitted = true;
  }

  parts.push('<figure class="article-audio">');
  parts.push('<figcaption class="article-audio__meta">');
  parts.push(`<strong id="${titleId}" class="article-audio__title">${escape(block.title)}</strong>`);
  if (block.artist) {
    parts.push(`<span class="article-audio__artist">${escape(block.artist)}</span>`);
  }
  parts.push('</figcaption>');
  parts.push(
    `<audio class="article-audio__control" controls preload="metadata" aria-labelledby="${titleId}">`
  );
  parts.push(`<source src="${src}" type="${mimeType}">`);
  parts.push('</audio>');
  parts.push(`<a class="article-audio__fallback" href="${src}">无法播放时打开音频文件</a>`);
  if (block.caption) {
    parts.push(`<p class="article-audio__caption">${escape(block.caption)}</p>`);
  }
  parts.push('</figure>');
  return `${parts.join('\n')}\n`;
}

function installArticleAudioMarkdown(md) {
  md.block.ruler.before('fence', 'article_audio', articleAudioBlockRule, {
    alt: ['paragraph', 'reference', 'blockquote', 'list']
  });
  md.renderer.rules.article_audio = (tokens, index, options, env) => (
    renderArticleAudio(tokens, index, options, env, md)
  );
}

function collectArticleAudioBlocks(md, markdownContent) {
  const env = { articleAudio: { blocks: [] } };
  md.parse(markdownContent, env);
  return env.articleAudio.blocks;
}

function renderArticleMarkdown(md, markdownContent, resolvedAudioBlocks) {
  const env = {
    articleAudio: {
      blocks: [],
      resolvedAudioBlocks,
      styleEmitted: false
    }
  };
  return md.render(markdownContent, env);
}

module.exports = {
  collectArticleAudioBlocks,
  installArticleAudioMarkdown,
  renderArticleMarkdown
};

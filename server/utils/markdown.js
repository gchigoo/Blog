const MarkdownIt = require('markdown-it');
const markdownItAnchor = /** @type {any} */ (require('markdown-it-anchor'));
const matter = require('gray-matter');
const slugify = require('slugify');
const hljs = /** @type {any} */ (require('highlight.js'));
const { isSupportedLocale, DEFAULT_LOCALE } = require('../i18n/config');
const { isSafeSlug } = require('./path-security');
const { SYSTEM_TAG_ID } = require('../taxonomy/catalog');
const { AUDIO_FORMATS } = require('../article-audio/formats');
const {
  collectArticleAudioBlocks,
  installArticleAudioMarkdown,
  renderArticleMarkdown
} = require('../article-audio/markdown');

const TAG_MAX_COUNT = 20;
const TAG_MAX_LENGTH = 50;
const FORBIDDEN_TAG_PATTERN = /[/\\?%#]/;

class MarkdownMetadataError extends Error {}

function invalidMetadata(message) {
  throw new MarkdownMetadataError(message);
}

function hasControlCharacters(value) {
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (codePoint < 0x20 || codePoint === 0x7f) return true;
  }
  return false;
}

/**
 * Track whether a normalized value was explicitly supplied by the author.
 * The flags stay non-enumerable so they never leak into serialized YAML or
 * JSON output while remaining directly readable on the parsed data object.
 */
function definePresence(data, key, value) {
  Object.defineProperty(data, key, {
    value,
    enumerable: false,
    configurable: true,
    writable: true
  });
}

function normalizeMetadata(data) {
  if (data.title !== undefined) {
    if (typeof data.title !== 'string' || !data.title.trim() || data.title.length > 200) {
      invalidMetadata('title 必须是 1 到 200 个字符的字符串');
    }
    data.title = data.title.trim();
  }

  if (!data.slug && data.title) {
    data.slug = generateSlug(data.title);
  }

  if (data.locale === undefined) {
    data.locale = DEFAULT_LOCALE;
    definePresence(data, 'localeExplicit', false);
  } else {
    if (typeof data.locale !== 'string' || !isSupportedLocale(data.locale)) {
      invalidMetadata('locale 必须是 zh 或 en');
    }
    definePresence(data, 'localeExplicit', true);
  }

  if (data.translationKey === undefined) {
    if (data.slug !== undefined) data.translationKey = data.slug;
    definePresence(data, 'translationKeyExplicit', false);
  } else {
    if (typeof data.translationKey !== 'string' || !isSafeSlug(data.translationKey)) {
      invalidMetadata('translationKey 必须是不超过安全格式的 slug');
    }
    definePresence(data, 'translationKeyExplicit', true);
  }

  if (data.tags && typeof data.tags === 'string') {
    data.tags = data.tags.split(',').map(tag => tag.trim()).filter(Boolean);
  } else if (!data.tags) {
    data.tags = [];
  } else if (!Array.isArray(data.tags)) {
    invalidMetadata('tags 必须是字符串或字符串数组');
  }

  if (data.tags.length > TAG_MAX_COUNT) {
    invalidMetadata(`tags 最多 ${TAG_MAX_COUNT} 个`);
  }
  const normalizedTags = [];
  for (const tag of data.tags) {
    if (typeof tag !== 'string' || !tag.trim()) {
      invalidMetadata(`每个标签必须是 1 到 ${TAG_MAX_LENGTH} 个字符的字符串`);
    }
    const value = tag.trim().normalize('NFKC');
    if (
      value.length > TAG_MAX_LENGTH
      || hasControlCharacters(value)
      || FORBIDDEN_TAG_PATTERN.test(value)
    ) {
      invalidMetadata(`每个标签必须是 1 到 ${TAG_MAX_LENGTH} 个字符的字符串`);
    }
    normalizedTags.push(value);
  }
  data.tags = [...new Set(normalizedTags)];
  if (data.tags.length === 0) {
    data.tags = [SYSTEM_TAG_ID];
  }

  if (data.description !== undefined
    && (typeof data.description !== 'string' || data.description.trim().length > 300)) {
    invalidMetadata('description 必须是不超过 300 个字符的字符串');
  }
  data.description = typeof data.description === 'string' ? data.description.trim() : '';

  if (data.status === undefined) data.status = data.draft === true ? 'draft' : 'published';
  if (!['draft', 'published'].includes(data.status)) {
    invalidMetadata('status 必须是 draft 或 published');
  }

  if (data.date) {
    const date = new Date(data.date);
    if (Number.isNaN(date.getTime())) invalidMetadata('date 必须是有效日期');
    data.date = date.toISOString();
  } else {
    data.date = new Date().toISOString();
  }

  return data;
}

/**
 * 配置 Markdown 解析器
 * markdown-it v14.1.0
 * markdown-it-anchor v9.2.0
 */
const md = new MarkdownIt({
  html: false,       // 原始 HTML 按文本处理，避免持久化 XSS
  linkify: true,     // 自动转换 URL 为链接
  typographer: true, // 美化排版（智能引号等）
  breaks: true,      // 换行转为 <br>
  highlight(code, language) {
    if (language && hljs.getLanguage(language)) {
      return hljs.highlight(code, { language, ignoreIllegals: true }).value;
    }
    return md.utils.escapeHtml(code);
  }
}).use(markdownItAnchor, {
  level: 1,          // 为 h1-h6 所有标题添加锚点
  slugify: (s) => slugify(s, { 
    lower: true, 
    strict: true,
    locale: 'zh'     // 支持中文
  }),
  tabIndex: false,   // 不添加 tabindex 属性
  // v9.x 默认只添加 id，不显示永久链接
  // 如需显示永久链接，可取消注释下面的配置：
  // permalink: markdownItAnchor.permalink.linkInsideHeader({
  //   symbol: '#',
  //   placement: 'before'
  // })
}).use(installArticleAudioMarkdown);

/**
 * External absolute http/https links receive `rel="noopener noreferrer"`.
 * No `target="_blank"` is added: navigation stays same-tab and the rel keeps
 * any future consumer safe from opener-based tabnabbing.
 */
md.renderer.rules.link_open = (tokens, index, options, env, renderer) => {
  const token = tokens[index];
  const href = token.attrGet('href');
  if (typeof href === 'string' && /^https?:\/\//i.test(href)) {
    token.attrSet('rel', 'noopener noreferrer');
  }
  return renderer.renderToken(tokens, index, options);
};

function parseMarkdownDocument(content) {
  // gray-matter caches parsed files by content string and returns a shallow
  // copy whose `data` object is still shared across identical parses.
  // Normalization mutates that object (defaults, presence flags), so clone
  // it first to keep repeated parses of identical content independent.
  const { data: cachedData, content: markdownContent } = matter(content);
  const data = structuredClone(cachedData);
  normalizeMetadata(data);

  return {
    data,
    content: markdownContent,
    audioBlocks: collectArticleAudioBlocks(md, markdownContent)
  };
}

function renderMarkdown(markdownContent, { resolvedAudioBlocks = undefined, locale = DEFAULT_LOCALE } = {}) {
  return renderArticleMarkdown(md, markdownContent, resolvedAudioBlocks, locale);
}

function serializeMarkdownDocument(markdownContent, metadata) {
  return matter.stringify(markdownContent, metadata);
}

/**
 * 解析 Markdown 文件内容
 * @param {string} content - Markdown 文件内容
 * @returns {Object} - { data: 元数据, content: 正文, html: HTML }
 */
function parseMarkdown(content, options = {}) {
  const { data, content: markdownContent, audioBlocks } = parseMarkdownDocument(content);
  const html = renderMarkdown(markdownContent, {
    ...options,
    locale: options.locale ?? data.locale
  });

  return {
    data,
    content: markdownContent,
    html,
    audioBlocks
  };
}

/**
 * 生成 URL 友好的 slug
 * @param {string} title - 标题
 * @returns {string} - slug
 */
function generateSlug(title) {
  // 处理中文标题
  const slug = slugify(title, {
    lower: true,
    strict: true,
    locale: 'zh'
  });
  
  // 如果 slugify 返回空（纯中文），使用时间戳
  if (!slug || slug.length === 0) {
    return `article-${Date.now()}`;
  }
  
  return slug;
}

/**
 * Replace the `tags` key of a document's YAML front matter with a stable tag-ID
 * flow array while leaving the body and every other front matter key
 * byte-for-byte untouched. Handles both block-sequence (`tags:\n  - a`) and
 * inline (`tags: [a]`) source forms. The tags key must exist.
 *
 * @param {string} source - full Markdown document
 * @param {string[]} tagIds - normalized stable tag IDs to serialize
 * @returns {string}
 */
function rewriteMarkdownTags(source, tagIds) {
  const opening = /^---[ \t]*\r?\n/.exec(source);
  if (!opening) {
    throw new MarkdownMetadataError('markdown file has no front matter');
  }
  const frontMatterStart = opening.index + opening[0].length;
  const closing = /\r?\n---[ \t]*(?:\r?\n|$)/.exec(source.slice(frontMatterStart));
  if (!closing) {
    throw new MarkdownMetadataError('markdown front matter is not closed');
  }
  const frontMatterEnd = frontMatterStart + closing.index;
  const frontMatter = source.slice(0, frontMatterEnd);
  const remainder = source.slice(frontMatterEnd);

  const lines = frontMatter.split('\n');
  let keyIndex = -1;
  for (let index = 0; index < lines.length; index += 1) {
    if (/^[ \t]*tags[ \t]*:/.test(lines[index])) {
      keyIndex = index;
      break;
    }
  }
  if (keyIndex === -1) {
    throw new MarkdownMetadataError('markdown front matter has no tags key');
  }
  const indent = /^[ \t]*/.exec(lines[keyIndex])[0];
  let endIndex = keyIndex + 1;
  while (endIndex < lines.length && /^[ \t]+/.test(lines[endIndex]) && lines[endIndex].trim() !== '') {
    endIndex += 1;
  }
  const renderedTags = tagIds.map(tagId => JSON.stringify(tagId)).join(', ');
  const replacement = `${indent}tags: [${renderedTags}]`;
  const rewrittenFrontMatter = [
    ...lines.slice(0, keyIndex),
    replacement,
    ...lines.slice(endIndex)
  ].join('\n');
  return rewrittenFrontMatter + remainder;
}

/**
 * 提取 Markdown 中的图片引用
 * @param {string} content - Markdown 内容
 * @returns {Array} - 图片路径数组
 */
function extractImages(content) {
  const imageRegex = /!\[.*?\]\((.*?)\)/g;
  const images = [];
  let match;
  
  while ((match = imageRegex.exec(content)) !== null) {
    images.push(match[1]);
  }
  
  return images;
}

/**
 * 替换 Markdown 中的图片路径
 * @param {string} content - Markdown 内容
 * @param {Object} imageMap - 旧路径到新路径的映射 { 'old.jpg': 'new.webp' }
 * @returns {string} - 更新后的 Markdown
 */
function replaceImagePaths(content, imageMap) {
  let newContent = content;
  
  for (const [oldPath, newPath] of Object.entries(imageMap)) {
    // 转义特殊字符
    const escapedOldPath = oldPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const regex = new RegExp(`!\\[([^\\]]*)\\]\\(${escapedOldPath}\\)`, 'g');
    newContent = newContent.replace(regex, `![$1](${newPath})`);
  }
  
  return newContent;
}

/**
 * 替换 HTML 中的图片路径
 * @param {string} html - HTML 内容
 * @param {Object} imageMap - 旧路径到新路径的映射
 * @returns {string} - 更新后的 HTML
 */
function replaceHtmlImagePaths(html, imageMap) {
  let newHtml = html;
  
  for (const [oldPath, newPath] of Object.entries(imageMap)) {
    // markdown-it URI-encodes Windows-style image paths in generated HTML.
    // Match both the original Markdown reference and its rendered URI form.
    for (const candidatePath of new Set([oldPath, encodeURI(oldPath)])) {
      const escapedPath = candidatePath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const regex = new RegExp(`src="${escapedPath}"`, 'g');
      newHtml = newHtml.replace(regex, `src="${newPath}"`);
    }
  }
  
  return newHtml;
}

// ---------------------------------------------------------------------------
// Published audio URL scanning and exact legacy-URL rewriting
// ---------------------------------------------------------------------------

const AUDIO_URL_EXTENSIONS = Object.freeze(Object.keys(AUDIO_FORMATS).map(extension => extension.slice(1)));
const AUDIO_EXTENSION_PATTERN = AUDIO_URL_EXTENSIONS.map(extension => extension.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
const AUDIO_HASH_PATTERN = '[a-f0-9]{64}';
const AUDIO_SLUG_PATTERN = '[a-z0-9]+(?:-[a-z0-9]+)*';

// Legacy (transitional) audio URLs carry no locale segment.
const LEGACY_AUDIO_URL_PATTERN = new RegExp(
  `^/audio/(${AUDIO_SLUG_PATTERN})/(${AUDIO_HASH_PATTERN})\\.(${AUDIO_EXTENSION_PATTERN})$`
);
// Localized published audio URLs carry the locale segment.
const PUBLISHED_AUDIO_URL_PATTERN = new RegExp(
  `^/audio/(zh|en)/(${AUDIO_SLUG_PATTERN})/(${AUDIO_HASH_PATTERN})\\.(${AUDIO_EXTENSION_PATTERN})$`
);

/**
 * Scan a document for every `/audio/...` path reference, returning
 * deterministic `{ path, index, end }` occurrences in document order.
 * Paths are delimited by whitespace, quotes, angle brackets, and closing
 * parens (Markdown link destinations terminate at `)`).
 */
function scanAudioUrlReferences(html) {
  const references = [];
  const pattern = /\/audio\/[^"'<>\s)]+/g;
  for (const match of html.matchAll(pattern)) {
    references.push({ path: match[0], index: match.index, end: match.index + match[0].length });
  }
  return references;
}

/**
 * Classify one `/audio/...` path.
 *
 * @returns {{ kind: 'legacy'|'published'|'other', slug: string } & Record<string, string>}
 *   legacy: `{ kind, slug, hash, extension, file }` without a locale segment;
 *   published: `{ kind, locale, slug, hash, extension, file }` with one;
 *   other: `{ kind, slug }` where slug is the first path segment.
 */
function classifyAudioUrl(audioPath) {
  const legacy = LEGACY_AUDIO_URL_PATTERN.exec(audioPath);
  if (legacy) {
    return { kind: 'legacy', slug: legacy[1], hash: legacy[2], extension: legacy[3], file: `${legacy[2]}.${legacy[3]}` };
  }
  const published = PUBLISHED_AUDIO_URL_PATTERN.exec(audioPath);
  if (published) {
    return { kind: 'published', locale: published[1], slug: published[2], hash: published[3], extension: published[4], file: `${published[3]}.${published[4]}` };
  }
  const firstSegment = audioPath.slice('/audio/'.length);
  const slash = firstSegment.indexOf('/');
  return { kind: 'other', slug: slash === -1 ? firstSegment : firstSegment.slice(0, slash) };
}

/**
 * Rewrite every exact same-article legacy audio URL to its localized form.
 *
 * `moves` maps a `'<64-hex>.<ext>'` file key to a truthy value only when that
 * file is planned for localization for this article. Legacy URLs for a foreign
 * slug, legacy URLs whose source file is not planned, and malformed URLs that
 * still carry the article's own slug are rejected with `MarkdownMetadataError`
 * instead of being silently rewritten. Localized URLs and unrelated `/audio/`
 * paths are left byte-for-byte untouched.
 *
 * @returns {{ html: string, rewrites: Array<{from: string, to: string}> }}
 */
function rewriteLegacyAudioUrls(html, { slug, locale, moves }) {
  const parts = [];
  let cursor = 0;
  const rewrites = [];
  for (const reference of scanAudioUrlReferences(html)) {
    const classified = classifyAudioUrl(reference.path);
    if (classified.kind === 'published') continue;
    let replacement = null;
    if (classified.kind === 'legacy') {
      if (classified.slug !== slug) {
        throw new MarkdownMetadataError(`cross-article legacy audio URL: ${reference.path}`);
      }
      if (!moves.has(classified.file)) {
        throw new MarkdownMetadataError(`legacy audio reference missing its source file: ${reference.path}`);
      }
      replacement = `/audio/${locale}/${slug}/${classified.file}`;
    } else if (classified.slug === slug) {
      throw new MarkdownMetadataError(`malformed audio URL for article slug: ${reference.path}`);
    }
    if (replacement === null) continue;
    parts.push(html.slice(cursor, reference.index), replacement);
    cursor = reference.end;
    rewrites.push({ from: reference.path, to: replacement });
  }
  parts.push(html.slice(cursor));
  return { html: parts.join(''), rewrites };
}

/**
 * Replace or insert exact front matter keys without touching any other line.
 * `entries` is `[{ key, value }]`; an existing key keeps its own indentation
 * and is replaced in place, while missing keys are inserted directly after the
 * opening `---` line. The body and every unrelated key stay byte-for-byte.
 */
function setFrontMatterKeys(source, entries) {
  const opening = /^---[ \t]*\r?\n/.exec(source);
  if (!opening) {
    throw new MarkdownMetadataError('markdown file has no front matter');
  }
  const frontMatterStart = opening.index + opening[0].length;
  const closing = /\r?\n---[ \t]*(?:\r?\n|$)/.exec(source.slice(frontMatterStart));
  if (!closing) {
    throw new MarkdownMetadataError('markdown front matter is not closed');
  }
  const frontMatterEnd = frontMatterStart + closing.index;
  const frontMatter = source.slice(0, frontMatterEnd);
  const remainder = source.slice(frontMatterEnd);
  const lines = frontMatter.split('\n');
  const next = [];
  const seen = new Set();
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const matched = entries.find(entry => new RegExp(`^[ \\t]*${entry.key}[ \\t]*:`).test(line));
    if (matched && !seen.has(matched.key)) {
      next.push(`${/^[ \t]*/.exec(line)[0]}${matched.key}: ${matched.value}`);
      seen.add(matched.key);
      continue;
    }
    next.push(line);
  }
  const missing = entries.filter(entry => !seen.has(entry.key));
  if (missing.length > 0) {
    next.splice(1, 0, ...missing.map(entry => `${entry.key}: ${entry.value}`));
  }
  return `${next.join('\n')}${remainder}`;
}

/**
 * Rewrite a transitional (pre-migration) Markdown document into its localized
 * form: stable tag IDs in the tags block, explicit `locale` and
 * `translationKey` front matter keys, and every other line preserved exactly.
 * The tags key must exist.
 */
function rewriteTransitionalMarkdown(source, { locale, translationKey, tagIds }) {
  const withTags = rewriteMarkdownTags(source, tagIds);
  return setFrontMatterKeys(withTags, [
    { key: 'locale', value: locale },
    { key: 'translationKey', value: JSON.stringify(translationKey) }
  ]);
}

module.exports = {
  MarkdownMetadataError,
  parseMarkdown,
  parseMarkdownDocument,
  renderMarkdown,
  serializeMarkdownDocument,
  generateSlug,
  rewriteMarkdownTags,
  extractImages,
  replaceImagePaths,
  replaceHtmlImagePaths,
  classifyAudioUrl,
  rewriteLegacyAudioUrls,
  rewriteTransitionalMarkdown,
  scanAudioUrlReferences
};

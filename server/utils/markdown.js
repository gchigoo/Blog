const MarkdownIt = require('markdown-it');
const markdownItAnchor = /** @type {any} */ (require('markdown-it-anchor'));
const matter = require('gray-matter');
const slugify = require('slugify');
const hljs = /** @type {any} */ (require('highlight.js'));
const {
  collectArticleAudioBlocks,
  installArticleAudioMarkdown,
  renderArticleMarkdown
} = require('../article-audio/markdown');

class MarkdownMetadataError extends Error {}

function invalidMetadata(message) {
  throw new MarkdownMetadataError(message);
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

  if (data.tags && typeof data.tags === 'string') {
    data.tags = data.tags.split(',').map(tag => tag.trim()).filter(Boolean);
  } else if (!data.tags) {
    data.tags = [];
  } else if (!Array.isArray(data.tags)) {
    invalidMetadata('tags 必须是字符串或字符串数组');
  }

  if (data.tags.length > 20
    || data.tags.some(tag => typeof tag !== 'string' || !tag.trim() || tag.length > 50)) {
    invalidMetadata('tags 最多 20 个，每个标签必须是 1 到 50 个字符的字符串');
  }
  data.tags = [...new Set(data.tags.map(tag => tag.trim()))];

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

function parseMarkdownDocument(content) {
  const { data, content: markdownContent } = matter(content);
  normalizeMetadata(data);

  return {
    data,
    content: markdownContent,
    audioBlocks: collectArticleAudioBlocks(md, markdownContent)
  };
}

function renderMarkdown(markdownContent, { resolvedAudioBlocks = undefined } = {}) {
  return renderArticleMarkdown(md, markdownContent, resolvedAudioBlocks);
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
  const html = renderMarkdown(markdownContent, options);

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

module.exports = {
  MarkdownMetadataError,
  parseMarkdown,
  parseMarkdownDocument,
  renderMarkdown,
  serializeMarkdownDocument,
  generateSlug,
  extractImages,
  replaceImagePaths,
  replaceHtmlImagePaths
};

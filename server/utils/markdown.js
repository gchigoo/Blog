const MarkdownIt = require('markdown-it');
const markdownItAnchor = require('markdown-it-anchor');
const matter = require('gray-matter');
const slugify = require('slugify');

/**
 * 配置 Markdown 解析器
 * markdown-it v14.1.0
 * markdown-it-anchor v9.2.0
 */
const md = new MarkdownIt({
  html: true,        // 允许 HTML 标签
  linkify: true,     // 自动转换 URL 为链接
  typographer: true, // 美化排版（智能引号等）
  breaks: true       // 换行转为 <br>
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
});

/**
 * 解析 Markdown 文件内容
 * @param {string} content - Markdown 文件内容
 * @returns {Object} - { data: 元数据, content: 正文, html: HTML }
 */
function parseMarkdown(content) {
  // 解析 Front Matter
  const { data, content: markdownContent } = matter(content);
  
  // 转换 Markdown 为 HTML
  const html = md.render(markdownContent);
  
  // 自动生成 slug（如果没有提供）
  if (!data.slug && data.title) {
    data.slug = generateSlug(data.title);
  }
  
  // 确保标签是数组
  if (data.tags && typeof data.tags === 'string') {
    data.tags = data.tags.split(',').map(tag => tag.trim());
  } else if (!data.tags) {
    data.tags = [];
  }
  
  // 确保日期格式正确
  if (data.date) {
    data.date = new Date(data.date).toISOString();
  } else {
    data.date = new Date().toISOString();
  }
  
  return {
    data,
    content: markdownContent,
    html
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
    const escapedOldPath = oldPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const regex = new RegExp(`src="${escapedOldPath}"`, 'g');
    newHtml = newHtml.replace(regex, `src="${newPath}"`);
  }
  
  return newHtml;
}

module.exports = {
  parseMarkdown,
  generateSlug,
  extractImages,
  replaceImagePaths,
  replaceHtmlImagePaths
};

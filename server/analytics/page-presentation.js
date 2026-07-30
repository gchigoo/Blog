const { formatAnalyticsPath } = require('./path-display');

const FIXED_PAGES = new Map([
  ['/', { kind: 'home', title: '首页' }],
  ['/about', { kind: 'about', title: '关于' }],
  ['/archive', { kind: 'archive', title: '归档' }],
  ['/tags', { kind: 'tag', title: '标签页' }]
]);

function safeDecode(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

function articleSlugForPath(rawPath) {
  if (typeof rawPath !== 'string') return null;
  const match = rawPath.match(/^\/article\/([^/]+)$/);
  return match ? safeDecode(match[1]) : null;
}

function pagePresentationForPath(rawPath, articleTitles = new Map()) {
  const displayPath = formatAnalyticsPath(rawPath).displayPath;
  const fixed = FIXED_PAGES.get(rawPath);
  if (fixed) return { ...fixed, displayPath };

  if (typeof rawPath === 'string' && rawPath.startsWith('/tag/')) {
    const match = rawPath.match(/^\/tag\/([^/]+)$/);
    const tag = match ? safeDecode(match[1]) : null;
    if (tag !== null) return { kind: 'tag', title: `标签：${tag}`, displayPath };
  }

  if (typeof rawPath === 'string' && rawPath.startsWith('/article/')) {
    const slug = articleSlugForPath(rawPath);
    return {
      kind: 'article',
      title: slug !== null && articleTitles.has(slug)
        ? articleTitles.get(slug)
        : '文章（已删除或未知）',
      displayPath
    };
  }

  return { kind: 'other', title: displayPath, displayPath };
}

function hasArticlesTable(db) {
  return Boolean(db.prepare(`
    SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'articles'
  `).get());
}

function presentEventPages(db, rows) {
  const slugs = [...new Set(rows.map(row => articleSlugForPath(row.request_path)).filter(slug => slug !== null))];
  const articleTitles = new Map();
  if (slugs.length > 0 && hasArticlesTable(db)) {
    const placeholders = slugs.map(() => '?').join(', ');
    for (const row of db.prepare(`
      SELECT slug, title FROM articles WHERE slug IN (${placeholders})
    `).all(...slugs)) {
      articleTitles.set(row.slug, row.title);
    }
  }
  return new Map(rows.map(row => [
    row.metric_id,
    pagePresentationForPath(row.request_path, articleTitles)
  ]));
}

module.exports = {
  pagePresentationForPath,
  presentEventPages
};

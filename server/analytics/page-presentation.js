const { formatAnalyticsPath } = require('./path-display');

const FIXED_PAGES = new Map([
  ['/', { kind: 'home', title: '首页' }],
  ['/about', { kind: 'about', title: '关于' }],
  ['/archive', { kind: 'archive', title: '归档' }],
  ['/tags', { kind: 'tag', title: '标签页' }]
]);

const LOCALIZED_FIXED_PAGES = new Map([
  ['about', { kind: 'about', title: '关于' }],
  ['archive', { kind: 'archive', title: '归档' }],
  ['tags', { kind: 'tag', title: '标签页' }],
  ['search', { kind: 'search', title: '搜索' }]
]);

const ARTICLE_UNKNOWN_TITLE = '文章（已删除或未知）';

const articleTitleKey = (locale, slug) => `${locale}\u0000${slug}`;
const taxonomyTitleKey = (kind, locale, slug) => `${kind}\u0000${locale}\u0000${slug}`;

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

/**
 * Parse a locale-prefixed path. The query/fragment suffix (kept only in the
 * separately sanitized stored URL fields) is never part of the recognized
 * path, so raw search query text can never leak into a page label.
 */
function parseLocalizedPath(rawPath) {
  if (typeof rawPath !== 'string') return null;
  const suffixIndex = rawPath.search(/[?#]/);
  const pathname = suffixIndex === -1 ? rawPath : rawPath.slice(0, suffixIndex);
  const match = pathname.match(/^\/(zh|en)(?:\/(.*))?$/);
  if (!match) return null;
  const rest = match[2] === undefined ? '' : match[2].replace(/\/+$/, '');
  return { locale: match[1], rest };
}

function localizedPresentation(parsed, titles, displayPath) {
  const segments = parsed.rest.split('/');
  const [kind] = segments;
  if (parsed.rest === '') {
    return { kind: 'home', title: '首页', displayPath };
  }
  if (kind === 'about' || kind === 'archive' || kind === 'tags' || kind === 'search') {
    if (segments.length !== 1) return { kind: 'other', title: displayPath, displayPath };
    return { ...LOCALIZED_FIXED_PAGES.get(kind), displayPath };
  }
  if (kind === 'article') {
    if (segments.length !== 2) return { kind: 'article', title: ARTICLE_UNKNOWN_TITLE, displayPath };
    const slug = safeDecode(segments[1]);
    if (slug === null) return { kind: 'article', title: ARTICLE_UNKNOWN_TITLE, displayPath };
    return {
      kind: 'article',
      title: titles.get(articleTitleKey(parsed.locale, slug)) || ARTICLE_UNKNOWN_TITLE,
      displayPath
    };
  }
  if (kind === 'tag' || kind === 'category') {
    if (segments.length !== 2) return { kind: 'other', title: displayPath, displayPath };
    const slug = safeDecode(segments[1]);
    if (slug === null) return { kind: 'other', title: displayPath, displayPath };
    const name = titles.get(taxonomyTitleKey(kind, parsed.locale, slug)) || slug;
    return {
      kind,
      title: `${kind === 'tag' ? '标签：' : '分类：'}${name}`,
      displayPath
    };
  }
  return { kind: 'other', title: displayPath, displayPath };
}

function pagePresentationForPath(rawPath, articleTitles = new Map()) {
  const displayPath = formatAnalyticsPath(rawPath).displayPath;
  const fixed = FIXED_PAGES.get(rawPath);
  if (fixed) return { ...fixed, displayPath };

  if (typeof rawPath !== 'string') {
    return { kind: 'other', title: displayPath, displayPath };
  }

  const parsed = parseLocalizedPath(rawPath);
  if (parsed) {
    return localizedPresentation(parsed, articleTitles, displayPath);
  }

  if (rawPath.startsWith('/tag/')) {
    const match = rawPath.match(/^\/tag\/([^/]+)$/);
    const tag = match ? safeDecode(match[1]) : null;
    if (tag !== null) return { kind: 'tag', title: `标签：${tag}`, displayPath };
  }

  if (rawPath.startsWith('/article/')) {
    const slug = articleSlugForPath(rawPath);
    return {
      kind: 'article',
      title: slug !== null && articleTitles.has(slug)
        ? articleTitles.get(slug)
        : ARTICLE_UNKNOWN_TITLE,
      displayPath
    };
  }

  return { kind: 'other', title: displayPath, displayPath };
}

function hasTable(db, name) {
  return Boolean(db.prepare(`
    SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?
  `).get(name));
}

function hasArticlesTable(db) {
  return hasTable(db, 'articles');
}

function addToGroup(groups, locale, slug) {
  if (!groups.has(locale)) groups.set(locale, new Set());
  groups.get(locale).add(slug);
}

function presentEventPages(db, rows) {
  const articleSlugs = new Map();
  const tagSlugs = new Map();
  const categorySlugs = new Map();
  for (const row of rows) {
    const parsed = parseLocalizedPath(row.request_path);
    if (parsed) {
      const segments = parsed.rest.split('/');
      const [kind] = segments;
      if (kind === 'article' && segments.length === 2) {
        const slug = safeDecode(segments[1]);
        if (slug !== null) addToGroup(articleSlugs, parsed.locale, slug);
      } else if (kind === 'tag' && segments.length === 2) {
        const slug = safeDecode(segments[1]);
        if (slug !== null) addToGroup(tagSlugs, parsed.locale, slug);
      } else if (kind === 'category' && segments.length === 2) {
        const slug = safeDecode(segments[1]);
        if (slug !== null) addToGroup(categorySlugs, parsed.locale, slug);
      }
    } else {
      const slug = articleSlugForPath(row.request_path);
      if (slug !== null) addToGroup(articleSlugs, null, slug);
    }
  }

  const titles = new Map();
  if (hasArticlesTable(db)) {
    const articleColumns = new Set(
      db.prepare('PRAGMA table_info(articles)').all().map(column => column.name)
    );
    const hasLocale = articleColumns.has('locale');

    // The historical unprefixed article path was the Chinese article surface;
    // when multiple locales share the slug, the zh row wins.
    const legacySlugs = articleSlugs.get(null);
    if (legacySlugs && legacySlugs.size > 0) {
      const placeholders = [...legacySlugs].map(() => '?').join(', ');
      const orderBy = hasLocale
        ? "ORDER BY CASE locale WHEN 'zh' THEN 0 ELSE 1 END, id ASC"
        : 'ORDER BY id ASC';
      for (const row of db.prepare(`
        SELECT slug, title FROM articles
        WHERE slug IN (${placeholders})
        ${orderBy}
      `).all(...legacySlugs)) {
        if (!titles.has(row.slug)) titles.set(row.slug, row.title);
      }
    }

    if (hasLocale) {
      for (const [locale, slugs] of articleSlugs) {
        if (locale === null || slugs.size === 0) continue;
        const placeholders = [...slugs].map(() => '?').join(', ');
        for (const row of db.prepare(`
          SELECT slug, title FROM articles
          WHERE locale = ? AND slug IN (${placeholders})
        `).all(locale, ...slugs)) {
          titles.set(articleTitleKey(locale, row.slug), row.title);
        }
      }
    }
  }

  if (tagSlugs.size > 0 && hasTable(db, 'tag_labels')) {
    for (const [locale, slugs] of tagSlugs) {
      if (slugs.size === 0) continue;
      const placeholders = [...slugs].map(() => '?').join(', ');
      for (const row of db.prepare(`
        SELECT slug, name FROM tag_labels
        WHERE locale = ? AND slug IN (${placeholders})
      `).all(locale, ...slugs)) {
        titles.set(taxonomyTitleKey('tag', locale, row.slug), row.name);
      }
    }
  }

  if (categorySlugs.size > 0 && hasTable(db, 'category_labels')) {
    for (const [locale, slugs] of categorySlugs) {
      if (slugs.size === 0) continue;
      const placeholders = [...slugs].map(() => '?').join(', ');
      for (const row of db.prepare(`
        SELECT slug, name FROM category_labels
        WHERE locale = ? AND slug IN (${placeholders})
      `).all(locale, ...slugs)) {
        titles.set(taxonomyTitleKey('category', locale, row.slug), row.name);
      }
    }
  }

  return new Map(rows.map(row => [
    row.metric_id,
    pagePresentationForPath(row.request_path, titles)
  ]));
}

module.exports = {
  pagePresentationForPath,
  presentEventPages
};

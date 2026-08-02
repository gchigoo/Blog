const ZH_LOCALE = 'zh';

function parseTags(value) {
  if (!value) return [];
  try {
    const tags = JSON.parse(value);
    return Array.isArray(tags) ? tags.filter(tag => typeof tag === 'string') : [];
  } catch {
    return [];
  }
}

/**
 * Batch-load Chinese display labels for a set of articles. This keeps list,
 * detail, and admin models free of per-article N+1 tag queries.
 *
 * @returns {Map<number, string[]>}
 */
function loadChineseTagLabels(db, articleIds) {
  const tagsByArticle = new Map();
  if (!articleIds || articleIds.length === 0) return tagsByArticle;
  const ids = [...new Set(articleIds.map(Number))].filter(Number.isFinite);
  if (ids.length === 0) return tagsByArticle;
  const placeholders = ids.map(() => '?').join(', ');
  const rows = db.prepare(`
    SELECT article_tags.article_id AS article_id, tag_labels.name AS name
    FROM article_tags
    JOIN tag_labels ON tag_labels.tag_id = article_tags.tag_id AND tag_labels.locale = ?
    WHERE article_tags.article_id IN (${placeholders})
    ORDER BY tag_labels.tag_id ASC
  `).all(ZH_LOCALE, ...ids);
  for (const row of rows) {
    if (!tagsByArticle.has(row.article_id)) tagsByArticle.set(row.article_id, []);
    tagsByArticle.get(row.article_id).push(row.name);
  }
  return tagsByArticle;
}

function attachChineseTags(db, articles) {
  if (!articles || articles.length === 0) return articles;
  const tagsByArticle = loadChineseTagLabels(db, articles.map(article => article.id));
  return articles.map(article => ({ ...article, tags: tagsByArticle.get(article.id) || [] }));
}

function mapArticle(article) {
  if (!article) return null;
  return { ...article, tags: Array.isArray(article.tags) ? article.tags : parseTags(article.tags) };
}

function createArticleService(db) {
  const listPublishedStatement = db.prepare(`
    SELECT id, title, slug, description, created_at, updated_at
    FROM articles
    WHERE status = 'published' AND locale = ?
    ORDER BY created_at DESC, id DESC
    LIMIT ? OFFSET ?
  `);
  const countPublishedStatement = db.prepare(`
    SELECT COUNT(*) AS total FROM articles WHERE status = 'published' AND locale = ?
  `);
  const getBySlugStatement = db.prepare(`
    SELECT * FROM articles WHERE slug = ? AND status = 'published' AND locale = ?
  `);

  function listPublished(page = 1, pageSize = 20) {
    const total = countPublishedStatement.get(ZH_LOCALE).total;
    return {
      articles: attachChineseTags(db, listPublishedStatement.all(ZH_LOCALE, pageSize, (page - 1) * pageSize)).map(mapArticle),
      page,
      pageSize,
      total,
      totalPages: Math.ceil(total / pageSize)
    };
  }

  function getPublishedBySlug(slug) {
    const article = getBySlugStatement.get(slug, ZH_LOCALE);
    if (!article) return null;
    return mapArticle(attachChineseTags(db, [article])[0]);
  }

  function listArchive() {
    return db.prepare(`
      SELECT id, title, slug, created_at, updated_at
      FROM articles WHERE status = 'published' AND locale = ?
      ORDER BY created_at DESC, id DESC
    `).all(ZH_LOCALE);
  }

  function listTags() {
    return db.prepare(`
      SELECT tag_labels.name AS name, COUNT(*) AS count
      FROM article_tags
      JOIN tag_labels ON tag_labels.tag_id = article_tags.tag_id AND tag_labels.locale = ?
      JOIN articles ON articles.id = article_tags.article_id
      WHERE articles.status = 'published' AND articles.locale = ?
      GROUP BY tag_labels.name
      ORDER BY count DESC, name COLLATE NOCASE ASC
    `).all(ZH_LOCALE, ZH_LOCALE);
  }

  function listByTag(tag) {
    const tagIds = db.prepare(`
      SELECT tag_id FROM tag_labels
      WHERE locale = ? AND (name = ? OR slug = ?)
      ORDER BY tag_id
    `).all(ZH_LOCALE, tag, tag).map(row => row.tag_id);
    if (tagIds.length === 0) return [];
    const placeholders = tagIds.map(() => '?').join(', ');
    const rows = db.prepare(`
      SELECT articles.id, articles.title, articles.slug, articles.description, articles.created_at
      FROM article_tags
      JOIN articles ON articles.id = article_tags.article_id
      WHERE article_tags.tag_id IN (${placeholders})
        AND articles.status = 'published' AND articles.locale = ?
      ORDER BY articles.created_at DESC, articles.id DESC
    `).all(...tagIds, ZH_LOCALE);
    return attachChineseTags(db, rows).map(mapArticle);
  }

  function search(query, limit = 50) {
    const terms = String(query || '').normalize('NFKC').trim().split(/\s+/u).filter(Boolean).slice(0, 8);
    if (terms.length === 0) return [];
    const expression = terms.map(term => `"${term.replaceAll('"', '""')}"`).join(' AND ');
    const rows = db.prepare(`
      SELECT articles.id, articles.title, articles.slug, articles.description,
             articles.created_at, bm25(article_fts) AS rank
      FROM article_fts
      JOIN articles ON articles.id = article_fts.rowid
      WHERE article_fts MATCH ? AND articles.status = 'published' AND articles.locale = ?
      ORDER BY rank, articles.created_at DESC
      LIMIT ?
    `).all(expression, ZH_LOCALE, limit);
    return attachChineseTags(db, rows).map(mapArticle);
  }

  function navigationFor(article) {
    const previous = db.prepare(`
      SELECT title, slug FROM articles
      WHERE status = 'published' AND locale = ?
        AND (created_at < ? OR (created_at = ? AND id < ?))
      ORDER BY created_at DESC, id DESC LIMIT 1
    `).get(ZH_LOCALE, article.created_at, article.created_at, article.id) || null;
    const next = db.prepare(`
      SELECT title, slug FROM articles
      WHERE status = 'published' AND locale = ?
        AND (created_at > ? OR (created_at = ? AND id > ?))
      ORDER BY created_at ASC, id ASC LIMIT 1
    `).get(ZH_LOCALE, article.created_at, article.created_at, article.id) || null;
    return { previous, next };
  }

  function relatedFor(article, limit = 3) {
    return db.prepare(`
      SELECT candidate.id, candidate.title, candidate.slug, candidate.created_at,
             COUNT(*) AS sharedTags
      FROM article_tags source
      JOIN article_tags related ON related.tag_id = source.tag_id AND related.article_id <> source.article_id
      JOIN articles candidate ON candidate.id = related.article_id AND candidate.locale = ?
      WHERE source.article_id = ? AND candidate.status = 'published'
      GROUP BY candidate.id
      ORDER BY sharedTags DESC, candidate.created_at DESC, candidate.id DESC
      LIMIT ?
    `).all(ZH_LOCALE, article.id, limit);
  }

  function listAdmin() {
    const rows = db.prepare(`
      SELECT id, title, slug, description, status, created_at, updated_at
      FROM articles WHERE locale = ?
      ORDER BY updated_at DESC, id DESC
    `).all(ZH_LOCALE);
    return attachChineseTags(db, rows).map(mapArticle);
  }

  return Object.freeze({
    getPublishedBySlug,
    listAdmin,
    listArchive,
    listByTag,
    listPublished,
    listTags,
    mapArticle,
    navigationFor,
    relatedFor,
    search
  });
}

module.exports = { createArticleService, loadChineseTagLabels, mapArticle, parseTags };

function parseTags(value) {
  if (!value) return [];
  try {
    const tags = JSON.parse(value);
    return Array.isArray(tags) ? tags.filter(tag => typeof tag === 'string') : [];
  } catch {
    return [];
  }
}

function mapArticle(article) {
  return article ? { ...article, tags: parseTags(article.tags) } : null;
}

function createArticleService(db) {
  const listPublishedStatement = db.prepare(`
    SELECT id, title, slug, description, tags, created_at, updated_at
    FROM articles
    WHERE status = 'published'
    ORDER BY created_at DESC, id DESC
    LIMIT ? OFFSET ?
  `);
  const countPublishedStatement = db.prepare("SELECT COUNT(*) AS total FROM articles WHERE status = 'published'");

  function listPublished(page = 1, pageSize = 20) {
    const total = countPublishedStatement.get().total;
    return {
      articles: listPublishedStatement.all(pageSize, (page - 1) * pageSize).map(mapArticle),
      page,
      pageSize,
      total,
      totalPages: Math.ceil(total / pageSize)
    };
  }

  function getPublishedBySlug(slug) {
    return mapArticle(db.prepare("SELECT * FROM articles WHERE slug = ? AND status = 'published'").get(slug));
  }

  function listArchive() {
    return db.prepare(`
      SELECT id, title, slug, created_at, updated_at
      FROM articles WHERE status = 'published'
      ORDER BY created_at DESC, id DESC
    `).all();
  }

  function listTags() {
    return db.prepare(`
      SELECT article_tags.tag AS name, COUNT(*) AS count
      FROM article_tags
      JOIN articles ON articles.id = article_tags.article_id
      WHERE articles.status = 'published'
      GROUP BY article_tags.tag
      ORDER BY count DESC, name COLLATE NOCASE ASC
    `).all();
  }

  function listByTag(tag) {
    return db.prepare(`
      SELECT articles.id, articles.title, articles.slug, articles.description,
             articles.tags, articles.created_at
      FROM article_tags
      JOIN articles ON articles.id = article_tags.article_id
      WHERE article_tags.tag = ? AND articles.status = 'published'
      ORDER BY articles.created_at DESC, articles.id DESC
    `).all(tag).map(mapArticle);
  }

  function search(query, limit = 50) {
    const terms = String(query || '').normalize('NFKC').trim().split(/\s+/u).filter(Boolean).slice(0, 8);
    if (terms.length === 0) return [];
    const expression = terms.map(term => `"${term.replaceAll('"', '""')}"`).join(' AND ');
    return db.prepare(`
      SELECT articles.id, articles.title, articles.slug, articles.description,
             articles.tags, articles.created_at, bm25(article_fts) AS rank
      FROM article_fts
      JOIN articles ON articles.id = article_fts.rowid
      WHERE article_fts MATCH ? AND articles.status = 'published'
      ORDER BY rank, articles.created_at DESC
      LIMIT ?
    `).all(expression, limit).map(mapArticle);
  }

  function navigationFor(article) {
    const previous = db.prepare(`
      SELECT title, slug FROM articles
      WHERE status = 'published' AND (created_at < ? OR (created_at = ? AND id < ?))
      ORDER BY created_at DESC, id DESC LIMIT 1
    `).get(article.created_at, article.created_at, article.id) || null;
    const next = db.prepare(`
      SELECT title, slug FROM articles
      WHERE status = 'published' AND (created_at > ? OR (created_at = ? AND id > ?))
      ORDER BY created_at ASC, id ASC LIMIT 1
    `).get(article.created_at, article.created_at, article.id) || null;
    return { previous, next };
  }

  function relatedFor(article, limit = 3) {
    return db.prepare(`
      SELECT candidate.id, candidate.title, candidate.slug, candidate.created_at,
             COUNT(*) AS sharedTags
      FROM article_tags source
      JOIN article_tags related ON related.tag = source.tag AND related.article_id <> source.article_id
      JOIN articles candidate ON candidate.id = related.article_id
      WHERE source.article_id = ? AND candidate.status = 'published'
      GROUP BY candidate.id
      ORDER BY sharedTags DESC, candidate.created_at DESC, candidate.id DESC
      LIMIT ?
    `).all(article.id, limit);
  }

  function listAdmin() {
    return db.prepare(`
      SELECT id, title, slug, description, status, tags, created_at, updated_at
      FROM articles ORDER BY updated_at DESC, id DESC
    `).all().map(mapArticle);
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

module.exports = { createArticleService, mapArticle, parseTags };

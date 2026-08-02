/**
 * Explicit article full-text search index maintenance.
 *
 * Schema v3 owns `article_fts` explicitly: no triggers touch it. Every writer
 * (migration, admin upload/replace/delete) calls these helpers inside its own
 * SQLite transaction, and `buildArticleSearchDocument` is the single definition
 * of what a searchable document contains.
 */

/**
 * Build the searchable document for one article, or null when the article is
 * missing. `taxonomy` joins the category and tag labels of the article's own
 * locale so Chinese and English documents stay fully isolated.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {number} articleId
 * @returns {{ title: string, content: string, taxonomy: string } | null}
 */
function buildArticleSearchDocument(db, articleId) {
  const article = db.prepare('SELECT id, locale, title, content FROM articles WHERE id = ?').get(articleId);
  if (!article) return null;
  const rows = db.prepare(`
    SELECT category_labels.name AS category_name, tag_labels.name AS tag_name
    FROM article_tags
    JOIN tags ON tags.id = article_tags.tag_id
    JOIN tag_labels ON tag_labels.tag_id = tags.id AND tag_labels.locale = ?
    JOIN categories ON categories.id = tags.category_id
    JOIN category_labels ON category_labels.category_id = categories.id AND category_labels.locale = ?
    WHERE article_tags.article_id = ?
    ORDER BY tags.sort_order ASC, tags.id ASC
  `).all(article.locale, article.locale, articleId);
  const taxonomy = rows.flatMap(row => [row.category_name, row.tag_name]).join(' ');
  return { title: article.title, content: article.content, taxonomy };
}

/**
 * Replace one article's FTS row with its current document. Missing articles are
 * a no-op. Callers own the enclosing transaction.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {number} articleId
 */
function upsertArticleSearchDocument(db, articleId) {
  const document = buildArticleSearchDocument(db, articleId);
  if (!document) return;
  db.prepare('DELETE FROM article_fts WHERE rowid = ?').run(articleId);
  db.prepare('INSERT INTO article_fts(rowid, title, content, taxonomy) VALUES (?, ?, ?, ?)')
    .run(articleId, document.title, document.content, document.taxonomy);
}

/**
 * Remove one article's FTS row.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {number} articleId
 */
function deleteArticleSearchDocument(db, articleId) {
  db.prepare('DELETE FROM article_fts WHERE rowid = ?').run(articleId);
}

/**
 * Clear and recreate every article document. The caller owns the enclosing
 * transaction (the schema v3 migration and audit tooling run it inside one).
 *
 * @param {import('better-sqlite3').Database} db
 */
function rebuildArticleSearchIndex(db) {
  db.prepare('DELETE FROM article_fts').run();
  const articleIds = db.prepare('SELECT id FROM articles ORDER BY id').all().map(row => row.id);
  for (const articleId of articleIds) {
    upsertArticleSearchDocument(db, articleId);
  }
}

/**
 * Locale-scoped FTS lookup used by tests and audit tooling. Returns matching
 * article ids ordered by relevance.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {'zh' | 'en'} locale
 * @param {string} query
 * @returns {number[]}
 */
function searchArticleIds(db, locale, query) {
  const terms = String(query || '').normalize('NFKC').trim().split(/\s+/u).filter(Boolean).slice(0, 8);
  if (terms.length === 0) return [];
  const expression = terms.map(term => `"${term.replaceAll('"', '""')}"`).join(' AND ');
  return db.prepare(`
    SELECT article_fts.rowid AS id
    FROM article_fts
    JOIN articles ON articles.id = article_fts.rowid
    WHERE article_fts MATCH ? AND articles.locale = ?
    ORDER BY bm25(article_fts), articles.id ASC
  `).all(expression, locale).map(row => row.id);
}

module.exports = {
  buildArticleSearchDocument,
  deleteArticleSearchDocument,
  rebuildArticleSearchIndex,
  searchArticleIds,
  upsertArticleSearchDocument
};

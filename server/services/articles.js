const { SUPPORTED_LOCALES } = require('../i18n/config');
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

function mapArticle(article) {
  if (!article) return null;
  return { ...article, tags: Array.isArray(article.tags) ? article.tags : parseTags(article.tags) };
}

/**
 * Batch-load the shared localized taxonomy projection for a set of articles.
 * Each entry follows the article's own locale; the projection matches
 * `listTaxonomy` so lists, details, and the taxonomy endpoint share one shape
 * without any per-article N+1 queries.
 *
 * @returns {Map<number, { categories: Array<{id, name, slug}>, tags: Array<{id, categoryId, name, slug}> }>}
 */
function loadTaxonomyForArticles(db, articles) {
  const taxonomyByArticle = new Map();
  if (!articles || articles.length === 0) return taxonomyByArticle;
  for (const locale of SUPPORTED_LOCALES) {
    const ids = articles.filter(article => article.locale === locale).map(article => article.id);
    if (ids.length === 0) continue;
    const placeholders = ids.map(() => '?').join(', ');
    const rows = db.prepare(`
      SELECT article_tags.article_id AS article_id,
             tags.id AS tag_id, tags.category_id AS category_id,
             tag_labels.name AS tag_name, tag_labels.slug AS tag_slug,
             category_labels.name AS category_name, category_labels.slug AS category_slug
      FROM article_tags
      JOIN tags ON tags.id = article_tags.tag_id
      JOIN tag_labels ON tag_labels.tag_id = tags.id AND tag_labels.locale = ?
      JOIN category_labels ON category_labels.category_id = tags.category_id AND category_labels.locale = ?
      WHERE article_tags.article_id IN (${placeholders})
      ORDER BY tags.sort_order ASC, tags.id ASC
    `).all(locale, locale, ...ids);
    for (const row of rows) {
      if (!taxonomyByArticle.has(row.article_id)) {
        taxonomyByArticle.set(row.article_id, { categories: [], tags: [], seenCategories: new Set() });
      }
      const entry = taxonomyByArticle.get(row.article_id);
      entry.tags.push({ id: row.tag_id, categoryId: row.category_id, name: row.tag_name, slug: row.tag_slug });
      if (!entry.seenCategories.has(row.category_id)) {
        entry.seenCategories.add(row.category_id);
        entry.categories.push({ id: row.category_id, name: row.category_name, slug: row.category_slug });
      }
    }
  }
  for (const entry of taxonomyByArticle.values()) {
    delete entry.seenCategories;
  }
  return taxonomyByArticle;
}

function attachTaxonomy(db, articles) {
  if (!articles || articles.length === 0) return articles;
  const taxonomyByArticle = loadTaxonomyForArticles(db, articles);
  return articles.map(article => {
    const taxonomy = taxonomyByArticle.get(article.id);
    return {
      ...article,
      taxonomy: taxonomy || { categories: [], tags: [] },
      tags: taxonomy ? taxonomy.tags.map(tag => tag.name) : []
    };
  });
}

function createArticleService(db) {
  const listPublishedStatement = db.prepare(`
    SELECT a.id, a.title, a.slug, a.description, a.created_at, a.updated_at,
           a.locale, a.post_id, p.translation_key AS translationKey
    FROM articles a
    JOIN posts p ON p.id = a.post_id
    WHERE a.status = 'published' AND a.locale = ?
    ORDER BY a.created_at DESC, a.id DESC
    LIMIT ? OFFSET ?
  `);
  const countPublishedStatement = db.prepare(`
    SELECT COUNT(*) AS total FROM articles WHERE status = 'published' AND locale = ?
  `);
  // Public detail needs rendered html + metadata only; raw Markdown stays off
  // the hot path unless callers opt in via includeContent.
  const DETAIL_COLUMNS = `
    a.id, a.title, a.slug, a.description, a.html, a.status,
    a.created_at, a.updated_at, a.locale, a.post_id,
    p.translation_key AS translationKey`;
  const getBySlugStatement = db.prepare(`
    SELECT ${DETAIL_COLUMNS}
    FROM articles a
    JOIN posts p ON p.id = a.post_id
    WHERE a.slug = ? AND a.status = 'published' AND a.locale = ?
  `);
  const getBySlugWithContentStatement = db.prepare(`
    SELECT ${DETAIL_COLUMNS}, a.content
    FROM articles a
    JOIN posts p ON p.id = a.post_id
    WHERE a.slug = ? AND a.status = 'published' AND a.locale = ?
  `);
  const listArchiveStatement = db.prepare(`
    SELECT a.id, a.title, a.slug, a.description, a.created_at, a.updated_at,
           a.locale, a.post_id, p.translation_key AS translationKey
    FROM articles a
    JOIN posts p ON p.id = a.post_id
    WHERE a.status = 'published' AND a.locale = ?
    ORDER BY a.created_at DESC, a.id DESC
  `);
  const tagIdBySlugStatement = db.prepare(`
    SELECT tag_id FROM tag_labels WHERE locale = ? AND slug = ? ORDER BY tag_id
  `);
  const tagIdByNameOrSlugStatement = db.prepare(`
    SELECT tag_id FROM tag_labels WHERE locale = ? AND (name = ? OR slug = ?) ORDER BY tag_id
  `);

  /**
   * Published article list for one locale. The legacy Chinese call shape
   * `listPublished(page, pageSize)` is still accepted.
   */
  function listPublished(locale = ZH_LOCALE, page = 1, pageSize = 20) {
    if (typeof locale === 'number') {
      const legacyPage = locale;
      const legacyPageSize = page;
      locale = ZH_LOCALE;
      page = legacyPage;
      pageSize = legacyPageSize === undefined ? pageSize : legacyPageSize;
    }
    const total = countPublishedStatement.get(locale).total;
    return {
      articles: attachTaxonomy(db, listPublishedStatement.all(locale, pageSize, (page - 1) * pageSize)).map(mapArticle),
      page,
      pageSize,
      total,
      totalPages: Math.ceil(total / pageSize)
    };
  }

  /**
   * Published article by slug within one locale. The legacy Chinese call shape
   * `getPublishedBySlug(slug)` is still accepted. Pass `{ includeContent: true }`
   * when the raw Markdown body is required (admin/replace style consumers).
   */
  function getPublishedBySlug(locale, slug, options = {}) {
    if (slug === undefined) {
      slug = locale;
      locale = ZH_LOCALE;
    }
    const includeContent = options && options.includeContent === true;
    const article = (includeContent ? getBySlugWithContentStatement : getBySlugStatement)
      .get(slug, locale);
    if (!article) return null;
    return mapArticle(attachTaxonomy(db, [article])[0]);
  }

  function listArchive(locale = ZH_LOCALE) {
    return attachTaxonomy(db, listArchiveStatement.all(locale)).map(mapArticle);
  }

  /**
   * Legacy Chinese tag cloud: `{ name, count }` pairs grouped by the zh
   * display label, kept for the pre-i18n `/tags` page and `/api/articles/tags/all`.
   */
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

  /**
   * Published articles carrying a tag. New callers pass
   * `listByTag(locale, slug)`; the legacy Chinese call `listByTag(nameOrSlug)`
   * still resolves against the zh label name or slug.
   */
  function listByTag(locale, tagSlug) {
    let legacyLookup = false;
    if (tagSlug === undefined) {
      tagSlug = locale;
      locale = ZH_LOCALE;
      legacyLookup = true;
    }
    const tagIds = (legacyLookup ? tagIdByNameOrSlugStatement : tagIdBySlugStatement)
      .all(legacyLookup ? [locale, tagSlug, tagSlug] : [locale, tagSlug])
      .map(row => row.tag_id);
    if (tagIds.length === 0) return [];
    const placeholders = tagIds.map(() => '?').join(', ');
    const rows = db.prepare(`
      SELECT a.id, a.title, a.slug, a.description, a.created_at, a.updated_at,
             a.locale, a.post_id, p.translation_key AS translationKey
      FROM article_tags at
      JOIN articles a ON a.id = at.article_id
      JOIN posts p ON p.id = a.post_id
      WHERE at.tag_id IN (${placeholders})
        AND a.status = 'published' AND a.locale = ?
      ORDER BY a.created_at DESC, a.id DESC
    `).all(...tagIds, locale);
    return attachTaxonomy(db, rows).map(mapArticle);
  }

  /**
   * Resolve a tag by its stored localized label (name or slug) in the
   * normalized DB, regardless of origin. This is the fallback the public tag
   * surfaces use for migration-created `origin='legacy'` tags the versioned
   * catalog does not contain: the catalog keeps exact name/slug/legacyNames
   * precedence, and the DB keeps the published runtime truth. Returns the
   * stable tag identity with both locales' labels and the parent category
   * labels, or null when no tag matches.
   */
  function findTag(locale, value) {
    const normalized = String(value || '').normalize('NFKC').trim();
    if (!normalized) return null;
    const row = db.prepare(`
      SELECT t.id AS id, t.category_id AS category_id, t.origin AS origin,
             zh.name AS zh_name, zh.slug AS zh_slug,
             en.name AS en_name, en.slug AS en_slug,
             cz.name AS zh_category_name, cz.slug AS zh_category_slug,
             ce.name AS en_category_name, ce.slug AS en_category_slug
      FROM tag_labels tl
      JOIN tags t ON t.id = tl.tag_id
      JOIN tag_labels zh ON zh.tag_id = t.id AND zh.locale = 'zh'
      JOIN tag_labels en ON en.tag_id = t.id AND en.locale = 'en'
      JOIN category_labels cz ON cz.category_id = t.category_id AND cz.locale = 'zh'
      JOIN category_labels ce ON ce.category_id = t.category_id AND ce.locale = 'en'
      WHERE tl.locale = ? AND (tl.name = ? OR tl.slug = ?)
      ORDER BY t.sort_order ASC, t.id ASC
      LIMIT 1
    `).get(locale, normalized, normalized);
    if (!row) return null;
    return {
      id: row.id,
      origin: row.origin,
      categoryId: row.category_id,
      labels: {
        zh: { name: row.zh_name, slug: row.zh_slug },
        en: { name: row.en_name, slug: row.en_slug }
      },
      category: {
        id: row.category_id,
        labels: {
          zh: { name: row.zh_category_name, slug: row.zh_category_slug },
          en: { name: row.en_category_name, slug: row.en_category_slug }
        }
      }
    };
  }

  /**
   * Published articles in a category resolved by `(locale, category label slug)`.
   * An article with several tags in one category appears once (GROUP BY id).
   */
  function listByCategory(locale, categorySlug) {
    const category = db.prepare(`
      SELECT category_id FROM category_labels WHERE locale = ? AND slug = ?
    `).get(locale, categorySlug);
    if (!category) return [];
    const rows = db.prepare(`
      SELECT a.id, a.title, a.slug, a.description, a.created_at, a.updated_at,
             a.locale, a.post_id, p.translation_key AS translationKey
      FROM articles a
      JOIN posts p ON p.id = a.post_id
      JOIN article_tags at ON at.article_id = a.id
      JOIN tags t ON t.id = at.tag_id
      WHERE t.category_id = ? AND a.status = 'published' AND a.locale = ?
      GROUP BY a.id
      ORDER BY a.created_at DESC, a.id DESC
    `).all(category.category_id, locale);
    return attachTaxonomy(db, rows).map(mapArticle);
  }

  /**
   * Localized taxonomy with distinct published-article counts. Category counts
   * use COUNT(DISTINCT articles.id) so an article with two tags in one category
   * counts once.
   */
  function listTaxonomy(locale = ZH_LOCALE) {
    const categories = db.prepare(`
      SELECT c.id, cl.name, cl.slug, COUNT(DISTINCT a.id) AS count
      FROM categories c
      JOIN category_labels cl ON cl.category_id = c.id AND cl.locale = ?
      JOIN tags t ON t.category_id = c.id
      JOIN article_tags at ON at.tag_id = t.id
      JOIN articles a ON a.id = at.article_id
      WHERE a.status = 'published' AND a.locale = ?
      GROUP BY c.id, cl.name, cl.slug
      ORDER BY c.sort_order ASC, c.id ASC
    `).all(locale, locale);
    const tags = db.prepare(`
      SELECT t.id, t.category_id AS categoryId, tl.name, tl.slug,
             COUNT(DISTINCT a.id) AS count
      FROM tags t
      JOIN tag_labels tl ON tl.tag_id = t.id AND tl.locale = ?
      JOIN article_tags at ON at.tag_id = t.id
      JOIN articles a ON a.id = at.article_id
      WHERE a.status = 'published' AND a.locale = ?
      GROUP BY t.id, tl.name, tl.slug
      ORDER BY t.sort_order ASC, t.id ASC
    `).all(locale, locale);
    return { categories, tags };
  }

  /**
   * Locale-scoped FTS search. The legacy Chinese call `search(query, limit)`
   * is still accepted.
   */
  function search(locale, query, limit = 50) {
    if (typeof locale !== 'string' || !SUPPORTED_LOCALES.includes(locale)) {
      // Legacy Chinese call shapes: search(query) or search(query, limit).
      const legacyLimit = query;
      query = locale;
      locale = ZH_LOCALE;
      limit = legacyLimit === undefined ? limit : legacyLimit;
    }
    const terms = String(query || '').normalize('NFKC').trim().split(/\s+/u).filter(Boolean).slice(0, 8);
    if (terms.length === 0) return [];
    const expression = terms.map(term => `"${term.replaceAll('"', '""')}"`).join(' AND ');
    const rows = db.prepare(`
      SELECT a.id, a.title, a.slug, a.description, a.created_at, a.updated_at,
             a.locale, a.post_id, p.translation_key AS translationKey,
             bm25(article_fts) AS rank
      FROM article_fts
      JOIN articles a ON a.id = article_fts.rowid
      JOIN posts p ON p.id = a.post_id
      WHERE article_fts MATCH ? AND a.status = 'published' AND a.locale = ?
      ORDER BY rank, a.created_at DESC
      LIMIT ?
    `).all(expression, locale, limit);
    return attachTaxonomy(db, rows).map(mapArticle);
  }

  function navigationFor(article) {
    const locale = article.locale || ZH_LOCALE;
    const previous = db.prepare(`
      SELECT title, slug FROM articles
      WHERE status = 'published' AND locale = ?
        AND (created_at < ? OR (created_at = ? AND id < ?))
      ORDER BY created_at DESC, id DESC LIMIT 1
    `).get(locale, article.created_at, article.created_at, article.id) || null;
    const next = db.prepare(`
      SELECT title, slug FROM articles
      WHERE status = 'published' AND locale = ?
        AND (created_at > ? OR (created_at = ? AND id > ?))
      ORDER BY created_at ASC, id ASC LIMIT 1
    `).get(locale, article.created_at, article.created_at, article.id) || null;
    return { previous, next };
  }

  /**
   * Related articles ranked by shared fine-tag count then date/id, always
   * within the source article's own locale. The source article's translation
   * siblings are excluded: they are alternates, not ordinary related content.
   */
  function relatedFor(article, limit = 3) {
    const locale = article.locale || ZH_LOCALE;
    return db.prepare(`
      SELECT candidate.id, candidate.title, candidate.slug, candidate.created_at,
             candidate.locale, COUNT(*) AS sharedTags
      FROM article_tags source
      JOIN article_tags related ON related.tag_id = source.tag_id AND related.article_id <> source.article_id
      JOIN articles candidate ON candidate.id = related.article_id
        AND candidate.locale = ? AND candidate.status = 'published'
        AND candidate.post_id <> ?
      WHERE source.article_id = ?
      GROUP BY candidate.id
      ORDER BY sharedTags DESC, candidate.created_at DESC, candidate.id DESC
      LIMIT ?
    `).all(locale, article.post_id, article.id, limit);
  }

  /**
   * The published sibling translation of an article, or null when the other
   * locale is absent or not yet published.
   */
  function alternateFor(article) {
    if (!article || !article.post_id) return null;
    return db.prepare(`
      SELECT id, locale, slug, title, created_at
      FROM articles
      WHERE post_id = ? AND locale <> ? AND status = 'published'
      LIMIT 1
    `).get(article.post_id, article.locale || ZH_LOCALE) || null;
  }

  function listAdmin() {
    return listAdminArticles(db);
  }

  return Object.freeze({
    alternateFor,
    findTag,
    getPublishedBySlug,
    listAdmin,
    listArchive,
    listByCategory,
    listByTag,
    listPublished,
    listTags,
    listTaxonomy,
    mapArticle,
    navigationFor,
    relatedFor,
    search
  });
}

/**
 * Batch-load localized tag and category display labels for a set of admin
 * rows. Labels follow each article's own locale so the zh and en versions of
 * the same logical post read naturally in the admin list.
 *
 * @returns {Map<number, { categories: string[], tags: string[] }>}
 */
function loadAdminTaxonomy(db, articles) {
  const taxonomyByArticle = new Map();
  if (!articles || articles.length === 0) return taxonomyByArticle;
  const rows = [];
  for (const locale of SUPPORTED_LOCALES) {
    const ids = articles.filter(article => article.locale === locale).map(article => article.id);
    if (ids.length === 0) continue;
    const placeholders = ids.map(() => '?').join(', ');
    rows.push(...db.prepare(`
      SELECT article_tags.article_id AS article_id,
             category_labels.name AS category_name,
             tag_labels.name AS tag_name
      FROM article_tags
      JOIN tags ON tags.id = article_tags.tag_id
      JOIN tag_labels ON tag_labels.tag_id = tags.id AND tag_labels.locale = ?
      JOIN category_labels ON category_labels.category_id = tags.category_id AND category_labels.locale = ?
      WHERE article_tags.article_id IN (${placeholders})
      ORDER BY tags.sort_order ASC, tags.id ASC
    `).all(locale, locale, ...ids));
  }
  for (const row of rows) {
    if (!taxonomyByArticle.has(row.article_id)) {
      taxonomyByArticle.set(row.article_id, { categories: [], tags: [], seenCategories: new Set() });
    }
    const entry = taxonomyByArticle.get(row.article_id);
    entry.tags.push(row.tag_name);
    if (!entry.seenCategories.has(row.category_name)) {
      entry.seenCategories.add(row.category_name);
      entry.categories.push(row.category_name);
    }
  }
  return taxonomyByArticle;
}

function attachAdminTaxonomy(db, articles) {
  if (!articles || articles.length === 0) return articles;
  const taxonomyByArticle = loadAdminTaxonomy(db, articles);
  return articles.map(article => {
    const taxonomy = taxonomyByArticle.get(article.id);
    return {
      ...article,
      categories: taxonomy ? taxonomy.categories : [],
      tags: taxonomy ? taxonomy.tags : []
    };
  });
}

/**
 * The full admin article list across every locale. Unlike the public zh-scoped
 * surfaces, the admin needs both versions of a logical post, their translation
 * group, and their localized category/tag labels.
 */
function listAdminArticles(db) {
  const rows = db.prepare(`
    SELECT a.id, a.title, a.slug, a.description, a.status, a.created_at, a.updated_at,
           a.locale, a.post_id, p.translation_key AS translationKey
    FROM articles a
    JOIN posts p ON p.id = a.post_id
    ORDER BY a.updated_at DESC, a.id DESC
  `).all();
  return attachAdminTaxonomy(db, rows);
}

module.exports = {
  createArticleService,
  listAdminArticles
};

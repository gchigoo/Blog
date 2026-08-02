const { createHash } = require('node:crypto');
const { loadTaxonomyCatalog, SYSTEM_CATEGORY_ID, SYSTEM_TAG_ID } = require('../taxonomy/catalog');
const { SUPPORTED_LOCALES } = require('../i18n/config');
const config = require('../config');
const { rebuildArticleSearchIndex } = require('./search-index');

const LEGACY_ID_PREFIX = 'legacy-';
const INITIAL_DIGEST_LENGTH = 12;
const DIGEST_STEP = 8;
const FULL_DIGEST_LENGTH = 64;

function parseLegacyTags(value) {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter(tag => typeof tag === 'string') : [];
  } catch {
    return [];
  }
}

function seedCatalog(db, catalog) {
  const insertCategory = db.prepare(`
    INSERT INTO categories (id, sort_order, origin) VALUES (?, ?, 'config')
  `);
  const insertCategoryLabel = db.prepare(`
    INSERT INTO category_labels (category_id, locale, name, slug) VALUES (?, ?, ?, ?)
  `);
  const insertTag = db.prepare(`
    INSERT INTO tags (id, category_id, sort_order, origin, is_system) VALUES (?, ?, ?, 'config', ?)
  `);
  const insertTagLabel = db.prepare(`
    INSERT INTO tag_labels (tag_id, locale, name, slug) VALUES (?, ?, ?, ?)
  `);
  for (const category of catalog.categories) {
    insertCategory.run(category.id, category.sortOrder);
    for (const locale of SUPPORTED_LOCALES) {
      insertCategoryLabel.run(category.id, locale, category.labels[locale].name, category.labels[locale].slug);
    }
    for (const tag of category.tags || []) {
      insertTag.run(tag.id, category.id, tag.sortOrder, tag.id === SYSTEM_TAG_ID ? 1 : 0);
      for (const locale of SUPPORTED_LOCALES) {
        insertTagLabel.run(tag.id, locale, tag.labels[locale].name, tag.labels[locale].slug);
      }
    }
  }
}

/**
 * Allocate a deterministic `legacy-<sha256>` tag for an unknown label.
 * The base uses the first 12 hex characters of sha256(normalizedLabel); on a
 * collision with a different catalog id or any localized slug the same digest
 * is extended in 8-character increments. Only a full-digest collision fails.
 * Repeated equivalent labels return the already-allocated tag. The display
 * name preserves the trimmed source text while both locale slugs use the safe
 * generated id.
 */
function allocateLegacyTag(db, normalizedLabel, displayName, allocated, statements) {
  const digest = createHash('sha256').update(normalizedLabel).digest('hex');
  const { findTag, findSlug, insertTag, insertTagLabel } = statements;
  let length = INITIAL_DIGEST_LENGTH;
  for (;;) {
    const candidate = `${LEGACY_ID_PREFIX}${digest.slice(0, length)}`;
    const previousLabel = allocated.get(candidate);
    if (previousLabel === normalizedLabel) return candidate;
    const existing = findTag.get(candidate);
    if (existing) {
      // A pre-existing legacy tag id is the label digest, so it belongs to
      // this same label; any other origin is a deliberate config collision.
      if (existing.origin === 'legacy' && previousLabel === undefined) {
        allocated.set(candidate, normalizedLabel);
        return candidate;
      }
    } else if (!findSlug.get(candidate)) {
      insertTag.run(candidate, SYSTEM_CATEGORY_ID);
      for (const locale of SUPPORTED_LOCALES) {
        insertTagLabel.run(candidate, locale, displayName, candidate);
      }
      allocated.set(candidate, normalizedLabel);
      return candidate;
    }
    if (length >= FULL_DIGEST_LENGTH) {
      throw new Error(`legacy tag digest collision for ${JSON.stringify(normalizedLabel)}`);
    }
    length = Math.min(FULL_DIGEST_LENGTH, length + DIGEST_STEP);
  }
}

/**
 * Create a legacy-label resolver. Both schema v3 migration and the transitional
 * admin upload path share this so uploads and migration allocate identical tag
 * ids for identical text.
 *
 * Mapping order: exact stable tag ids (upload only), the system `other`
 * names/slugs, catalog tag names, then catalog `legacyNames`. Unknown values
 * become deterministic legacy tags under the config-owned `uncategorized`
 * category. Equivalent (NFKC) values deduplicate via the shared digest.
 */
function createTagResolver(db, options = {}) {
  const catalog = options.catalog || loadTaxonomyCatalog(options.taxonomyPath || config.taxonomyPath);
  const acceptTagIds = options.acceptTagIds === true;
  const byNormalized = new Map();
  const tagIdSet = new Set();
  const allocated = new Map();

  const addMapping = (value, tagId) => {
    const normalized = String(value).normalize('NFKC').trim();
    if (normalized !== '' && !byNormalized.has(normalized)) {
      byNormalized.set(normalized, tagId);
    }
  };

  for (const category of catalog.categories) {
    for (const tag of category.tags || []) {
      tagIdSet.add(tag.id);
    }
  }

  for (const category of catalog.categories) {
    for (const tag of category.tags || []) {
      if (tag.id !== SYSTEM_TAG_ID) continue;
      for (const locale of Object.keys(tag.labels)) {
        addMapping(tag.labels[locale].name, SYSTEM_TAG_ID);
        addMapping(tag.labels[locale].slug, SYSTEM_TAG_ID);
      }
    }
  }
  for (const category of catalog.categories) {
    for (const tag of category.tags || []) {
      if (tag.id === SYSTEM_TAG_ID) continue;
      for (const locale of Object.keys(tag.labels)) {
        addMapping(tag.labels[locale].name, tag.id);
      }
      for (const legacyName of tag.legacyNames || []) {
        addMapping(legacyName, tag.id);
      }
    }
  }

  const statements = Object.freeze({
    findTag: db.prepare('SELECT id, origin FROM tags WHERE id = ?'),
    findSlug: db.prepare('SELECT 1 FROM tag_labels WHERE slug = ? LIMIT 1'),
    insertTag: db.prepare(`
      INSERT INTO tags (id, category_id, sort_order, origin, is_system)
      VALUES (?, ?, 0, 'legacy', 0)
    `),
    insertTagLabel: db.prepare(`
      INSERT INTO tag_labels (tag_id, locale, name, slug) VALUES (?, ?, ?, ?)
    `)
  });

  return function resolveTagId(value) {
    if (typeof value !== 'string' || value === '') {
      throw new TypeError('article tag must be a non-empty string');
    }
    const raw = value.trim();
    const normalized = raw.normalize('NFKC');
    if (acceptTagIds && tagIdSet.has(raw)) return raw;
    const mapped = byNormalized.get(normalized);
    if (mapped) return mapped;
    return allocateLegacyTag(db, normalized, raw, allocated, statements);
  };
}

/**
 * Schema v3: normalize articles into `posts` + localized `articles`, seed the
 * taxonomy catalog, attach normalized tags, and rebuild the standalone FTS.
 *
 * Runs with foreign keys disabled by the migration runner; every statement in
 * here belongs to the runner's single transaction.
 */
function migrateLocalizedArticleSchema(db, options = {}) {
  const taxonomyPath = options.taxonomyPath || config.taxonomyPath;
  const catalog = loadTaxonomyCatalog(taxonomyPath);
  const fallbackTimestamp = new Date().toISOString();

  const legacyArticles = db.prepare(`
    SELECT id, title, slug, content, html, tags, status, description, created_at, updated_at
    FROM articles ORDER BY id
  `).all();

  // Drop the schema v1 search machinery before touching the articles table.
  db.exec(`
    DROP TRIGGER IF EXISTS articles_search_ai;
    DROP TRIGGER IF EXISTS articles_search_ad;
    DROP TRIGGER IF EXISTS articles_search_au;
    DROP TABLE IF EXISTS article_fts;
    DROP TABLE IF EXISTS article_tags;
  `);

  db.exec(`
    CREATE TABLE posts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      translation_key TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE articles_v3 (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      post_id INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
      locale TEXT NOT NULL CHECK (locale IN ('zh', 'en')),
      title TEXT NOT NULL,
      slug TEXT NOT NULL,
      content TEXT NOT NULL,
      html TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'published' CHECK (status IN ('draft', 'published')),
      description TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(post_id, locale),
      UNIQUE(locale, slug)
    );
  `);

  const insertPost = db.prepare('INSERT INTO posts (translation_key, created_at, updated_at) VALUES (?, ?, ?)');
  const insertArticle = db.prepare(`
    INSERT INTO articles_v3 (id, post_id, locale, title, slug, content, html, status, description, created_at, updated_at)
    VALUES (?, ?, 'zh', ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (const row of legacyArticles) {
    const createdAt = row.created_at || row.updated_at || fallbackTimestamp;
    const updatedAt = row.updated_at || row.created_at || fallbackTimestamp;
    const postId = Number(insertPost.run(row.slug, createdAt, updatedAt).lastInsertRowid);
    insertArticle.run(
      row.id, postId, row.title, row.slug, row.content, row.html,
      row.status || 'published', row.description ?? null, createdAt, updatedAt
    );
  }

  db.exec(`
    DROP TABLE articles;
    ALTER TABLE articles_v3 RENAME TO articles;
  `);

  db.exec(`
    CREATE TABLE categories (
      id TEXT PRIMARY KEY,
      sort_order INTEGER NOT NULL,
      origin TEXT NOT NULL CHECK (origin IN ('config', 'legacy'))
    );
    CREATE TABLE category_labels (
      category_id TEXT NOT NULL REFERENCES categories(id) ON DELETE CASCADE,
      locale TEXT NOT NULL CHECK (locale IN ('zh', 'en')),
      name TEXT NOT NULL,
      slug TEXT NOT NULL,
      PRIMARY KEY(category_id, locale),
      UNIQUE(locale, slug)
    );
    CREATE TABLE tags (
      id TEXT PRIMARY KEY,
      category_id TEXT NOT NULL REFERENCES categories(id) ON DELETE RESTRICT,
      sort_order INTEGER NOT NULL,
      origin TEXT NOT NULL CHECK (origin IN ('config', 'legacy')),
      is_system INTEGER NOT NULL DEFAULT 0 CHECK (is_system IN (0, 1))
    );
    CREATE TABLE tag_labels (
      tag_id TEXT NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
      locale TEXT NOT NULL CHECK (locale IN ('zh', 'en')),
      name TEXT NOT NULL,
      slug TEXT NOT NULL,
      PRIMARY KEY(tag_id, locale),
      UNIQUE(locale, slug)
    );
    CREATE TABLE article_tags (
      article_id INTEGER NOT NULL REFERENCES articles(id) ON DELETE CASCADE,
      tag_id TEXT NOT NULL REFERENCES tags(id) ON DELETE RESTRICT,
      PRIMARY KEY(article_id, tag_id)
    );
    CREATE VIRTUAL TABLE article_fts USING fts5(
      title,
      content,
      taxonomy,
      tokenize = 'unicode61'
    );

    CREATE INDEX idx_articles_locale_status_created
      ON articles(locale, status, created_at DESC, id DESC);
    CREATE INDEX idx_articles_post_id
      ON articles(post_id);
    CREATE INDEX idx_categories_sort_order
      ON categories(sort_order);
    CREATE INDEX idx_tags_category_sort
      ON tags(category_id, sort_order);
    CREATE INDEX idx_tags_category
      ON tags(category_id);
    CREATE INDEX idx_article_tags_tag
      ON article_tags(tag_id);
  `);

  seedCatalog(db, catalog);

  const resolveTagId = createTagResolver(db, { catalog });
  const insertArticleTag = db.prepare('INSERT OR IGNORE INTO article_tags (article_id, tag_id) VALUES (?, ?)');
  for (const article of legacyArticles) {
    const tagIds = new Set();
    const values = parseLegacyTags(article.tags)
      .map(value => value.trim())
      .filter(value => value !== '')
      .sort();
    for (const value of values) {
      tagIds.add(resolveTagId(value));
    }
    if (tagIds.size === 0) tagIds.add(SYSTEM_TAG_ID);
    for (const tagId of tagIds) {
      insertArticleTag.run(article.id, tagId);
    }
  }

  rebuildArticleSearchIndex(db);
}

module.exports = {
  LEGACY_ID_PREFIX,
  SYSTEM_CATEGORY_ID,
  SYSTEM_TAG_ID,
  allocateLegacyTag,
  createTagResolver,
  migrateLocalizedArticleSchema,
  parseLegacyTags,
  seedCatalog
};

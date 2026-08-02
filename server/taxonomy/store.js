'use strict';

/**
 * Read-only taxonomy synchronization planning.
 *
 * `planTaxonomySync(db, catalog, options)` diffs the normalized SQLite
 * taxonomy (schema v3) against the maintenance catalog and returns a
 * deterministic `TaxonomySyncPlan`. It performs no database writes, no file
 * writes, and no journal/lock activity; dry-run purity is guaranteed by
 * construction. The apply/recovery flows in `server/taxonomy/publication.js`
 * consume the plan and record it in the durable manifest.
 *
 * Token resolution contract for transitional Markdown `tags` lists: a token
 * may be an existing stable tag ID, an unambiguous current display label, or a
 * catalog `legacyNames` value. It is resolved against the current database
 * (display labels win over legacy names), the resulting set is compared with
 * `article_tags`, and unknown/ambiguous/mismatched values are reported as
 * blocking conflicts instead of guesses. An empty file tag list is the
 * system `other` tag, matching the migration/upload invariant.
 */

const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { parseMarkdownDocument, rewriteMarkdownTags } = require('../utils/markdown');
const { SUPPORTED_LOCALES } = require('../i18n/config');
const { SYSTEM_CATEGORY_ID, SYSTEM_TAG_ID, validateTaxonomyCatalog } = require('./catalog');
const { SAFE_SLUG_PATTERN, resolveArticlePath, resolveOwnedPath } = require('../utils/path-security');
const { fileSha256, sha256Hex } = require('../operations/journal');

const LEGACY_ID_PREFIX = 'legacy-';
const INITIAL_DIGEST_LENGTH = 12;
const DIGEST_STEP = 8;
const FULL_DIGEST_LENGTH = 64;

function byId(left, right) {
  return left.id.localeCompare(right.id);
}

function emptyPlan() {
  return {
    insertedCategories: [],
    updatedCategories: [],
    deletedCategories: [],
    insertedTags: [],
    updatedTags: [],
    deletedTags: [],
    legacyRewires: [],
    markdownRewrites: [],
    unmappedLegacyTags: [],
    blockedSlugChanges: [],
    blockedDeletions: [],
    conflicts: [],
    affectedArticleIds: []
  };
}

/**
 * Deterministic `legacy-<sha256>[:n]` allocation for a normalized label,
 * mirroring `server/articles/schema.js` without any database writes. The
 * digest extends in 8-character increments when the candidate collides with a
 * catalog tag id or any localized tag slug, matching the migration.
 */
function previewLegacyTagId(normalizedLabel, catalog) {
  const digest = cryptoHash(normalizedLabel);
  const reservedIds = new Set();
  const reservedSlugs = new Set();
  for (const category of catalog.categories) {
    for (const tag of category.tags || []) {
      reservedIds.add(tag.id);
      for (const locale of SUPPORTED_LOCALES) {
        reservedSlugs.add(tag.labels[locale].slug.normalize('NFKC').trim());
      }
    }
  }
  let length = INITIAL_DIGEST_LENGTH;
  for (;;) {
    const candidate = `${LEGACY_ID_PREFIX}${digest.slice(0, length)}`;
    if (!reservedIds.has(candidate) && !reservedSlugs.has(candidate)) return candidate;
    if (length >= FULL_DIGEST_LENGTH) {
      throw new Error(`legacy tag digest collision for ${JSON.stringify(normalizedLabel)}`);
    }
    length = Math.min(FULL_DIGEST_LENGTH, length + DIGEST_STEP);
  }
}

function cryptoHash(normalizedLabel) {
  return createHash('sha256').update(normalizedLabel).digest('hex');
}

function normalizeToken(value) {
  return String(value).normalize('NFKC').trim();
}

function loadSnapshot(db) {
  const state = {
    categories: db.prepare('SELECT id, sort_order, origin FROM categories ORDER BY id').all(),
    categoryLabels: db.prepare('SELECT category_id, locale, name, slug FROM category_labels ORDER BY category_id, locale').all(),
    tags: db.prepare('SELECT id, category_id, sort_order, origin, is_system FROM tags ORDER BY id').all(),
    tagLabels: db.prepare('SELECT tag_id, locale, name, slug FROM tag_labels ORDER BY tag_id, locale').all(),
    articleTags: db.prepare('SELECT article_id, tag_id FROM article_tags ORDER BY article_id, tag_id').all(),
    articles: db.prepare('SELECT id, post_id, locale, slug FROM articles ORDER BY id').all(),
    posts: db.prepare('SELECT id, translation_key FROM posts ORDER BY id').all()
  };
  const categoryById = new Map(state.categories.map(category => [category.id, category]));
  const tagById = new Map(state.tags.map(tag => [tag.id, tag]));
  const postById = new Map(state.posts.map(post => [post.id, post]));
  const categoryLabelsByCategory = new Map();
  for (const label of state.categoryLabels) {
    if (!categoryLabelsByCategory.has(label.category_id)) categoryLabelsByCategory.set(label.category_id, new Map());
    categoryLabelsByCategory.get(label.category_id).set(label.locale, label);
  }
  const tagLabelsByTag = new Map();
  for (const label of state.tagLabels) {
    if (!tagLabelsByTag.has(label.tag_id)) tagLabelsByTag.set(label.tag_id, new Map());
    tagLabelsByTag.get(label.tag_id).set(label.locale, label);
  }
  const labelByName = new Map();
  for (const label of state.tagLabels) {
    const key = normalizeToken(label.name);
    if (!labelByName.has(key)) labelByName.set(key, new Set());
    labelByName.get(key).add(label.tag_id);
  }
  const articleTagsByArticle = new Map();
  for (const row of state.articleTags) {
    if (!articleTagsByArticle.has(row.article_id)) articleTagsByArticle.set(row.article_id, new Set());
    articleTagsByArticle.get(row.article_id).add(row.tag_id);
  }
  const articleTagRefCount = new Map();
  for (const row of state.articleTags) {
    articleTagRefCount.set(row.tag_id, (articleTagRefCount.get(row.tag_id) || 0) + 1);
  }
  return {
    state,
    categoryById,
    tagById,
    postById,
    categoryLabelsByCategory,
    tagLabelsByTag,
    labelByName,
    articleTagsByArticle,
    articleTagRefCount
  };
}

function buildCatalogIndexes(catalog) {
  const catalogCategories = new Map(catalog.categories.map(category => [category.id, category]));
  const catalogTags = new Map();
  for (const category of catalog.categories) {
    for (const tag of category.tags || []) {
      catalogTags.set(tag.id, { categoryId: category.id, tag });
    }
  }
  const legacyNamesToTags = new Map();
  for (const category of catalog.categories) {
    for (const tag of category.tags || []) {
      const names = new Set((tag.legacyNames || []).map(normalizeToken).filter(Boolean));
      for (const name of names) {
        if (!legacyNamesToTags.has(name)) legacyNamesToTags.set(name, new Set());
        legacyNamesToTags.get(name).add(tag.id);
      }
    }
  }
  return { catalogCategories, catalogTags, legacyNamesToTags };
}

/**
 * Resolve one transitional tag token against the current database and the
 * incoming catalog. Display labels of current DB tags take precedence; catalog
 * `legacyNames` are consulted only when no label matched.
 *
 * @returns {{ kind: 'tag', tagId: string } | { kind: 'ambiguous', candidates: string[] } | { kind: 'unknown' }}
 */
function resolveTokenToTag(token, snapshot, indexes) {
  const normalized = normalizeToken(token);
  if (normalized === '') return { kind: 'unknown' };
  if (snapshot.tagById.has(normalized)) return { kind: 'tag', tagId: normalized };
  const byLabel = snapshot.labelByName.get(normalized);
  if (byLabel) {
    const candidates = [...byLabel].sort();
    if (candidates.length === 1) return { kind: 'tag', tagId: candidates[0] };
    return { kind: 'ambiguous', candidates };
  }
  const byLegacyName = indexes.legacyNamesToTags.get(normalized);
  if (byLegacyName) {
    const candidates = [...byLegacyName].sort();
    if (candidates.length === 1) return { kind: 'tag', tagId: candidates[0] };
    return { kind: 'ambiguous', candidates };
  }
  return { kind: 'unknown' };
}

/**
 * Public helper used by tests and auditors: resolve a normalized Markdown tags
 * array to stable tag IDs against the current database.
 *
 * @returns {{ tagIds: Set<string>, conflicts: Array<{token, type}> }}
 */
function resolveMarkdownTagTokens(db, catalog, tokens) {
  const snapshot = loadSnapshot(db);
  const indexes = buildCatalogIndexes(catalog);
  const tagIds = new Set();
  const conflicts = [];
  for (const token of tokens || []) {
    const resolved = resolveTokenToTag(token, snapshot, indexes);
    if (resolved.kind === 'tag') tagIds.add(resolved.tagId);
    else if (resolved.kind === 'ambiguous') conflicts.push({ token, type: 'ambiguous-token' });
    else conflicts.push({ token, type: 'unknown-token' });
  }
  return { tagIds, conflicts };
}

function labelsFromCatalog(labels) {
  const result = {};
  for (const locale of SUPPORTED_LOCALES) {
    result[locale] = { name: labels[locale].name, slug: labels[locale].slug };
  }
  return result;
}

function legacyOwnerFor(tag, snapshot, indexes) {
  const zhLabel = snapshot.tagLabelsByTag.get(tag.id)?.get('zh');
  if (!zhLabel) return null;
  const owners = indexes.legacyNamesToTags.get(normalizeToken(zhLabel.name));
  if (!owners || owners.size !== 1) return null;
  return [...owners][0];
}

function diffCategories(plan, catalog, snapshot, indexes) {
  const catalogCategories = indexes.catalogCategories;
  for (const category of catalog.categories) {
    const dbCategory = snapshot.categoryById.get(category.id);
    if (!dbCategory) {
      plan.insertedCategories.push({ id: category.id, sortOrder: category.sortOrder, labels: labelsFromCatalog(category.labels) });
      continue;
    }
    const changes = [];
    if (dbCategory.sort_order !== category.sortOrder) changes.push('sort-order');
    const dbLabels = snapshot.categoryLabelsByCategory.get(category.id) || new Map();
    for (const locale of SUPPORTED_LOCALES) {
      const dbLabel = dbLabels.get(locale);
      const newLabel = category.labels[locale];
      if (!dbLabel) {
        changes.push(`label:${locale}`);
        continue;
      }
      if (dbLabel.name !== newLabel.name) changes.push(`label:${locale}`);
      if (dbLabel.slug !== newLabel.slug) {
        plan.blockedSlugChanges.push({
          kind: 'category', id: category.id, locale,
          oldSlug: dbLabel.slug, newSlug: newLabel.slug
        });
      }
    }
    if (changes.length > 0) {
      plan.updatedCategories.push({ id: category.id, sortOrder: category.sortOrder, labels: labelsFromCatalog(category.labels), changes });
    }
  }
  for (const dbCategory of snapshot.state.categories) {
    if (catalogCategories.has(dbCategory.id)) continue;
    if (dbCategory.id === SYSTEM_CATEGORY_ID) {
      plan.blockedDeletions.push({ kind: 'category', id: dbCategory.id, reason: 'system category cannot be deleted' });
      continue;
    }
    const hasTags = snapshot.state.tags.some(tag => tag.category_id === dbCategory.id);
    if (hasTags) {
      plan.blockedDeletions.push({ kind: 'category', id: dbCategory.id, reason: 'category still contains tags' });
      continue;
    }
    plan.deletedCategories.push({
      id: dbCategory.id,
      sortOrder: dbCategory.sort_order,
      labels: labelsFromSnapshot(snapshot.categoryLabelsByCategory.get(dbCategory.id))
    });
  }
}

function labelsFromSnapshot(labelsByLocale) {
  const result = {};
  for (const locale of SUPPORTED_LOCALES) {
    const label = labelsByLocale?.get(locale);
    result[locale] = label ? { name: label.name, slug: label.slug } : null;
  }
  return result;
}

function diffTags(plan, catalog, snapshot, indexes) {
  const catalogTags = indexes.catalogTags;
  for (const category of catalog.categories) {
    for (const tag of category.tags || []) {
      const dbTag = snapshot.tagById.get(tag.id);
      if (!dbTag) {
        plan.insertedTags.push({
          id: tag.id,
          categoryId: category.id,
          sortOrder: tag.sortOrder,
          labels: labelsFromCatalog(tag.labels)
        });
        continue;
      }
      if (dbTag.origin === 'legacy') {
        // A catalog config id collides with an existing legacy tag id.
        plan.conflicts.push({ type: 'legacy-id-collision', tagId: tag.id });
        continue;
      }
      if (tag.id === SYSTEM_TAG_ID) {
        if (dbTag.category_id !== SYSTEM_CATEGORY_ID) {
          plan.blockedDeletions.push({ kind: 'system-tag', id: tag.id, reason: 'system tag changed category' });
          continue;
        }
      }
      const changes = [];
      if (dbTag.category_id !== category.id) changes.push('category');
      if (dbTag.sort_order !== tag.sortOrder) changes.push('sort-order');
      const dbLabels = snapshot.tagLabelsByTag.get(tag.id) || new Map();
      for (const locale of SUPPORTED_LOCALES) {
        const dbLabel = dbLabels.get(locale);
        const newLabel = tag.labels[locale];
        if (!dbLabel) {
          changes.push(`label:${locale}`);
          continue;
        }
        if (dbLabel.name !== newLabel.name) changes.push(`label:${locale}`);
        if (dbLabel.slug !== newLabel.slug) {
          plan.blockedSlugChanges.push({
            kind: 'tag', id: tag.id, locale,
            oldSlug: dbLabel.slug, newSlug: newLabel.slug
          });
        }
      }
      if (changes.length > 0) {
        plan.updatedTags.push({
          id: tag.id,
          categoryId: category.id,
          sortOrder: tag.sortOrder,
          labels: labelsFromCatalog(tag.labels),
          changes
        });
      }
    }
  }
  for (const dbTag of snapshot.state.tags) {
    if (catalogTags.has(dbTag.id)) continue;
    if (dbTag.origin === 'legacy') {
      const owner = legacyOwnerFor(dbTag, snapshot, indexes);
      if (owner) {
        if ((snapshot.articleTagRefCount.get(dbTag.id) || 0) > 0) {
          plan.legacyRewires.push({ legacyTagId: dbTag.id, tagId: owner });
        }
        plan.deletedTags.push({ id: dbTag.id, categoryId: dbTag.category_id, origin: 'legacy' });
      } else {
        plan.unmappedLegacyTags.push(dbTag.id);
      }
    } else if (dbTag.is_system) {
      plan.blockedDeletions.push({ kind: 'tag', id: dbTag.id, reason: 'system tag cannot be deleted' });
    } else if ((snapshot.articleTagRefCount.get(dbTag.id) || 0) > 0) {
      plan.blockedDeletions.push({ kind: 'tag', id: dbTag.id, reason: 'tag is still referenced by articles' });
    } else {
      plan.deletedTags.push({ id: dbTag.id, categoryId: dbTag.category_id, origin: 'config' });
    }
  }
}

function computeAffectedArticles(plan, snapshot) {
  const affectedTagIds = new Set();
  for (const tag of plan.updatedTags) affectedTagIds.add(tag.id);
  for (const rewire of plan.legacyRewires) affectedTagIds.add(rewire.legacyTagId);
  for (const category of plan.updatedCategories) {
    if (!category.changes.some(change => change.startsWith('label:'))) continue;
    for (const tag of snapshot.state.tags) {
      if (tag.category_id === category.id) affectedTagIds.add(tag.id);
    }
  }
  const affectedArticleIds = new Set();
  for (const row of snapshot.state.articleTags) {
    if (affectedTagIds.has(row.tag_id)) affectedArticleIds.add(row.article_id);
  }
  return { affectedTagIds, affectedArticleIds };
}

/**
 * Resolve exactly one archive for an affected article: prefer
 * `articles/<locale>/<slug>.md`; before the content migration, allow the
 * transitional `articles/<slug>.md` only for Chinese. Both present, neither
 * present, or a slug/locale/translation-key mismatch is a blocking conflict.
 */
function discoverArchive(article, snapshot, articlesDir) {
  if (!SAFE_SLUG_PATTERN.test(article.slug)) {
    return { conflict: 'unsafe-path', slug: article.slug };
  }
  const candidates = [];
  try {
    candidates.push({
      kind: 'localized',
      absolute: resolveOwnedPath(articlesDir, path.join(article.locale, `${article.slug}.md`))
    });
    if (article.locale === 'zh') {
      candidates.push({ kind: 'transitional', absolute: resolveArticlePath(articlesDir, article.slug) });
    }
  } catch {
    return { conflict: 'unsafe-path', slug: article.slug };
  }
  const present = candidates.filter(candidate => fs.existsSync(candidate.absolute));
  if (present.length > 1) {
    return { conflict: 'both-layouts-present', layouts: present.map(candidate => candidate.kind) };
  }
  if (present.length === 0) return { conflict: 'missing-markdown', slug: article.slug };
  let raw;
  try {
    raw = fs.readFileSync(present[0].absolute, 'utf8');
  } catch {
    return { conflict: 'unreadable-markdown', slug: article.slug };
  }
  return {
    absolute: present[0].absolute,
    relativePath: path.relative(articlesDir, present[0].absolute),
    raw
  };
}

function planFileRewrites(plan, article, archive, snapshot, indexes, tagLabelChanges) {
  const post = snapshot.postById.get(article.post_id);
  let parsed;
  try {
    parsed = parseMarkdownDocument(archive.raw);
  } catch (error) {
    plan.conflicts.push({ articleId: article.id, type: 'invalid-markdown', detail: error.message });
    return;
  }
  const fileLocale = parsed.data.locale || 'zh';
  const fileTranslationKey = parsed.data.translationKey || parsed.data.slug;
  if (
    parsed.data.slug !== article.slug
    || fileLocale !== article.locale
    || !post
    || fileTranslationKey !== post.translation_key
  ) {
    plan.conflicts.push({
      articleId: article.id,
      type: 'metadata-mismatch',
      fileSlug: parsed.data.slug,
      fileLocale,
      fileTranslationKey
    });
    return;
  }
  const tokens = Array.isArray(parsed.data.tags) ? parsed.data.tags : [];
  const resolvedSet = new Set();
  let tokenConflict = null;
  for (const token of tokens) {
    const resolved = resolveTokenToTag(token, snapshot, indexes);
    if (resolved.kind === 'tag') resolvedSet.add(resolved.tagId);
    else if (resolved.kind === 'ambiguous') {
      tokenConflict = { articleId: article.id, type: 'ambiguous-token', token, candidates: resolved.candidates };
      break;
    } else {
      tokenConflict = { articleId: article.id, type: 'unknown-token', token };
      break;
    }
  }
  if (tokenConflict) {
    plan.conflicts.push(tokenConflict);
    return;
  }
  const fileSetForComparison = new Set(resolvedSet);
  if (fileSetForComparison.size === 0) fileSetForComparison.add(SYSTEM_TAG_ID);
  const dbSet = snapshot.articleTagsByArticle.get(article.id) || new Set();
  if (!setsEqual(fileSetForComparison, dbSet)) {
    plan.conflicts.push({
      articleId: article.id,
      type: 'db-file-tag-mismatch',
      fileTags: [...fileSetForComparison].sort(),
      dbTags: [...dbSet].sort()
    });
    return;
  }

  // Build rewrites only for actual referenced aliases, preserving order and
  // removing duplicates created by a rewire.
  const rewritten = [];
  const seen = new Set();
  const rewrites = [];
  for (const token of tokens) {
    const resolved = resolveTokenToTag(token, snapshot, indexes);
    if (resolved.kind !== 'tag') continue; // equality check above already rejected conflicts
    const tag = snapshot.tagById.get(resolved.tagId);
    const target = rewriteTargetFor(token, tag, snapshot, indexes, tagLabelChanges);
    const finalValue = target || token.trim();
    if (!seen.has(finalValue)) {
      seen.add(finalValue);
      rewritten.push(finalValue);
    }
    if (target && target !== token.trim()) {
      rewrites.push({ from: token.trim(), to: target });
    }
  }
  if (rewrites.length === 0) return;
  let rewrittenDocument;
  try {
    rewrittenDocument = rewriteMarkdownTags(archive.raw, rewritten);
  } catch (error) {
    plan.conflicts.push({ articleId: article.id, type: 'invalid-markdown', detail: error.message });
    return;
  }
  plan.markdownRewrites.push({
    articleId: article.id,
    path: archive.relativePath,
    rewrites,
    tags: rewritten,
    originalHash: fileSha256(archive.absolute),
    stagedHash: `sha256:${sha256Hex(rewrittenDocument)}`
  });
}

function setsEqual(left, right) {
  if (left.size !== right.size) return false;
  for (const value of left) {
    if (!right.has(value)) return false;
  }
  return true;
}

/**
 * Decide whether a referenced token is rewritten to its resolved tag's stable
 * ID. A rewrite is built only for an actual referenced alias whose tag the
 * operation itself changes: legacy tags being rewired to their reviewed config
 * tag, and config tags whose own localized label changes (the old display
 * label stops matching afterwards, so the file must carry the stable ID to
 * keep the file↔DB equality invariant). Aliases of untouched tags stay as
 * authored; catalog-only updates therefore never touch Markdown.
 */
function rewriteTargetFor(token, tag, snapshot, indexes, tagLabelChanges) {
  const normalized = normalizeToken(token);
  if (normalized === tag.id) return null;
  if (tag.origin === 'legacy') {
    const owner = legacyOwnerFor(tag, snapshot, indexes);
    if (owner) return owner;
    return null;
  }
  if (tagLabelChanges.has(tag.id)) return tag.id;
  return null;
}

/**
 * Produce a deterministic taxonomy synchronization plan.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {object} catalog - validated taxonomy catalog (see `loadTaxonomyCatalog`)
 * @param {object} options - { articlesDir, tempDir, operationsDir }
 * @returns {object} TaxonomySyncPlan
 */
function planTaxonomySync(db, catalog, options = {}) {
  validateTaxonomyCatalog(catalog);
  const articlesDir = path.resolve(options.articlesDir);
  const plan = emptyPlan();
  const snapshot = loadSnapshot(db);
  const indexes = buildCatalogIndexes(catalog);

  if (!snapshot.tagById.has(SYSTEM_TAG_ID)) {
    throw new Error('database is missing the system "other" tag; run the schema v3 migration first');
  }

  diffCategories(plan, catalog, snapshot, indexes);
  diffTags(plan, catalog, snapshot, indexes);
  const tagDriven = computeAffectedArticles(plan, snapshot);

  const tagLabelChanges = new Set(
    plan.updatedTags
      .filter(tag => tag.changes.some(change => change.startsWith('label:')))
      .map(tag => tag.id)
  );

  // File scanning candidates are exactly the affected articles: those whose
  // references the operation itself changes (rewired legacy tags, updated
  // tags, tags under label-changed categories). Articles that need no rewrite
  // are checked for file↔DB equality and otherwise left untouched, so a
  // catalog-only update never touches Markdown.
  const candidateArticleIds = new Set(tagDriven.affectedArticleIds);

  for (const articleId of [...candidateArticleIds].sort((left, right) => left - right)) {
    const article = snapshot.state.articles.find(candidate => candidate.id === articleId);
    const archive = discoverArchive(article, snapshot, articlesDir);
    if (archive.conflict) {
      plan.conflicts.push({ articleId: article.id, type: archive.conflict });
      continue;
    }
    planFileRewrites(plan, article, archive, snapshot, indexes, tagLabelChanges);
  }

  // Articles whose files were rewritten are affected even when no tag row
  // changed; their FTS documents are refreshed along with the taxonomy edits.
  const affectedArticleIds = new Set(tagDriven.affectedArticleIds);
  for (const rewrite of plan.markdownRewrites) affectedArticleIds.add(rewrite.articleId);

  // Sort every output deterministically by stable id/path.
  plan.insertedCategories.sort(byId);
  plan.updatedCategories.sort(byId);
  plan.deletedCategories.sort(byId);
  plan.insertedTags.sort(byId);
  plan.updatedTags.sort(byId);
  plan.deletedTags.sort(byId);
  plan.legacyRewires.sort((left, right) => left.legacyTagId.localeCompare(right.legacyTagId));
  plan.markdownRewrites.sort((left, right) => left.path.localeCompare(right.path));
  plan.unmappedLegacyTags.sort();
  plan.blockedSlugChanges.sort((left, right) => `${left.kind}:${left.id}`.localeCompare(`${right.kind}:${right.id}`));
  plan.blockedDeletions.sort((left, right) => `${left.kind}:${left.id}`.localeCompare(`${right.kind}:${right.id}`));
  plan.conflicts.sort((left, right) => left.articleId - right.articleId || left.type.localeCompare(right.type));
  plan.affectedArticleIds = [...affectedArticleIds].sort((left, right) => left - right);

  return plan;
}

module.exports = {
  LEGACY_ID_PREFIX,
  previewLegacyTagId,
  planTaxonomySync,
  resolveMarkdownTagTokens,
  resolveTokenToTag
};

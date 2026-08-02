#!/usr/bin/env node
'use strict';

/**
 * Dry-run-first localized content/audio migration CLI.
 *
 *   npm run migrate-localized-content -- --dry-run
 *   npm run migrate-localized-content
 *   npm run migrate-localized-content -- --recover <operation-id>
 *
 * Migrates the transitional file layout into the localized runtime layout:
 *
 *   articles/<slug>.md                       -> articles/<locale>/<slug>.md
 *   public/audio/<slug>/<hash>.<ext>          -> public/audio/<locale>/<slug>/<hash>.<ext>
 *   articles.html `/audio/<slug>/...`         -> `/audio/<locale>/<slug>/...`
 *
 * The database is opened with better-sqlite3 directly (never through the
 * auto-migrating `server/db.js`). Dry-run opens read-only, inspects the
 * operation registry without writing anything, and on schema v2 predicts the
 * exact catalog mappings, deterministic legacy tag ids, and filesystem plan
 * that schema v3 apply will use. Apply requires schema v3 and coordinates
 * compensated file moves with one SQLite transaction under the shared
 * `var/operations/active.lock` and the same phase machine as taxonomy sync.
 *
 * Exit codes: 0 success, 1 usage/validation, 2 blocked plan, 3 file errors,
 * 4 lock/manifest errors, 5 stale-state and ambiguous-recovery refusals.
 */

const fs = require('node:fs');
const path = require('node:path');
const Database = require('better-sqlite3');
const {
  JOURNAL_SCHEMA,
  LOCK_DIRNAME,
  OPERATION_ID_PATTERN,
  OPERATION_PHASES,
  OperationError,
  acquireOperationLock,
  cleanupStaleLocks,
  fileSha256,
  fsyncDirectory,
  fsyncFile,
  listOperations,
  nextOperationId,
  readLockOwner,
  readManifest,
  releaseOperationLock,
  removeOperation,
  sha256Hex,
  syncSleep,
  updateManifest,
  validateOperationId,
  writeManifestAtomic
} = require('../server/operations/journal');
const { previewLegacyTagId } = require('../server/taxonomy/store');
const { loadTaxonomyCatalog, SYSTEM_TAG_ID } = require('../server/taxonomy/catalog');
const { SUPPORTED_LOCALES } = require('../server/i18n/config');
const { SAFE_SLUG_PATTERN } = require('../server/utils/path-security');
const {
  classifyAudioUrl,
  parseMarkdownDocument,
  rewriteTransitionalMarkdown,
  scanAudioUrlReferences
} = require('../server/utils/markdown');
const { upsertArticleSearchDocuments } = require('../server/articles/search-index');
const { auditLocalizedContent } = require('./audit-localized-content');

const EXIT_USAGE = 1;
const EXIT_PLAN_BLOCKED = 2;
const EXIT_FILE_ERROR = 3;
const EXIT_LOCK_OR_MANIFEST = 4;
const EXIT_STALE_STATE = 5;

const OPERATION_TYPE = 'content-migrate';
const CONTENT_TOMBSTONE_PATTERN = /^\.content-migrate-[a-z0-9-]+-\d+\.(md|audio)$/i;
const LEGACY_AUDIO_FILE_PATTERN = /^([a-f0-9]{64})\.(mp3|aac|m4a|flac)$/;
const IGNORED_ENTRY_PATTERN = /^\.(?:gitkeep|deleting-|replacing-|taxonomy-sync-|content-migrate-)/;

// ---------------------------------------------------------------------------
// Small shared helpers
// ---------------------------------------------------------------------------

function normalizeToken(value) {
  return String(value).normalize('NFKC').trim();
}

function setsEqual(left, right) {
  if (left.size !== right.size) return false;
  for (const value of left) {
    if (!right.has(value)) return false;
  }
  return true;
}

function parseLegacyTags(value) {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter(tag => typeof tag === 'string') : [];
  } catch {
    return [];
  }
}

function schemaVersion(db) {
  const hasMigrations = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'").get();
  if (!hasMigrations) return 1;
  const row = db.prepare('SELECT MAX(version) AS version FROM schema_migrations').get();
  return row.version || 1;
}

function isIgnoredEntry(name) {
  return IGNORED_ENTRY_PATTERN.test(name);
}

function hooksOf(options) {
  return options.hooks || {};
}

function injectFailure(options, point) {
  if (options.injectFailures && options.injectFailures[point]) {
    throw new Error(`injected failure after ${point}`);
  }
}

function maybePause(options) {
  syncSleep(options.pauseMs);
}

// ---------------------------------------------------------------------------
// Deterministic database hashes for recovery
// ---------------------------------------------------------------------------

/**
 * Hash every row the content migration can touch: the full articles rows
 * (html/content/title/date included), the normalized tag attachments, and the
 * standalone FTS. Recovery compares the current database against the
 * manifest's pre/post hashes.
 */
function contentDbStateHash(db) {
  const state = {
    articles: db.prepare(`
      SELECT id, post_id, locale, title, slug, content, html, status, description, created_at, updated_at
      FROM articles ORDER BY id
    `).all(),
    article_tags: db.prepare('SELECT article_id, tag_id FROM article_tags ORDER BY article_id, tag_id').all(),
    article_fts: db.prepare('SELECT rowid, title, content, taxonomy FROM article_fts ORDER BY rowid').all()
  };
  return `sha256:${sha256Hex(JSON.stringify(state))}`;
}

// ---------------------------------------------------------------------------
// Planning (read-only; shared by schema v2 dry-run and schema v3 apply)
// ---------------------------------------------------------------------------

function emptyPlan() {
  return {
    markdownMoves: [],
    audioMoves: [],
    metadataRewrites: [],
    htmlAudioRewrites: [],
    missingMarkdown: [],
    orphanMarkdown: [],
    tagMappings: [],
    conflicts: [],
    cleanupWarnings: []
  };
}

function planBlocked(plan) {
  return plan.conflicts.length > 0 || plan.missingMarkdown.length > 0 || plan.orphanMarkdown.length > 0;
}

function planIsEmpty(plan) {
  return plan.markdownMoves.length === 0 && plan.audioMoves.length === 0 && plan.metadataRewrites.length === 0;
}

/**
 * Schema v2 resolver: exact catalog display-name/legacyNames mapping first,
 * deterministic legacy allocation for unknown values. Mirrors the schema v3
 * migration's `createTagResolver` (without `acceptTagIds`) and Task 2's
 * read-only `previewLegacyTagId`.
 */
function buildCatalogResolver(catalog) {
  const byNormalized = new Map();
  const addMapping = (value, tagId) => {
    const normalized = normalizeToken(value);
    if (normalized !== '' && !byNormalized.has(normalized)) byNormalized.set(normalized, tagId);
  };
  for (const category of catalog.categories) {
    for (const tag of category.tags || []) {
      if (tag.id !== SYSTEM_TAG_ID) continue;
      for (const locale of Object.keys(tag.labels)) {
        addMapping(tag.labels[locale].name, tag.id);
        addMapping(tag.labels[locale].slug, tag.id);
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
  return {
    resolve(token) {
      const normalized = normalizeToken(token);
      if (normalized === '') return { kind: 'unknown' };
      const mapped = byNormalized.get(normalized);
      if (mapped) return { kind: 'tag', tagId: mapped, origin: 'config' };
      return { kind: 'tag', tagId: previewLegacyTagId(normalized, catalog), origin: 'legacy' };
    }
  };
}

/**
 * Schema v3 resolver against normalized tables: stable tag ids win, then
 * unambiguous display labels, then catalog `legacyNames`. Unknown or ambiguous
 * tokens are reported instead of guessed.
 */
function buildDatabaseResolver(db, catalog) {
  const tagById = new Map(db.prepare('SELECT id, origin FROM tags ORDER BY id').all().map(row => [row.id, row]));
  const labelByName = new Map();
  for (const label of db.prepare('SELECT tag_id, name FROM tag_labels ORDER BY tag_id, locale').all()) {
    const key = normalizeToken(label.name);
    if (!labelByName.has(key)) labelByName.set(key, new Set());
    labelByName.get(key).add(label.tag_id);
  }
  const legacyNameToTags = new Map();
  for (const category of catalog.categories) {
    for (const tag of category.tags || []) {
      for (const legacyName of tag.legacyNames || []) {
        const key = normalizeToken(legacyName);
        if (key === '') continue;
        if (!legacyNameToTags.has(key)) legacyNameToTags.set(key, new Set());
        legacyNameToTags.get(key).add(tag.id);
      }
    }
  }
  return {
    resolve(token) {
      const normalized = normalizeToken(token);
      if (normalized === '') return { kind: 'unknown' };
      const byId = tagById.get(normalized);
      if (byId) return { kind: 'tag', tagId: byId.id, origin: byId.origin };
      const byLabel = labelByName.get(normalized);
      if (byLabel) {
        if (byLabel.size === 1) {
          const tagId = [...byLabel][0];
          return { kind: 'tag', tagId, origin: tagById.get(tagId).origin };
        }
        return { kind: 'ambiguous', candidates: [...byLabel].sort() };
      }
      const byLegacy = legacyNameToTags.get(normalized);
      if (byLegacy) {
        if (byLegacy.size === 1) {
          const tagId = [...byLegacy][0];
          return { kind: 'tag', tagId, origin: tagById.get(tagId).origin };
        }
        return { kind: 'ambiguous', candidates: [...byLegacy].sort() };
      }
      return { kind: 'unknown' };
    }
  };
}

function loadNormalizedArticles(db) {
  const rows = db.prepare(`
    SELECT a.id, a.post_id, a.locale, a.slug, a.title, a.content, a.html, a.created_at
    FROM articles a ORDER BY a.id
  `).all();
  const posts = new Map(db.prepare('SELECT id, translation_key FROM posts ORDER BY id').all().map(row => [row.id, row.translation_key]));
  const tagsByArticle = new Map();
  for (const row of db.prepare('SELECT article_id, tag_id FROM article_tags ORDER BY article_id, tag_id').all()) {
    if (!tagsByArticle.has(row.article_id)) tagsByArticle.set(row.article_id, []);
    tagsByArticle.get(row.article_id).push(row.tag_id);
  }
  return rows.map(row => ({
    id: row.id,
    locale: row.locale,
    slug: row.slug,
    title: row.title,
    content: row.content,
    html: row.html,
    created_at: row.created_at,
    translationKey: posts.get(row.post_id) || null,
    expectedTags: new Set(tagsByArticle.get(row.id) || [])
  }));
}

function loadLegacyArticles(db, resolver) {
  const rows = db.prepare(`
    SELECT id, title, slug, content, html, tags, created_at
    FROM articles ORDER BY id
  `).all();
  return rows.map(row => {
    const expectedTags = new Set();
    for (const value of parseLegacyTags(row.tags).map(value => value.trim()).filter(Boolean)) {
      const resolved = resolver.resolve(value);
      if (resolved.kind === 'tag') expectedTags.add(resolved.tagId);
    }
    if (expectedTags.size === 0) expectedTags.add(SYSTEM_TAG_ID);
    return {
      id: row.id,
      locale: 'zh',
      slug: row.slug,
      title: row.title,
      content: row.content,
      html: row.html,
      created_at: row.created_at,
      translationKey: row.slug,
      expectedTags
    };
  });
}

/**
 * Validate one article archive against the database and produce the resolved
 * tag mappings. Pushes a blocking conflict and returns null on any mismatch.
 */
function evaluateArchive(plan, article, archive, resolver) {
  let parsed;
  try {
    parsed = parseMarkdownDocument(archive.raw);
  } catch (error) {
    plan.conflicts.push({ articleId: article.id, type: 'invalid-markdown', detail: error.message });
    return null;
  }
  const data = parsed.data;
  if (data.slug !== article.slug) {
    plan.conflicts.push({ articleId: article.id, type: 'slug-mismatch', fileSlug: data.slug });
    return null;
  }
  if (
    data.locale !== article.locale
    || data.translationKey !== article.translationKey
    || data.title !== article.title
    || data.date !== article.created_at
  ) {
    plan.conflicts.push({
      articleId: article.id,
      type: 'metadata-mismatch',
      fileSlug: data.slug,
      fileLocale: data.locale,
      fileTranslationKey: data.translationKey,
      fileTitle: data.title,
      fileDate: data.date,
      expectedTitle: article.title,
      expectedDate: article.created_at
    });
    return null;
  }
  const tokens = Array.isArray(data.tags) ? data.tags : [];
  const mappings = [];
  const tagIds = [];
  for (const token of tokens) {
    const resolved = resolver.resolve(token);
    if (resolved.kind === 'tag') {
      mappings.push({ value: token, tagId: resolved.tagId, kind: resolved.origin === 'config' ? 'catalog' : 'legacy' });
      tagIds.push(resolved.tagId);
    } else if (resolved.kind === 'ambiguous') {
      plan.conflicts.push({ articleId: article.id, type: 'ambiguous-token', token, candidates: resolved.candidates });
      return null;
    } else {
      plan.conflicts.push({ articleId: article.id, type: 'unknown-token', token });
      return null;
    }
  }
  const resolvedSet = new Set(tagIds);
  if (resolvedSet.size === 0) resolvedSet.add(SYSTEM_TAG_ID);
  const dbSet = new Set(article.expectedTags);
  if (!setsEqual(resolvedSet, dbSet)) {
    plan.conflicts.push({
      articleId: article.id,
      type: 'db-file-tag-mismatch',
      fileTags: [...resolvedSet].sort(),
      dbTags: [...dbSet].sort()
    });
    return null;
  }
  return { parsed, mappings, tagIds: [...resolvedSet] };
}

/**
 * Collect exact same-article legacy audio URL rewrites from `text`, pushing
 * foreign-slug, missing-file, and malformed references as conflicts. Returns
 * unique `{ from, to, file }` rewrites plus a per-URL occurrence count.
 */
function collectUrlRewrites(article, text, plan, audioFileByArticle) {
  const rewrites = [];
  const occurrences = new Map();
  const seenFiles = new Set();
  const files = audioFileByArticle.get(article.id);
  for (const reference of scanAudioUrlReferences(text)) {
    const classified = classifyAudioUrl(reference.path);
    if (classified.kind === 'published') continue;
    if (classified.kind === 'legacy') {
      if (classified.slug !== article.slug) {
        plan.conflicts.push({ articleId: article.id, type: 'foreign-slug-audio-url', url: reference.path });
        continue;
      }
      if (!files || !files.has(classified.file)) {
        plan.conflicts.push({ articleId: article.id, type: 'referenced-audio-missing', url: reference.path });
        continue;
      }
      occurrences.set(reference.path, (occurrences.get(reference.path) || 0) + 1);
      if (seenFiles.has(classified.file)) continue;
      seenFiles.add(classified.file);
      rewrites.push({ from: reference.path, to: `/audio/${article.locale}/${article.slug}/${classified.file}`, file: classified.file });
      continue;
    }
    if (classified.slug === article.slug) {
      plan.conflicts.push({ articleId: article.id, type: 'malformed-audio-url', url: reference.path });
    }
  }
  return { rewrites, occurrences };
}

/**
 * Exact string replacement for validated URL mappings. Each `from` is a full
 * exact URL, so unrelated text and URLs are never touched.
 */
function applyUrlRewrites(text, urlRewrites) {
  let result = text;
  for (const rewrite of urlRewrites) {
    result = result.split(rewrite.from).join(rewrite.to);
  }
  return result;
}

function stagedMarkdownDocument(raw, move) {
  let document = rewriteTransitionalMarkdown(raw, {
    locale: move.locale,
    translationKey: move.translationKey,
    tagIds: move.tags
  });
  if (move.urlRewrites.length > 0) {
    document = applyUrlRewrites(document, move.urlRewrites.map(rewrite => ({ from: rewrite.from, to: rewrite.to })));
  }
  return document;
}

/**
 * Deterministic read-only migration plan for schema v2 or schema v3.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {object} options - { articlesDir, audioDir, tempDir, operationsDir,
 *   rootDir, taxonomyPath }
 * @returns {object} the localized content migration plan
 */
function planLocalizedContentMigration(db, options = {}) {
  const articlesDir = path.resolve(options.articlesDir);
  const audioDir = path.resolve(options.audioDir);
  const catalog = loadTaxonomyCatalog(options.taxonomyPath);
  const plan = emptyPlan();

  const articles = schemaVersion(db) >= 3
    ? loadNormalizedArticles(db)
    : loadLegacyArticles(db, buildCatalogResolver(catalog));
  const resolver = schemaVersion(db) >= 3 ? buildDatabaseResolver(db, catalog) : buildCatalogResolver(catalog);

  // Audio discovery: legacy dirs per article and unreferenced legacy dirs.
  const audioFileByArticle = new Map();
  const knownAudioSlugs = new Set();
  for (const article of articles) {
    if (!SAFE_SLUG_PATTERN.test(article.slug)) {
      plan.conflicts.push({ articleId: article.id, type: 'unsafe-path', slug: article.slug });
      continue;
    }
    const directory = path.join(audioDir, article.slug);
    if (!fs.existsSync(directory) || !fs.statSync(directory).isDirectory()) continue;
    knownAudioSlugs.add(article.slug);
    const files = new Set();
    for (const name of fs.readdirSync(directory)) {
      if (isIgnoredEntry(name)) continue;
      const match = LEGACY_AUDIO_FILE_PATTERN.exec(name);
      if (!match) {
        plan.conflicts.push({ articleId: article.id, type: 'malformed-audio-file', slug: article.slug, file: name });
        continue;
      }
      files.add(`${match[1]}.${match[2]}`);
    }
    audioFileByArticle.set(article.id, files);
  }
  if (fs.existsSync(audioDir)) {
    for (const name of fs.readdirSync(audioDir, { withFileTypes: true })) {
      if (!name.isDirectory()) continue;
      if (isIgnoredEntry(name.name)) continue;
      if (SUPPORTED_LOCALES.includes(name.name)) continue;
      if (!knownAudioSlugs.has(name.name)) {
        plan.conflicts.push({ type: 'unreferenced-audio-directory', slug: name.name });
      }
    }
  }

  // Legacy root markdown orphans (dotfiles and locale dirs are never legacy).
  if (fs.existsSync(articlesDir)) {
    for (const name of fs.readdirSync(articlesDir)) {
      if (isIgnoredEntry(name)) continue;
      if (SUPPORTED_LOCALES.includes(name)) continue;
      if (!name.endsWith('.md')) continue;
      const slug = name.slice(0, -3);
      if (!articles.some(article => article.slug === slug)) {
        plan.orphanMarkdown.push(name);
      }
    }
  }

  for (const article of articles) {
    if (!SAFE_SLUG_PATTERN.test(article.slug)) continue;
    const localizedPath = path.join(articlesDir, article.locale, `${article.slug}.md`);
    const transitionalPath = path.join(articlesDir, `${article.slug}.md`);
    const localized = fs.existsSync(localizedPath);
    const transitional = fs.existsSync(transitionalPath);
    if (localized && transitional) {
      plan.conflicts.push({ articleId: article.id, type: 'both-layouts-present', layouts: ['localized', 'transitional'] });
      continue;
    }
    if (!localized && !transitional) {
      plan.missingMarkdown.push({ articleId: article.id, slug: article.slug });
      continue;
    }
    const archive = transitional
      ? { absolute: transitionalPath, relativePath: `${article.slug}.md`, kind: 'transitional' }
      : { absolute: localizedPath, relativePath: path.join(article.locale, `${article.slug}.md`), kind: 'localized' };
    try {
      archive.raw = fs.readFileSync(archive.absolute, 'utf8');
    } catch (error) {
      plan.conflicts.push({ articleId: article.id, type: 'unreadable-markdown', slug: article.slug, message: error.message });
      continue;
    }
    const evaluated = evaluateArchive(plan, article, archive, resolver);
    if (!evaluated) continue;

    if (archive.kind === 'transitional') {
      const bodyUrlRewrites = collectUrlRewrites(article, archive.raw, plan, audioFileByArticle).rewrites;
      const move = {
        articleId: article.id,
        slug: article.slug,
        locale: article.locale,
        from: archive.relativePath,
        to: path.join(article.locale, `${article.slug}.md`),
        originalHash: fileSha256(archive.absolute),
        stagedHash: null,
        tags: evaluated.tagIds,
        translationKey: article.translationKey,
        rewrites: evaluated.mappings.filter(mapping => mapping.value !== mapping.tagId).map(mapping => ({ from: mapping.value, to: mapping.tagId })),
        urlRewrites: bodyUrlRewrites
      };
      move.stagedHash = `sha256:${sha256Hex(stagedMarkdownDocument(archive.raw, move))}`;
      plan.markdownMoves.push(move);
      plan.tagMappings.push({ articleId: article.id, slug: article.slug, mappings: evaluated.mappings });
    }
  }

  // Audio moves (all articles with legacy audio, including already-localized
  // markdown layouts so stray legacy audio is cleaned).
  for (const article of articles) {
    if (!SAFE_SLUG_PATTERN.test(article.slug)) continue;
    const files = audioFileByArticle.get(article.id);
    if (!files) continue;
    for (const fileKey of [...files].sort()) {
      const hash = fileKey.slice(0, 64);
      const extension = fileKey.slice(65);
      const fromPath = path.join(article.slug, fileKey);
      const toPath = path.join(article.locale, article.slug, fileKey);
      const destination = path.join(audioDir, toPath);
      let destinationExists = false;
      if (fs.existsSync(destination)) {
        const sourceHash = fileSha256(path.join(audioDir, fromPath));
        if (fileSha256(destination) !== sourceHash) {
          plan.conflicts.push({ articleId: article.id, type: 'destination-conflict', file: fileKey });
          continue;
        }
        destinationExists = true;
      }
      plan.audioMoves.push({
        articleId: article.id,
        slug: article.slug,
        locale: article.locale,
        from: fromPath,
        to: toPath,
        hash,
        extension,
        originalHash: fileSha256(path.join(audioDir, fromPath)),
        destinationExists
      });
    }
  }

  // HTML and content URL rewrites (every article, regardless of layout).
  for (const article of articles) {
    if (!SAFE_SLUG_PATTERN.test(article.slug)) continue;
    const htmlResult = collectUrlRewrites(article, article.html, plan, audioFileByArticle);
    const contentResult = collectUrlRewrites(article, article.content, plan, audioFileByArticle);
    for (const [from, occurrences] of htmlResult.occurrences) {
      const rewrite = htmlResult.rewrites.find(entry => entry.from === from);
      plan.htmlAudioRewrites.push({
        articleId: article.id,
        slug: article.slug,
        locale: article.locale,
        from,
        to: rewrite.to,
        occurrences
      });
    }
    if (htmlResult.rewrites.length === 0 && contentResult.rewrites.length === 0) continue;
    const newHtml = htmlResult.rewrites.length > 0
      ? applyUrlRewrites(article.html, htmlResult.rewrites)
      : article.html;
    let contentHash = null;
    let newContent = null;
    if (contentResult.rewrites.length > 0) {
      contentHash = sha256Hex(article.content);
      newContent = applyUrlRewrites(article.content, contentResult.rewrites);
    }
    plan.metadataRewrites.push({
      articleId: article.id,
      slug: article.slug,
      htmlHash: sha256Hex(article.html),
      newHtml,
      contentHash,
      newContent,
      rewrites: [...htmlResult.rewrites, ...contentResult.rewrites].map(rewrite => ({ from: rewrite.from, to: rewrite.to }))
    });
  }

  plan.markdownMoves.sort((left, right) => left.articleId - right.articleId || left.from.localeCompare(right.from));
  plan.audioMoves.sort((left, right) => left.articleId - right.articleId || left.from.localeCompare(right.from));
  plan.metadataRewrites.sort((left, right) => left.articleId - right.articleId);
  plan.htmlAudioRewrites.sort((left, right) => left.articleId - right.articleId || left.from.localeCompare(right.from));
  plan.tagMappings.sort((left, right) => left.articleId - right.articleId);
  plan.missingMarkdown.sort((left, right) => left.articleId - right.articleId);
  plan.orphanMarkdown.sort();
  plan.conflicts.sort((left, right) => (left.articleId || 0) - (right.articleId || 0) || String(left.type).localeCompare(String(right.type)));
  plan.cleanupWarnings.sort();

  return plan;
}

// ---------------------------------------------------------------------------
// Compensated apply
// ---------------------------------------------------------------------------

function operationDirectory(operationsDir, operationId) {
  return path.join(operationsDir, validateOperationId(operationId));
}

function manifestFilePath(operationsDir, operationId) {
  return path.join(operationDirectory(operationsDir, operationId), 'operation.json');
}

function fileWithin(root, relativePath) {
  if (typeof relativePath !== 'string' || relativePath.length === 0) {
    throw new OperationError('invalid_manifest', `invalid file path: ${JSON.stringify(relativePath)}`);
  }
  if (typeof root !== 'string' || root === '') {
    throw new OperationError('invalid_manifest', 'manifest is missing a required root directory');
  }
  const resolvedRoot = path.resolve(root);
  const resolvedPath = path.resolve(resolvedRoot, relativePath);
  if (resolvedPath !== resolvedRoot && !resolvedPath.startsWith(`${resolvedRoot}${path.sep}`)) {
    throw new OperationError('invalid_manifest', `path escapes its root: ${relativePath}`);
  }
  return resolvedPath;
}

function validateTombstoneName(name) {
  if (typeof name !== 'string' || !CONTENT_TOMBSTONE_PATTERN.test(name)) {
    throw new OperationError('invalid_manifest', `unsafe tombstone name: ${JSON.stringify(name)}`);
  }
  return name;
}

function rootForFile(manifest, file) {
  return file.kind === 'markdown' ? manifest.articlesDir : manifest.audioDir;
}

function sourcePath(manifest, file) {
  return fileWithin(rootForFile(manifest, file), file.path);
}

function destinationPath(manifest, file) {
  return fileWithin(rootForFile(manifest, file), file.destination);
}

function tombstonePath(manifest, file) {
  return path.join(rootForFile(manifest, file), validateTombstoneName(file.tombstone));
}

function resolveDbPath(db, rootDir) {
  const name = db.name || 'blog.db';
  return path.resolve(path.isAbsolute(name) ? name : path.join(rootDir, name));
}

function createContentManifest(db, operationsDir, operationId, config) {
  const directory = operationDirectory(operationsDir, operationId);
  fs.mkdirSync(directory, { recursive: true });
  const manifest = {
    schema: JOURNAL_SCHEMA,
    operationId,
    type: OPERATION_TYPE,
    owner: { type: OPERATION_TYPE, operationId },
    phase: 'lock-acquired',
    createdAt: new Date().toISOString(),
    rootDir: path.resolve(config.rootDir),
    dbPath: resolveDbPath(db, path.resolve(config.rootDir)),
    articlesDir: path.resolve(config.articlesDir),
    audioDir: path.resolve(config.audioDir),
    tempDir: path.resolve(config.tempDir),
    operationsDir,
    stagingRoot: path.join(path.resolve(config.tempDir), `localized-content-${operationId}`),
    plan: null,
    preDbHash: null,
    postDbHash: null,
    files: [],
    cleanupWarnings: [],
    completedAt: null
  };
  writeManifestAtomic(manifestFilePath(operationsDir, operationId), manifest);
  return manifest;
}

function removeStaging(manifest) {
  if (!manifest.stagingRoot) return;
  fs.rmSync(manifest.stagingRoot, { recursive: true, force: true });
}

function removeJournal(operationsDir, operationId) {
  removeOperation(operationsDir, operationId);
  releaseOperationLock(operationsDir);
}

function finalizeRecovery(operationsDir, operationId) {
  removeJournal(operationsDir, operationId);
  cleanupStaleLocks(operationsDir);
}

function restoreSource(manifest, file) {
  const source = sourcePath(manifest, file);
  const tombstone = tombstonePath(manifest, file);
  const tombstoneHash = fileSha256(tombstone);
  if (tombstoneHash !== file.originalHash) {
    throw new OperationError('file_hash_mismatch', `tombstone hash mismatch for ${file.path}`);
  }
  fs.renameSync(tombstone, source);
  fsyncDirectory(path.dirname(source));
}

/**
 * Compensation for a file whose durable `tombstoned` flag was never persisted.
 * An existing source is external state and is left exactly as the writer left
 * it; a missing source with a hash-valid tombstone is a crash between the
 * rename and the flag and is restored.
 */
function restoreMissingSource(manifest, file) {
  const source = sourcePath(manifest, file);
  if (fs.existsSync(source)) return;
  const tombstone = tombstonePath(manifest, file);
  let tombstoneHash;
  try {
    tombstoneHash = fileSha256(tombstone);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    throw new OperationError('file_hash_mismatch', `source and tombstone are both missing for ${file.path}`);
  }
  if (tombstoneHash !== file.originalHash) {
    throw new OperationError('file_hash_mismatch', `tombstone hash mismatch for ${file.path}`);
  }
  fs.renameSync(tombstone, source);
  fsyncDirectory(path.dirname(source));
}

function verifyOrRestoreSource(manifest, file) {
  const source = sourcePath(manifest, file);
  let sourceHash = null;
  try {
    sourceHash = fileSha256(source);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  if (sourceHash === file.originalHash) return;
  if (sourceHash !== null) {
    throw new OperationError('recovery_ambiguous', `source file mismatch for ${file.path}`);
  }
  let tombstoneHash;
  try {
    tombstoneHash = fileSha256(tombstonePath(manifest, file));
  } catch {
    throw new OperationError('recovery_ambiguous', `source and tombstone are both missing for ${file.path}`);
  }
  if (tombstoneHash !== file.originalHash) {
    throw new OperationError('recovery_ambiguous', `tombstone hash mismatch for ${file.path}`);
  }
  fs.renameSync(tombstonePath(manifest, file), source);
  fsyncDirectory(path.dirname(source));
}

/**
 * Undo one file: remove the promoted destination when present and hash-verified
 * (a destination with a different hash is external state: during rollback it is
 * preserved, during recovery it is an ambiguous refusal), then restore the
 * source from its verified tombstone.
 */
function restoreFile(manifest, file, { ambiguous = false } = {}) {
  const destination = destinationPath(manifest, file);
  if (fs.existsSync(destination)) {
    const destinationHash = fileSha256(destination);
    if (destinationHash === file.stagedHash) {
      fs.rmSync(destination, { force: true });
      fsyncDirectory(path.dirname(destination));
    } else if (ambiguous) {
      throw new OperationError('recovery_ambiguous', `promoted file mismatch for ${file.path}`);
    }
    // An unverified destination is external state and is never clobbered.
  }
  if (file.tombstoned) {
    restoreSource(manifest, file);
  } else if (ambiguous) {
    verifyOrRestoreSource(manifest, file);
  } else {
    restoreMissingSource(manifest, file);
  }
}

function restoreFiles(manifest) {
  const failures = [];
  for (const file of [...manifest.files].reverse()) {
    try {
      restoreFile(manifest, file);
    } catch (error) {
      failures.push({ path: file.path, error: error.message });
    }
  }
  removeStaging(manifest);
  if (failures.length > 0) {
    throw new OperationError(
      'rollback_failed',
      `compensation could not restore every file: ${failures.map(item => item.path).join(', ')}`
    );
  }
}

function restorePreState(manifest) {
  for (const file of [...manifest.files].reverse()) {
    restoreFile(manifest, file, { ambiguous: true });
  }
}

function applyContentTransactionBody(db, plan, preDbHash, options) {
  const hooks = hooksOf(options);
  if (contentDbStateHash(db) !== preDbHash) {
    throw new OperationError('stale_state', 'database changed between planning and the apply transaction');
  }
  const affectedFts = new Set();
  for (const rewrite of plan.metadataRewrites) {
    const row = db.prepare('SELECT content, html FROM articles WHERE id = ?').get(rewrite.articleId);
    if (!row) {
      throw new OperationError('stale_state', `article ${rewrite.articleId} no longer exists`);
    }
    if (sha256Hex(row.html) !== rewrite.htmlHash) {
      throw new OperationError('stale_state', `articles.html changed since planning for article ${rewrite.articleId}`);
    }
    if (rewrite.contentHash !== null) {
      if (sha256Hex(row.content) !== rewrite.contentHash) {
        throw new OperationError('stale_state', `articles.content changed since planning for article ${rewrite.articleId}`);
      }
      db.prepare('UPDATE articles SET content = ?, html = ? WHERE id = ?')
        .run(rewrite.newContent, rewrite.newHtml, rewrite.articleId);
      affectedFts.add(rewrite.articleId);
    } else {
      db.prepare('UPDATE articles SET html = ? WHERE id = ?').run(rewrite.newHtml, rewrite.articleId);
    }
  }
  hooks.afterDbUpdates?.();
  injectFailure(options, 'db');
  if (affectedFts.size > 0) {
    upsertArticleSearchDocuments(db, [...affectedFts].sort((left, right) => left - right));
  }
  hooks.afterFts?.();
  injectFailure(options, 'fts');
}

function commitDatabaseTransaction(db, plan, preDbHash, options) {
  return db.transaction(() => {
    applyContentTransactionBody(db, plan, preDbHash, options);
  })();
}

function predictPostDbHash(db, plan, preDbHash, stagingRoot) {
  const simulatePath = path.join(stagingRoot, 'simulate.db');
  db.exec(`VACUUM INTO '${simulatePath.replaceAll("'", "''")}'`);
  const clone = new Database(simulatePath);
  try {
    clone.pragma('foreign_keys = ON');
    commitDatabaseTransaction(clone, plan, preDbHash, {});
    return { postDbHash: contentDbStateHash(clone) };
  } finally {
    clone.close();
  }
}

/**
 * Apply a validated content migration plan with compensation and journaling.
 *
 * @param {import('better-sqlite3').Database} db - schema v3 database
 * @param {object} options - { articlesDir, audioDir, tempDir, operationsDir,
 *   rootDir, taxonomyPath, operationId, pauseMs, hooks, injectFailures }
 * @param {object} [runtime] - merged into options (test convenience)
 * @returns {object} the applied plan
 */
function applyLocalizedContentMigration(db, options = {}, runtime = {}) {
  options = { ...options, ...runtime };
  const operationsDir = path.resolve(options.operationsDir);
  const articlesDir = path.resolve(options.articlesDir);
  const audioDir = path.resolve(options.audioDir);
  const tempDir = path.resolve(options.tempDir);
  const rootDir = path.resolve(options.rootDir || process.cwd());
  const operationId = options.operationId || nextOperationId();
  validateOperationId(operationId);

  acquireOperationLock(operationsDir, { type: OPERATION_TYPE, operationId });
  let manifest = null;
  let dbCommitted = false;
  const hooks = hooksOf(options);
  try {
    const incomplete = listOperations(operationsDir);
    if (incomplete.length > 0) {
      throw new OperationError(
        'operation_incomplete',
        `incomplete operation manifests exist (${incomplete.join(', ')}); run --recover first`
      );
    }
    if (schemaVersion(db) < 3) {
      throw new OperationError('schema_migration_required', 'schema version below 3; run the schema v3 migration first');
    }

    const plan = planLocalizedContentMigration(db, options);
    if (planBlocked(plan)) {
      throw new OperationError('plan_blocked', 'content migration plan is blocked and cannot be applied', { plan });
    }
    if (planIsEmpty(plan)) {
      releaseOperationLock(operationsDir);
      return plan;
    }

    const stagingRoot = path.join(tempDir, `localized-content-${operationId}`);
    manifest = createContentManifest(db, operationsDir, operationId, options);
    maybePause(options);
    hooks.afterLockAcquired?.();

    const preDbHash = contentDbStateHash(db);
    const stagedFilesRoot = path.join(stagingRoot, 'files');
    fs.mkdirSync(stagedFilesRoot, { recursive: true });

    const files = [];
    for (const [index, move] of plan.markdownMoves.entries()) {
      const source = fileWithin(articlesDir, move.from);
      const currentHash = fileSha256(source);
      if (currentHash !== move.originalHash) {
        throw new OperationError('file_hash_mismatch', `source file changed since planning: ${move.from}`);
      }
      const stagedPath = path.join(stagedFilesRoot, `${index}.md`);
      const document = stagedMarkdownDocument(fs.readFileSync(source, 'utf8'), move);
      fs.writeFileSync(stagedPath, document, { flag: 'wx' });
      fsyncFile(stagedPath);
      if (fileSha256(stagedPath) !== move.stagedHash) {
        throw new OperationError('file_hash_mismatch', `staged rewrite diverged from plan: ${move.from}`);
      }
      files.push({
        kind: 'markdown',
        path: move.from,
        destination: move.to,
        originalHash: move.originalHash,
        stagedHash: move.stagedHash,
        stagedPath: path.relative(rootDir, stagedPath),
        tombstone: `.content-migrate-${operationId}-${index}.md`,
        tombstoned: false,
        promoted: false
      });
    }
    for (const [index, move] of plan.audioMoves.entries()) {
      const source = fileWithin(audioDir, move.from);
      const currentHash = fileSha256(source);
      if (currentHash !== move.originalHash) {
        throw new OperationError('file_hash_mismatch', `source audio changed since planning: ${move.from}`);
      }
      files.push({
        kind: 'audio',
        path: move.from,
        destination: move.to,
        originalHash: move.originalHash,
        stagedHash: move.originalHash,
        stagedPath: null,
        tombstone: `.content-migrate-${operationId}-${plan.markdownMoves.length + index}.audio`,
        tombstoned: false,
        promoted: false,
        destinationExists: Boolean(move.destinationExists)
      });
    }
    hooks.afterStage?.();
    injectFailure(options, 'stage');

    const { postDbHash } = predictPostDbHash(db, plan, preDbHash, stagingRoot);

    manifest = updateManifest(operationsDir, operationId, {
      phase: 'prepared',
      plan,
      preDbHash,
      postDbHash,
      files
    });
    maybePause(options);

    // Tombstone every source; the hash is verified immediately before each
    // rename and the parent directory fsynced before the durable flag.
    for (const file of files) {
      const source = sourcePath(manifest, file);
      hooks.beforeTombstone?.(file);
      const currentHash = fileSha256(source);
      if (currentHash !== file.originalHash) {
        throw new OperationError('file_hash_mismatch', `source file changed before tombstone: ${file.path}`);
      }
      fs.renameSync(source, tombstonePath(manifest, file));
      fsyncDirectory(path.dirname(source));
      hooks.afterTombstoneRename?.(file);
      injectFailure(options, 'tombstone-rename');
      maybePause(options);
      file.tombstoned = true;
      manifest = updateManifest(operationsDir, operationId, { files });
      hooks.afterTombstone?.(file);
      injectFailure(options, file.kind === 'markdown' ? 'markdown-tombstone' : 'audio-tombstone');
      injectFailure(options, 'tombstone');
      maybePause(options);
    }

    // Promote every destination; verify the payload before the durable flag.
    for (const file of files) {
      const destination = destinationPath(manifest, file);
      hooks.beforePromote?.(file);
      if (fs.existsSync(destination)) {
        if (file.kind === 'audio' && file.destinationExists) {
          if (fileSha256(destination) !== file.stagedHash) {
            throw new OperationError('file_hash_mismatch', `existing destination hash mismatch: ${file.path}`);
          }
        } else {
          throw new OperationError('destination_collision', `destination already exists: ${file.destination}`);
        }
      } else {
        fs.mkdirSync(path.dirname(destination), { recursive: true });
        if (file.kind === 'markdown') {
          fs.renameSync(fileWithin(manifest.rootDir, file.stagedPath), destination);
        } else {
          fs.linkSync(tombstonePath(manifest, file), destination);
        }
      }
      fsyncDirectory(path.dirname(destination));
      if (fileSha256(destination) !== file.stagedHash) {
        throw new OperationError('file_hash_mismatch', `promoted file hash mismatch: ${file.path}`);
      }
      file.promoted = true;
      manifest = updateManifest(operationsDir, operationId, { files });
      hooks.afterPromote?.(file);
      injectFailure(options, file.kind === 'markdown' ? 'markdown-promote' : 'audio-promote');
      injectFailure(options, 'promote');
      maybePause(options);
    }

    manifest = updateManifest(operationsDir, operationId, { phase: 'files-promoted' });
    maybePause(options);

    hooks.beforeDbTransaction?.();
    commitDatabaseTransaction(db, plan, preDbHash, options);
    const actualPostDbHash = contentDbStateHash(db);
    dbCommitted = true;

    manifest = updateManifest(operationsDir, operationId, {
      phase: 'db-committed',
      postDbHash: actualPostDbHash
    });
    maybePause(options);

    // Post-commit verification audit before any cleanup.
    const audit = auditLocalizedContent(db, { ...options, checkOperations: false });
    if (!audit.passed) {
      throw new OperationError('audit_failed', `post-commit audit failed: ${audit.errors.map(error => error.message).join('; ')}`);
    }
    hooks.afterAudit?.();
    injectFailure(options, 'audit');

    // Cleanup: tombstones, then empty legacy audio dirs, then staging.
    for (const file of files) {
      if (!file.tombstoned) continue;
      fs.rmSync(tombstonePath(manifest, file), { force: true });
    }
    for (const audioDirName of new Set(
      files.filter(file => file.kind === 'audio').map(file => path.posix.dirname(file.path))
    )) {
      const legacyDir = fileWithin(audioDir, audioDirName);
      if (!fs.existsSync(legacyDir)) continue;
      try {
        fs.rmdirSync(legacyDir);
      } catch (error) {
        if (error.code === 'ENOTEMPTY') {
          plan.cleanupWarnings.push({ type: 'legacy-audio-directory-not-empty', path: audioDirName });
        } else if (error.code !== 'ENOENT') {
          plan.cleanupWarnings.push({ type: 'legacy-audio-directory-cleanup-failed', path: audioDirName, message: error.message });
        }
      }
    }
    try {
      removeStaging(manifest);
    } catch (error) {
      plan.cleanupWarnings.push({ type: 'staging-cleanup-failed', message: error.message });
    }
    hooks.afterCleanup?.();

    if (plan.cleanupWarnings.length > 0) {
      throw new OperationError('cleanup_warnings', 'cleanup left recoverable residue; run --recover to finalize', { plan });
    }
    updateManifest(operationsDir, operationId, { phase: 'cleanup-complete', completedAt: new Date().toISOString() });
    removeJournal(operationsDir, operationId);
    return plan;
  } catch (error) {
    if (dbCommitted) {
      // The transaction committed; the journal stays as a recoverable
      // `db-committed` operation directory with lock evidence.
      throw new OperationError('cleanup_failed', `apply committed but post-commit verification/cleanup failed: ${error.message}`, { cause: error });
    }
    if (manifest) {
      try {
        restoreFiles(manifest);
      } catch (restoreError) {
        throw restoreError instanceof OperationError
          ? restoreError
          : new OperationError('rollback_failed', `compensation failed: ${restoreError.message}`, { cause: restoreError });
      }
      removeJournal(operationsDir, operationId);
    } else {
      releaseOperationLock(operationsDir);
    }
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Recovery
// ---------------------------------------------------------------------------

function validateManifest(manifest) {
  validateOperationId(manifest.operationId);
  if (manifest.type !== OPERATION_TYPE) {
    throw new OperationError('invalid_manifest', `manifest type mismatch: ${JSON.stringify(manifest.type)}`);
  }
  if (!OPERATION_PHASES.includes(manifest.phase)) {
    throw new OperationError('invalid_manifest', `invalid operation phase: ${JSON.stringify(manifest.phase)}`);
  }
  if (typeof manifest.dbPath !== 'string' || manifest.dbPath === '') {
    throw new OperationError('invalid_manifest', 'manifest has no recorded database path');
  }
  if (manifest.phase === 'lock-acquired') {
    if (!Array.isArray(manifest.files) || manifest.files.length > 0) {
      throw new OperationError('invalid_manifest', 'lock-acquired manifest must not describe live file changes');
    }
    return;
  }
  if (!manifest.articlesDir || !manifest.audioDir || !manifest.stagingRoot) {
    throw new OperationError('invalid_manifest', 'manifest is missing file locations');
  }
  for (const file of manifest.files || []) {
    if (!['markdown', 'audio'].includes(file.kind)) {
      throw new OperationError('invalid_manifest', `invalid file kind: ${JSON.stringify(file.kind)}`);
    }
    sourcePath(manifest, file);
    destinationPath(manifest, file);
    validateTombstoneName(file.tombstone);
    if (file.kind === 'markdown') fileWithin(manifest.rootDir, file.stagedPath);
    if (typeof file.originalHash !== 'string' || typeof file.stagedHash !== 'string') {
      throw new OperationError('invalid_manifest', `invalid hashes for ${file.path}`);
    }
  }
  if (!manifest.plan || typeof manifest.plan !== 'object') {
    throw new OperationError('invalid_manifest', 'manifest has no recorded plan');
  }
  if (typeof manifest.preDbHash !== 'string' || typeof manifest.postDbHash !== 'string') {
    throw new OperationError('invalid_manifest', 'manifest has no recorded pre/post database hashes');
  }
}

function finalizeCommittedOperation(manifest, operationsDir, operationId, options) {
  for (const file of manifest.files || []) {
    const destination = destinationPath(manifest, file);
    if (!file.promoted) {
      throw new OperationError('recovery_ambiguous', `database is post-state but ${file.path} was never promoted`);
    }
    if (fileSha256(destination) !== file.stagedHash) {
      throw new OperationError('recovery_ambiguous', `promoted file hash mismatch for ${file.path}`);
    }
    if (file.tombstoned) {
      fs.rmSync(tombstonePath(manifest, file), { force: true });
    }
  }
  for (const audioDirName of new Set(
    (manifest.files || []).filter(file => file.kind === 'audio').map(file => path.posix.dirname(file.path))
  )) {
    const legacyDir = fileWithin(manifest.audioDir, audioDirName);
    if (fs.existsSync(legacyDir)) {
      fs.rmdirSync(legacyDir);
    }
  }
  removeStaging(manifest);
  if (manifest.phase !== 'db-committed') {
    updateManifest(operationsDir, operationId, { phase: 'db-committed' });
  }
  updateManifest(operationsDir, operationId, { phase: 'cleanup-complete', completedAt: new Date().toISOString() });
  maybePause(options);
}

/**
 * Recover an interrupted content migration under the shared lock.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {string} operationId
 * @param {object} options - { operationsDir, pauseMs }
 * @returns {{ operationId: string, state: string }}
 */
function recoverLocalizedContentMigration(db, operationId, options = {}) {
  validateOperationId(operationId);
  const operationsDir = path.resolve(options.operationsDir);
  acquireOperationLock(operationsDir, { type: OPERATION_TYPE, operationId }, { takeoverStaleIfOwner: operationId });

  const manifest = readManifest(operationsDir, operationId);
  if (!manifest) {
    releaseOperationLock(operationsDir);
    throw new OperationError('operation_not_found', `no operation ${operationId} exists to recover`);
  }
  validateManifest(manifest);
  if (path.resolve(db.name) !== path.resolve(manifest.dbPath)) {
    throw new OperationError('invalid_manifest', 'recovery database path does not match the recorded manifest dbPath');
  }

  // A crash in the lock-acquired phase has made no live changes.
  if (manifest.phase === 'lock-acquired') {
    removeStaging(manifest);
    finalizeRecovery(operationsDir, operationId);
    return { operationId, state: 'pre-state-restored' };
  }
  if (manifest.phase === 'cleanup-complete') {
    finalizeRecovery(operationsDir, operationId);
    return { operationId, state: 'already-complete' };
  }

  const currentHash = contentDbStateHash(db);
  let dbState = 'ambiguous';
  if (currentHash === manifest.preDbHash) dbState = 'pre';
  else if (currentHash === manifest.postDbHash) dbState = 'post';

  try {
    if (dbState === 'pre') {
      if (manifest.phase === 'db-committed') {
        throw new OperationError('recovery_ambiguous', 'database is pre-state but the operation phase is db-committed');
      }
      restorePreState(manifest);
      removeStaging(manifest);
      finalizeRecovery(operationsDir, operationId);
      return { operationId, state: 'pre-state-restored' };
    }
    if (dbState === 'post') {
      if (manifest.phase === 'prepared') {
        throw new OperationError('recovery_ambiguous', 'database is post-state but files were never promoted');
      }
      finalizeCommittedOperation(manifest, operationsDir, operationId, options);
      finalizeRecovery(operationsDir, operationId);
      return { operationId, state: 'post-state-finalized' };
    }
  } catch (error) {
    if (error instanceof OperationError) throw error;
    throw new OperationError('recovery_ambiguous', `recovery could not complete: ${error.message}`, { cause: error });
  }

  throw new OperationError(
    'recovery_ambiguous',
    'database matches neither the recorded pre-state nor post-state; restore the complete same-point-in-time backup before retrying'
  );
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function resolveConfig() {
  const cwd = process.cwd();
  return {
    dbPath: path.resolve(process.env.BLOG_DB_PATH || path.join(cwd, 'blog.db')),
    taxonomyPath: path.resolve(process.env.BLOG_TAXONOMY_PATH || path.join(cwd, 'content', 'taxonomy.json')),
    articlesDir: path.resolve(process.env.BLOG_ARTICLES_DIR || path.join(cwd, 'articles')),
    audioDir: path.resolve(process.env.BLOG_AUDIO_DIR || path.join(cwd, 'public', 'audio')),
    tempDir: path.resolve(process.env.BLOG_UPLOAD_DIR || path.join(cwd, 'uploads', 'temp')),
    operationsDir: path.resolve(process.env.BLOG_OPERATIONS_DIR || path.join(cwd, 'var', 'operations')),
    rootDir: cwd,
    operationId: nextOperationId(),
    pauseMs: Number(process.env.MIGRATE_CONTENT_PAUSE_MS) || 0
  };
}

function printResult(payload, exitCode) {
  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  process.exitCode = exitCode;
}

function parseArguments(argv) {
  const args = argv.slice(2);
  if (args.length === 0) return { mode: 'apply' };
  if (args.length === 1 && args[0] === '--dry-run') return { mode: 'dry-run' };
  if (args.length === 2 && args[0] === '--recover') {
    const operationId = args[1];
    if (!OPERATION_ID_PATTERN.test(operationId)) {
      return { mode: 'invalid', message: `invalid operation id: ${JSON.stringify(operationId)}` };
    }
    return { mode: 'recover', operationId };
  }
  return { mode: 'invalid', message: null };
}

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

function registryObstacle(config) {
  if (!fs.existsSync(config.operationsDir)) return null;
  const lockDir = path.join(config.operationsDir, LOCK_DIRNAME);
  if (fs.existsSync(lockDir)) {
    const owner = readLockOwner(lockDir);
    if (owner) {
      return {
        code: pidAlive(owner.pid) ? 'operation_active' : 'operation_stale_lock',
        message: `an active operation is in progress (${owner.operationId || 'unknown'}, pid ${owner.pid}); its output is not reusable as an apply plan`,
        operationId: owner.operationId || null
      };
    }
    return { code: 'operation_stale_lock', message: 'an unreadable operation lock exists; run --recover first' };
  }
  const incomplete = listOperations(config.operationsDir);
  if (incomplete.length > 0) {
    return {
      code: 'operation_incomplete',
      message: `incomplete operation manifests exist (${incomplete.join(', ')}); run --recover first`,
      operationIds: incomplete
    };
  }
  return null;
}

function serializeError(error) {
  if (error instanceof OperationError) {
    return {
      code: error.code,
      message: error.message,
      ...(error.plan ? { plan: error.plan } : {})
    };
  }
  return { code: error.code || 'error', message: error.message };
}

function exitCodeFor(error) {
  switch (error && error.code) {
    case 'plan_blocked':
      return EXIT_PLAN_BLOCKED;
    case 'file_hash_mismatch':
    case 'file_missing':
    case 'destination_collision':
    case 'unsafe_path':
      return EXIT_FILE_ERROR;
    case 'operation_busy':
    case 'operation_stale_lock':
    case 'operation_incomplete':
    case 'operation_not_found':
    case 'invalid_manifest':
    case 'invalid_operation_id':
      return EXIT_LOCK_OR_MANIFEST;
    case 'recovery_ambiguous':
    case 'stale_state':
    case 'cleanup_failed':
    case 'cleanup_warnings':
    case 'audit_failed':
      return EXIT_STALE_STATE;
    default:
      return EXIT_USAGE;
  }
}

function runDryRun(config) {
  const obstacle = registryObstacle(config);
  if (obstacle) {
    printResult({ dryRun: false, error: obstacle }, EXIT_LOCK_OR_MANIFEST);
    return;
  }
  let db;
  try {
    db = new Database(config.dbPath, { readonly: true });
  } catch (error) {
    printResult({ dryRun: false, error: { code: 'database', message: `cannot open database: ${error.message}` } }, EXIT_USAGE);
    return;
  }
  try {
    const version = schemaVersion(db);
    const plan = planLocalizedContentMigration(db, config);
    const blocked = planBlocked(plan);
    printResult({
      dryRun: true,
      schemaVersion: version,
      preMigration: version < 3,
      plan,
      blocked
    }, blocked ? EXIT_PLAN_BLOCKED : 0);
  } catch (error) {
    printResult({ dryRun: false, error: serializeError(error) }, exitCodeFor(error));
  } finally {
    db.close();
  }
}

function runApply(config) {
  let db;
  try {
    db = new Database(config.dbPath);
    db.pragma('foreign_keys = ON');
  } catch (error) {
    printResult({ applied: false, error: { code: 'database', message: `cannot open database: ${error.message}` } }, EXIT_USAGE);
    return;
  }
  try {
    const version = schemaVersion(db);
    if (version < 3) {
      printResult({
        applied: false,
        error: { code: 'schema_migration_required', message: `schema version ${version} is below 3; run the schema v3 migration first` }
      }, EXIT_USAGE);
      return;
    }
    const plan = applyLocalizedContentMigration(db, config);
    printResult({
      applied: true,
      operationId: config.operationId,
      plan
    }, 0);
  } catch (error) {
    printResult({ applied: false, error: serializeError(error) }, exitCodeFor(error));
  } finally {
    db.close();
  }
}

function runRecover(config, operationId) {
  let db;
  try {
    db = new Database(config.dbPath);
    db.pragma('foreign_keys = ON');
  } catch (error) {
    printResult({ recovered: false, error: { code: 'database', message: `cannot open database: ${error.message}` } }, EXIT_USAGE);
    return;
  }
  try {
    const result = recoverLocalizedContentMigration(db, operationId, config);
    printResult({ recovered: true, ...result }, 0);
  } catch (error) {
    printResult({ recovered: false, error: serializeError(error) }, exitCodeFor(error));
  } finally {
    db.close();
  }
}

function main() {
  const parsed = parseArguments(process.argv);
  if (parsed.mode === 'invalid') {
    if (parsed.message) {
      printResult({ error: { code: 'invalid_operation_id', message: parsed.message } }, EXIT_USAGE);
    } else {
      printResult({
        error: { code: 'usage', message: 'usage: node scripts/migrate-localized-content.js [--dry-run] | [--recover <operation-id>]' }
      }, EXIT_USAGE);
    }
    return;
  }
  const config = resolveConfig();
  if (parsed.mode === 'dry-run') {
    runDryRun(config);
  } else if (parsed.mode === 'recover') {
    runRecover(config, parsed.operationId);
  } else {
    runApply(config);
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  CONTENT_TOMBSTONE_PATTERN,
  applyLocalizedContentMigration,
  contentDbStateHash,
  planLocalizedContentMigration,
  recoverLocalizedContentMigration,
  schemaVersion
};

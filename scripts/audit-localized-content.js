#!/usr/bin/env node
'use strict';

/**
 * Read-only post-migration auditor for the localized content layout.
 *
 *   npm run audit-localized-content
 *
 * Opens the database read-only and exits non-zero unless every invariant
 * holds: SQLite integrity and foreign keys, one valid localized markdown
 * archive per article with matching metadata and tag ids, no legacy root
 * markdown/audio residue, exact localized audio URL/file/hash references,
 * byte-exact standalone FTS documents, comments resolving to localized
 * article ids, no orphaned posts, and a clean operation registry. Prints
 * deterministic JSON counts and errors for DEPLOY to record before/after
 * rollout.
 */

const fs = require('node:fs');
const path = require('node:path');
const Database = require('better-sqlite3');
const { LOCK_DIRNAME, fileSha256, listOperations, readLockOwner } = require('../server/operations/journal');
const { SUPPORTED_LOCALES } = require('../server/i18n/config');
const { SAFE_SLUG_PATTERN } = require('../server/utils/path-security');
const {
  classifyAudioUrl,
  parseMarkdownDocument,
  scanAudioUrlReferences
} = require('../server/utils/markdown');
const { buildArticleSearchDocument } = require('../server/articles/search-index');

const EXIT_AUDIT_FAILURE = 1;
const LEGACY_AUDIO_FILE_PATTERN = /^([a-f0-9]{64})\.(mp3|aac|m4a|flac)$/;
const IGNORED_ENTRY_PATTERN = /^\.(?:gitkeep|deleting-|replacing-|taxonomy-sync-|content-migrate-)/;
const SYSTEM_TAG_ID = 'other';

function schemaVersion(db) {
  const hasMigrations = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'").get();
  if (!hasMigrations) return 1;
  const row = db.prepare('SELECT MAX(version) AS version FROM schema_migrations').get();
  return row.version || 1;
}

function setsEqual(left, right) {
  if (left.size !== right.size) return false;
  for (const value of left) {
    if (!right.has(value)) return false;
  }
  return true;
}

function isIgnoredEntry(name) {
  return IGNORED_ENTRY_PATTERN.test(name);
}

/**
 * Audit the localized content state.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {object} options - { articlesDir, audioDir, operationsDir, checkOperations }
 * @returns {{ audited: boolean, passed: boolean, schemaVersion: number,
 *   checks: object, counts: object, errors: Array<{check: string, message: string}> }}
 */
function auditLocalizedContent(db, options = {}) {
  const articlesDir = path.resolve(options.articlesDir);
  const audioDir = path.resolve(options.audioDir);
  const operationsDir = options.operationsDir ? path.resolve(options.operationsDir) : null;
  const checkOperations = options.checkOperations !== false;
  const errors = [];
  const pushError = (check, message) => errors.push({ check, message });
  const counts = {
    articles: 0,
    posts: 0,
    comments: 0,
    ftsRows: 0,
    audioFiles: 0,
    localizedMarkdownFiles: 0,
    legacyMarkdownFiles: 0,
    legacyAudioDirs: 0
  };
  const version = schemaVersion(db);
  if (version < 3) {
    return {
      audited: true,
      passed: false,
      schemaVersion: version,
      checks: {
        integrity: false,
        foreignKeys: false,
        articles: false,
        legacyLayout: false,
        audioUrls: false,
        fts: false,
        comments: false,
        operations: checkOperations ? false : null
      },
      counts,
      errors: [{ check: 'schema', message: `schema version ${version} is below 3; migrate the database first` }]
    };
  }

  // 1) SQLite integrity and foreign keys.
  let integrityPass = false;
  try {
    integrityPass = db.pragma('integrity_check', { simple: true }) === 'ok';
  } catch (error) {
    pushError('integrity', `integrity_check failed: ${error.message}`);
  }
  if (!integrityPass) pushError('integrity', 'PRAGMA integrity_check did not return ok');
  const foreignKeyViolations = db.prepare('PRAGMA foreign_key_check').all();
  const foreignKeysPass = foreignKeyViolations.length === 0;
  if (!foreignKeysPass) pushError('foreignKeys', `foreign_key_check found ${foreignKeyViolations.length} violations`);

  counts.posts = Number(db.prepare('SELECT COUNT(*) AS n FROM posts').get().n);
  counts.articles = Number(db.prepare('SELECT COUNT(*) AS n FROM articles').get().n);
  counts.ftsRows = Number(db.prepare('SELECT COUNT(*) AS n FROM article_fts').get().n);

  const articles = db.prepare(`
    SELECT id, post_id, locale, slug, title, content, html, created_at
    FROM articles ORDER BY id
  `).all();
  const posts = new Map(db.prepare('SELECT id, translation_key FROM posts ORDER BY id').all().map(row => [row.id, row.translation_key]));
  const tagsByArticle = new Map();
  for (const row of db.prepare('SELECT article_id, tag_id FROM article_tags ORDER BY article_id, tag_id').all()) {
    if (!tagsByArticle.has(row.article_id)) tagsByArticle.set(row.article_id, []);
    tagsByArticle.get(row.article_id).push(row.tag_id);
  }
  const tagById = new Map(db.prepare('SELECT id, origin FROM tags ORDER BY id').all().map(row => [row.id, row]));
  const labelByName = new Map();
  for (const label of db.prepare('SELECT tag_id, name FROM tag_labels ORDER BY tag_id, locale').all()) {
    const key = String(label.name).normalize('NFKC').trim();
    if (!labelByName.has(key)) labelByName.set(key, new Set());
    labelByName.get(key).add(label.tag_id);
  }
  function resolveAuditTag(token) {
    const normalized = String(token).normalize('NFKC').trim();
    if (tagById.has(normalized)) return { kind: 'tag', tagId: normalized };
    const byLabel = labelByName.get(normalized);
    if (byLabel && byLabel.size === 1) return { kind: 'tag', tagId: [...byLabel][0] };
    return { kind: 'unknown' };
  }

  // 2) Every article: one valid post, exactly one localized markdown archive,
  // matching metadata, and a tag set equal to article_tags.
  let articlesPass = true;
  for (const article of articles) {
    if (!posts.has(article.post_id)) {
      pushError('articles', `article ${article.id} (${article.slug}) references a missing post`);
      articlesPass = false;
      continue;
    }
    const translationKey = posts.get(article.post_id);
    const filePath = path.join(articlesDir, article.locale, `${article.slug}.md`);
    if (!fs.existsSync(filePath)) {
      pushError('articles', `article ${article.id} (${article.slug}) has no localized markdown file at ${article.locale}/${article.slug}.md`);
      articlesPass = false;
      continue;
    }
    counts.localizedMarkdownFiles += 1;
    let raw;
    try {
      raw = fs.readFileSync(filePath, 'utf8');
    } catch (error) {
      pushError('articles', `article ${article.id} markdown unreadable: ${error.message}`);
      articlesPass = false;
      continue;
    }
    let parsed;
    try {
      parsed = parseMarkdownDocument(raw);
    } catch (error) {
      pushError('articles', `article ${article.id} markdown invalid: ${error.message}`);
      articlesPass = false;
      continue;
    }
    const data = parsed.data;
    if (data.slug !== article.slug || data.locale !== article.locale || data.translationKey !== translationKey) {
      pushError('articles', `article ${article.id} markdown metadata mismatch (slug/locale/translationKey)`);
      articlesPass = false;
    }
    const fileIds = new Set();
    let tagError = null;
    for (const token of Array.isArray(data.tags) ? data.tags : []) {
      const resolved = resolveAuditTag(token);
      if (resolved.kind === 'tag') fileIds.add(resolved.tagId);
      else { tagError = `unresolved tag token ${JSON.stringify(token)}`; break; }
    }
    if (fileIds.size === 0) fileIds.add(SYSTEM_TAG_ID);
    if (tagError || !setsEqual(fileIds, new Set(tagsByArticle.get(article.id) || []))) {
      pushError('articles', `article ${article.id} file/database tag sets differ${tagError ? `: ${tagError}` : ''}`);
      articlesPass = false;
    }
  }
  const orphanedPosts = db.prepare(`
    SELECT posts.id FROM posts LEFT JOIN articles ON articles.post_id = posts.id WHERE articles.id IS NULL
  `).all();
  if (orphanedPosts.length > 0) {
    pushError('articles', `orphaned posts exist (${orphanedPosts.map(row => row.id).join(', ')})`);
    articlesPass = false;
  }
  for (const locale of SUPPORTED_LOCALES) {
    const localeDir = path.join(articlesDir, locale);
    if (!fs.existsSync(localeDir)) continue;
    for (const name of fs.readdirSync(localeDir)) {
      if (isIgnoredEntry(name) || !name.endsWith('.md')) continue;
      const slug = name.slice(0, -3);
      if (!articles.some(article => article.locale === locale && article.slug === slug)) {
        pushError('articles', `orphan localized markdown file: ${locale}/${name}`);
        articlesPass = false;
      }
    }
  }

  // 3) No live legacy root markdown/audio residue.
  let legacyLayoutPass = true;
  if (fs.existsSync(articlesDir)) {
    for (const name of fs.readdirSync(articlesDir)) {
      if (isIgnoredEntry(name) || SUPPORTED_LOCALES.includes(name)) continue;
      if (name.endsWith('.md')) {
        pushError('legacyLayout', `legacy root markdown file remains: ${name}`);
        counts.legacyMarkdownFiles += 1;
        legacyLayoutPass = false;
      }
    }
  }
  if (fs.existsSync(audioDir)) {
    for (const entry of fs.readdirSync(audioDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      if (isIgnoredEntry(entry.name) || SUPPORTED_LOCALES.includes(entry.name)) continue;
      counts.legacyAudioDirs += 1;
      const live = fs.readdirSync(path.join(audioDir, entry.name)).filter(name => !isIgnoredEntry(name));
      if (live.length > 0) {
        pushError('legacyLayout', `legacy audio directory remains: ${entry.name}`);
        legacyLayoutPass = false;
      }
    }
  }

  // 4) Audio URLs: every published URL belongs to its article and resolves to
  // a file with the matching SHA-256; every locale-owned file is referenced;
  // no legacy audio URL remains.
  let audioUrlsPass = true;
  const referencedFiles = new Set();
  for (const article of articles) {
    for (const reference of scanAudioUrlReferences(article.html)) {
      const classified = classifyAudioUrl(reference.path);
      if (classified.kind === 'legacy') {
        pushError('audioUrls', `legacy audio URL remains for article ${article.id}: ${reference.path}`);
        audioUrlsPass = false;
        continue;
      }
      if (classified.kind === 'published') {
        if (classified.locale !== article.locale || classified.slug !== article.slug) {
          pushError('audioUrls', `foreign published audio URL for article ${article.id}: ${reference.path}`);
          audioUrlsPass = false;
          continue;
        }
        const filePath = path.join(audioDir, classified.locale, classified.slug, classified.file);
        if (!fs.existsSync(filePath)) {
          pushError('audioUrls', `published audio URL is missing its file for article ${article.id}: ${reference.path}`);
          audioUrlsPass = false;
          continue;
        }
        if (fileSha256(filePath) !== `sha256:${classified.hash}`) {
          pushError('audioUrls', `audio file SHA-256 mismatch for ${reference.path}`);
          audioUrlsPass = false;
          continue;
        }
        referencedFiles.add(`${classified.locale}/${classified.slug}/${classified.file}`);
        continue;
      }
      if (classified.slug === article.slug) {
        pushError('audioUrls', `malformed audio URL for article ${article.id}: ${reference.path}`);
        audioUrlsPass = false;
      }
    }
  }
  for (const locale of SUPPORTED_LOCALES) {
    const localeDir = path.join(audioDir, locale);
    if (!fs.existsSync(localeDir)) continue;
    for (const slugName of fs.readdirSync(localeDir)) {
      if (isIgnoredEntry(slugName) || !SAFE_SLUG_PATTERN.test(slugName)) continue;
      const slugDir = path.join(localeDir, slugName);
      if (!fs.statSync(slugDir).isDirectory()) continue;
      if (!articles.some(article => article.locale === locale && article.slug === slugName)) {
        pushError('audioUrls', `audio directory has no matching article: ${locale}/${slugName}`);
        audioUrlsPass = false;
        continue;
      }
      for (const name of fs.readdirSync(slugDir)) {
        const match = LEGACY_AUDIO_FILE_PATTERN.exec(name);
        if (!match) {
          if (isIgnoredEntry(name)) continue;
          pushError('audioUrls', `malformed audio file in ${locale}/${slugName}: ${name}`);
          audioUrlsPass = false;
          continue;
        }
        const fileKey = `${match[1]}.${match[2]}`;
        counts.audioFiles += 1;
        if (!referencedFiles.has(`${locale}/${slugName}/${fileKey}`)) {
          pushError('audioUrls', `unreferenced locale-owned audio file: ${locale}/${slugName}/${fileKey}`);
          audioUrlsPass = false;
        }
      }
    }
  }

  // 5) Standalone FTS exactness against fresh recomputation.
  let ftsPass = true;
  const ftsRows = db.prepare('SELECT rowid, title, content, taxonomy FROM article_fts ORDER BY rowid').all();
  const ftsByRowid = new Map(ftsRows.map(row => [row.rowid, row]));
  const articleIds = new Set(articles.map(article => article.id));
  for (const row of ftsRows) {
    if (!articleIds.has(row.rowid)) {
      pushError('fts', `article_fts row ${row.rowid} resolves to no article`);
      ftsPass = false;
    }
  }
  for (const article of articles) {
    const stored = ftsByRowid.get(article.id);
    if (!stored) {
      pushError('fts', `article ${article.id} has no FTS row`);
      ftsPass = false;
      continue;
    }
    const expected = buildArticleSearchDocument(db, article.id);
    if (!expected || stored.title !== expected.title || stored.content !== expected.content || stored.taxonomy !== expected.taxonomy) {
      pushError('fts', `article ${article.id} FTS document diverges from fresh recomputation`);
      ftsPass = false;
    }
  }

  // 6) Comments resolve to localized article ids.
  let commentsPass = true;
  const hasCommentsTable = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'comments'").get();
  if (hasCommentsTable) {
    counts.comments = Number(db.prepare('SELECT COUNT(*) AS n FROM comments').get().n);
    const dangling = db.prepare('SELECT DISTINCT article_id FROM comments').all()
      .filter(row => !articleIds.has(row.article_id));
    if (dangling.length > 0) {
      pushError('comments', `comments reference missing articles (${dangling.map(row => row.article_id).join(', ')})`);
      commentsPass = false;
    }
  }

  // 7) No incomplete operation manifest or shared lock remains.
  let operationsPass = true;
  if (checkOperations && operationsDir && fs.existsSync(operationsDir)) {
    const lockDir = path.join(operationsDir, LOCK_DIRNAME);
    if (fs.existsSync(lockDir)) {
      const owner = readLockOwner(lockDir);
      pushError('operations', owner
        ? `an operation lock is present (${owner.operationId || 'unknown'}, pid ${owner.pid})`
        : 'an unreadable operation lock is present');
      operationsPass = false;
    } else {
      const incomplete = listOperations(operationsDir);
      if (incomplete.length > 0) {
        pushError('operations', `incomplete operation manifests remain (${incomplete.join(', ')})`);
        operationsPass = false;
      }
    }
  }

  return {
    audited: true,
    passed: errors.length === 0,
    schemaVersion: version,
    checks: {
      integrity: integrityPass,
      foreignKeys: foreignKeysPass,
      articles: articlesPass,
      legacyLayout: legacyLayoutPass,
      audioUrls: audioUrlsPass,
      fts: ftsPass,
      comments: commentsPass,
      operations: checkOperations ? operationsPass : null
    },
    counts,
    errors
  };
}

function resolveConfig() {
  const cwd = process.cwd();
  return {
    dbPath: path.resolve(process.env.BLOG_DB_PATH || path.join(cwd, 'blog.db')),
    articlesDir: path.resolve(process.env.BLOG_ARTICLES_DIR || path.join(cwd, 'articles')),
    audioDir: path.resolve(process.env.BLOG_AUDIO_DIR || path.join(cwd, 'public', 'audio')),
    operationsDir: path.resolve(process.env.BLOG_OPERATIONS_DIR || path.join(cwd, 'var', 'operations')),
    rootDir: cwd
  };
}

function main() {
  const config = resolveConfig();
  let db;
  try {
    db = new Database(config.dbPath, { readonly: true });
  } catch (error) {
    process.stdout.write(`${JSON.stringify({ audited: false, error: { code: 'database', message: `cannot open database: ${error.message}` } }, null, 2)}\n`);
    process.exitCode = EXIT_AUDIT_FAILURE;
    return;
  }
  try {
    const result = auditLocalizedContent(db, config);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    process.exitCode = result.passed ? 0 : EXIT_AUDIT_FAILURE;
  } catch (error) {
    process.stdout.write(`${JSON.stringify({ audited: false, error: { code: error.code || 'audit', message: error.message } }, null, 2)}\n`);
    process.exitCode = EXIT_AUDIT_FAILURE;
  } finally {
    db.close();
  }
}

if (require.main === module) {
  main();
}

module.exports = { auditLocalizedContent };

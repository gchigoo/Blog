#!/usr/bin/env node
'use strict';

/**
 * Transactional taxonomy synchronization CLI.
 *
 *   npm run sync-taxonomy -- --dry-run
 *   npm run sync-taxonomy
 *   npm run sync-taxonomy -- --recover <operation-id>
 *
 * The database is opened with better-sqlite3 directly (never through the
 * auto-migrating `server/db.js`), so no migration can run implicitly. Dry-run
 * opens read-only, inspects the operation registry without writing anything,
 * and on schema v2 emits a pre-migration audit that predicts exactly what
 * schema v3 and the coordinated apply will do.
 *
 * Exit codes:
 *   0 success, 1 usage/validation, 2 blocked plan (conflicts, slug changes,
 *   refused deletions), 3 file errors, 4 lock/manifest errors, 5 stale-state
 *   and ambiguous-recovery refusals.
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const Database = require('better-sqlite3');
const { loadTaxonomyCatalog } = require('../server/taxonomy/catalog');
const { planTaxonomySync, previewLegacyTagId } = require('../server/taxonomy/store');
const { applyTaxonomySync, recoverTaxonomySync } = require('../server/taxonomy/publication');
const {
  LOCK_DIRNAME,
  OPERATION_ID_PATTERN,
  OperationError,
  listOperations,
  readLockOwner
} = require('../server/operations/journal');

const EXIT_USAGE = 1;
const EXIT_PLAN_BLOCKED = 2;
const EXIT_FILE_ERROR = 3;
const EXIT_LOCK_OR_MANIFEST = 4;
const EXIT_STALE_STATE = 5;

function printResult(payload, exitCode) {
  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  process.exitCode = exitCode;
}

function usageError() {
  printResult({
    error: {
      code: 'usage',
      message: 'usage: node scripts/sync-taxonomy.js [--dry-run] | [--recover <operation-id>]'
    }
  }, EXIT_USAGE);
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

function resolveConfig() {
  const cwd = process.cwd();
  return {
    dbPath: path.resolve(process.env.BLOG_DB_PATH || path.join(cwd, 'blog.db')),
    taxonomyPath: path.resolve(process.env.BLOG_TAXONOMY_PATH || path.join(cwd, 'content', 'taxonomy.json')),
    articlesDir: path.resolve(process.env.BLOG_ARTICLES_DIR || path.join(cwd, 'articles')),
    tempDir: path.resolve(process.env.BLOG_UPLOAD_DIR || path.join(cwd, 'uploads', 'temp')),
    operationsDir: path.resolve(process.env.BLOG_OPERATIONS_DIR || path.join(cwd, 'var', 'operations')),
    rootDir: cwd,
    operationId: crypto.randomUUID(),
    pauseMs: Number(process.env.SYNC_TAXONOMY_PAUSE_MS) || 0
  };
}

function schemaVersion(db) {
  const hasMigrations = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'").get();
  if (!hasMigrations) return 1;
  const row = db.prepare('SELECT MAX(version) AS version FROM schema_migrations').get();
  return row.version || 1;
}

/**
 * Zero-write registry inspection for dry-run: a live or stale lock and any
 * incomplete operation manifest report the active operation instead of a plan.
 */
function registryObstacle(config) {
  if (!fs.existsSync(config.operationsDir)) return null;
  const lockDir = path.join(config.operationsDir, LOCK_DIRNAME);
  if (fs.existsSync(lockDir)) {
    const owner = readLockOwner(lockDir);
    if (owner) {
      return {
        code: owner.pid > 0 && pidAlive(owner.pid) ? 'operation_active' : 'operation_stale_lock',
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

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

/**
 * Schema v2 pre-migration audit: validate the catalog and report, per legacy
 * JSON tag value, the deterministic direct catalog match or the legacy tag id
 * (and slug) that migration 3 will create. Reads only.
 */
function planPreMigration(db, catalog) {
  const audit = { directMatches: [], unknownLegacyTags: [] };
  const byValue = new Map();
  const rows = db.prepare('SELECT id, slug, tags FROM articles ORDER BY id').all();
  for (const row of rows) {
    let values;
    try {
      const parsed = JSON.parse(row.tags || '[]');
      values = Array.isArray(parsed) ? parsed.filter(tag => typeof tag === 'string') : [];
    } catch {
      // An unparseable tags column is surfaced as an empty contribution here;
      // the audit still reports every parseable value deterministically.
      values = [];
    }
    for (const value of values) {
      const key = String(value).normalize('NFKC').trim();
      if (key === '') continue;
      if (!byValue.has(key)) byValue.set(key, { value: key, articles: [] });
      byValue.get(key).articles.push(row.id);
    }
  }
  const resolver = buildPreviewResolver(catalog);
  for (const entry of [...byValue.values()].sort((left, right) => left.value.localeCompare(right.value))) {
    const resolved = resolver(entry.value);
    if (resolved.direct) {
      audit.directMatches.push({ value: entry.value, tagId: resolved.tagId, articles: entry.articles });
    } else {
      audit.unknownLegacyTags.push({ value: entry.value, legacyTagId: resolved.tagId, articles: entry.articles });
    }
  }
  return {
    preMigration: true,
    categories: catalog.categories.map(category => ({
      id: category.id,
      sortOrder: category.sortOrder,
      tags: (category.tags || []).map(tag => tag.id)
    })),
    audit
  };
}

function buildPreviewResolver(catalog) {
  const byNormalized = new Map();
  const addMapping = (value, tagId) => {
    const normalized = String(value).normalize('NFKC').trim();
    if (normalized !== '' && !byNormalized.has(normalized)) byNormalized.set(normalized, tagId);
  };
  for (const category of catalog.categories) {
    for (const tag of category.tags || []) {
      if (tag.id !== 'other') continue;
      for (const locale of Object.keys(tag.labels)) {
        addMapping(tag.labels[locale].name, tag.id);
        addMapping(tag.labels[locale].slug, tag.id);
      }
    }
  }
  for (const category of catalog.categories) {
    for (const tag of category.tags || []) {
      if (tag.id === 'other') continue;
      for (const locale of Object.keys(tag.labels)) {
        addMapping(tag.labels[locale].name, tag.id);
      }
      for (const legacyName of tag.legacyNames || []) {
        addMapping(legacyName, tag.id);
      }
    }
  }
  return (value) => {
    const mapped = byNormalized.get(value);
    return mapped ? { direct: true, tagId: mapped } : { direct: false, tagId: previewLegacyTagId(value, catalog) };
  };
}

function runDryRun(config) {
  const obstacle = registryObstacle(config);
  if (obstacle) {
    printResult({ dryRun: false, error: obstacle }, EXIT_LOCK_OR_MANIFEST);
    return;
  }
  let catalog;
  try {
    catalog = loadTaxonomyCatalog(config.taxonomyPath);
  } catch (error) {
    printResult({ dryRun: false, error: { code: 'catalog', message: error.message } }, EXIT_USAGE);
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
    if (version < 3) {
      printResult({
        dryRun: true,
        schemaVersion: version,
        preMigration: true,
        plan: planPreMigration(db, catalog)
      }, 0);
      return;
    }
    const plan = planTaxonomySync(db, catalog, config);
    const blocked = plan.conflicts.length > 0 || plan.blockedSlugChanges.length > 0 || plan.blockedDeletions.length > 0;
    printResult({ dryRun: true, schemaVersion: version, preMigration: false, plan }, blocked ? EXIT_PLAN_BLOCKED : 0);
  } catch (error) {
    printResult({ dryRun: false, error: { code: error.code || 'planning', message: error.message } }, error.code === 'plan_blocked' ? EXIT_PLAN_BLOCKED : EXIT_USAGE);
  } finally {
    db.close();
  }
}

function runApply(config) {
  let catalog;
  try {
    catalog = loadTaxonomyCatalog(config.taxonomyPath);
  } catch (error) {
    printResult({ applied: false, error: { code: 'catalog', message: error.message } }, EXIT_USAGE);
    return;
  }
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
    const plan = applyTaxonomySync(db, catalog, config);
    printResult({
      applied: true,
      operationId: config.operationId,
      filesRewritten: plan.markdownRewrites.length,
      affectedArticles: plan.affectedArticleIds.length,
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
    const result = recoverTaxonomySync(db, operationId, config);
    printResult({ recovered: true, ...result }, 0);
  } catch (error) {
    printResult({ recovered: false, error: serializeError(error) }, exitCodeFor(error));
  } finally {
    db.close();
  }
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
      return EXIT_STALE_STATE;
    default:
      return EXIT_USAGE;
  }
}

function main() {
  const parsed = parseArguments(process.argv);
  if (parsed.mode === 'invalid') {
    if (parsed.message) {
      printResult({ error: { code: 'invalid_operation_id', message: parsed.message } }, EXIT_USAGE);
    } else {
      usageError();
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

main();

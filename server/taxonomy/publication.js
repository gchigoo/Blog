'use strict';

/**
 * Compensated taxonomy publication: filesystem staging/tombstoning/promotion
 * plus one SQLite transaction, all journaled under `var/operations` with the
 * shared cross-process lock.
 *
 * Phase machine (durable, atomic manifest writes, fsynced):
 *
 *   lock-acquired -> prepared -> files-promoted -> db-committed -> cleanup-complete
 *
 * - `lock-acquired`: operation dir + manifest created; a crash here has made no
 *   live changes and recovery removes it after verifying the pre-state.
 * - `prepared`: plan, pre/post DB hashes, exact file paths/hashes and the
 *   disposable staging root are recorded before the first live rename.
 * - `files-promoted`: every source file was hash-verified, tombstoned, and the
 *   staged rewrite promoted + hash-verified at the destination.
 * - `db-committed`: the single transaction (pre-hash recheck, taxonomy rows,
 *   `article_tags` rewiring, unreferenced-row deletion, exact FTS refresh)
 *   committed.
 * - `cleanup-complete`: tombstones and staging removed; then the operation
 *   directory is deleted and the lock released.
 *
 * Every caught pre-commit failure rolls back SQLite (better-sqlite3
 * transaction) and restores files from tombstones in reverse order. Recovery
 * (`--recover <operation-id>`) compares the current DB to the manifest's
 * pre/post hashes: pre-state restores originals from tombstones, post-state
 * verifies/finalizes the committed files and cleanup, any third state refuses
 * automated recovery and retains the journal as evidence.
 */

const fs = require('node:fs');
const path = require('node:path');
const Database = require('better-sqlite3');
const {
  OperationError,
  OPERATION_PHASES,
  TOMBSTONE_PATTERN,
  acquireOperationLock,
  cleanupStaleLocks,
  createOperation,
  dbStateHash,
  fileSha256,
  fsyncDirectory,
  fsyncFile,
  listOperations,
  nextOperationId,
  readManifest,
  releaseOperationLock,
  removeOperation,
  syncSleep,
  updateManifest,
  validateOperationId
} = require('../operations/journal');
const { rewriteMarkdownTags } = require('../utils/markdown');
const { upsertArticleSearchDocuments } = require('../articles/search-index');
const { planTaxonomySync } = require('./store');

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

function validateTombstoneName(name) {
  if (typeof name !== 'string' || !TOMBSTONE_PATTERN.test(name)) {
    throw new OperationError('invalid_manifest', `unsafe tombstone name: ${JSON.stringify(name)}`);
  }
  return name;
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

function sourcePath(manifest, file) {
  return fileWithin(manifest.articlesDir, file.path);
}

function tombstonePath(source, file) {
  return path.join(path.dirname(source), validateTombstoneName(file.tombstone));
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

/**
 * Restore every source the apply itself moved away, in reverse order, then
 * drop staging. Files whose durable flag says tombstoned are always restored
 * from their verified tombstone. Files whose flag was never persisted are
 * restored only when the source is missing and a hash-valid tombstone exists
 * (the crash window between rename and flag persistence); an existing source
 * is external state and is left exactly as the writer left it. Throws
 * `rollback_failed` when any restore fails, leaving the journal as evidence
 * for manual recovery.
 */
function restoreFiles(manifest) {
  const failures = [];
  for (const file of [...manifest.files].reverse()) {
    try {
      if (file.tombstoned) {
        restoreSource(manifest, file);
      } else {
        restoreMissingSource(manifest, file);
      }
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

/**
 * Restore a file whose durable flag already says it was tombstoned: verify the
 * tombstone still holds the original bytes, rename it back over the source
 * (which replaces any promoted rewrite), and fsync the directory before the
 * journal is removed.
 */
function restoreSource(manifest, file) {
  const source = sourcePath(manifest, file);
  const tombstone = tombstonePath(source, file);
  const tombstoneHash = fileSha256(tombstone);
  if (tombstoneHash !== file.originalHash) {
    throw new OperationError('file_hash_mismatch', `tombstone hash mismatch for ${file.path}`);
  }
  fs.renameSync(tombstone, source);
  fsyncDirectory(path.dirname(source));
}

/**
 * Compensation for a file whose durable flag was never persisted. The source
 * still exists (untouched or externally drifted) → leave it, the root error
 * propagates. The source is missing but a hash-valid tombstone exists → a
 * crash landed between the rename and the flag update; restore it. Anything
 * else cannot be deterministically restored.
 */
function restoreMissingSource(manifest, file) {
  const source = sourcePath(manifest, file);
  if (fs.existsSync(source)) return;
  const tombstone = tombstonePath(source, file);
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

/**
 * Confirm a source still holds its original content, or restore it from a
 * hash-valid tombstone when the source is missing. The missing-source case is
 * a crash that landed after the tombstone rename but before the durable
 * `tombstoned` flag update; a deterministic pre-state restore is available
 * because the tombstone hash is recorded. A source that exists with different
 * bytes is ambiguous (an external writer), and so is any tombstone hash
 * mismatch — both refuse rather than guess.
 */
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
    tombstoneHash = fileSha256(tombstonePath(source, file));
  } catch {
    throw new OperationError('recovery_ambiguous', `source and tombstone are both missing for ${file.path}`);
  }
  if (tombstoneHash !== file.originalHash) {
    throw new OperationError('recovery_ambiguous', `tombstone hash mismatch for ${file.path}`);
  }
  fs.renameSync(tombstonePath(source, file), source);
  fsyncDirectory(path.dirname(source));
}

/**
 * The single SQLite transaction body. The pre-DB hash is rechecked first
 * (stale-plan guard), then catalog rows are applied, `article_tags` rows are
 * rewired, only now-unreferenced non-system rows are deleted, and exactly the
 * affected FTS rows are refreshed. Commit happens last; any throw rolls the
 * whole transaction back.
 */
function applyPlanTransactionBody(db, plan, preDbHash, options) {
  const hooks = hooksOf(options);
  if (dbStateHash(db) !== preDbHash) {
    throw new OperationError('stale_state', 'database changed between planning and the apply transaction');
  }
  applyCatalogRows(db, plan);
  rewireArticleTags(db, plan);
  hooks.afterRewire?.();
  injectFailure(options, 'rewire');
  deleteUnreferencedRows(db, plan);
  upsertArticleSearchDocuments(db, plan.affectedArticleIds);
  hooks.afterFts?.();
  injectFailure(options, 'fts');
}

function commitDatabaseTransaction(db, plan, preDbHash, options) {
  return db.transaction(() => {
    applyPlanTransactionBody(db, plan, preDbHash, options);
  })();
}

function applyCatalogRows(db, plan) {
  const insertCategory = db.prepare(`
    INSERT INTO categories (id, sort_order, origin) VALUES (?, ?, 'config')
  `);
  const insertCategoryLabel = db.prepare(`
    INSERT INTO category_labels (category_id, locale, name, slug) VALUES (?, ?, ?, ?)
  `);
  const updateCategory = db.prepare('UPDATE categories SET sort_order = ? WHERE id = ?');
  const updateCategoryLabel = db.prepare(`
    UPDATE category_labels SET name = ?, slug = ? WHERE category_id = ? AND locale = ?
  `);
  const insertTag = db.prepare(`
    INSERT INTO tags (id, category_id, sort_order, origin, is_system) VALUES (?, ?, ?, 'config', 0)
  `);
  const insertTagLabel = db.prepare(`
    INSERT INTO tag_labels (tag_id, locale, name, slug) VALUES (?, ?, ?, ?)
  `);
  const updateTag = db.prepare('UPDATE tags SET category_id = ?, sort_order = ? WHERE id = ?');
  const updateTagLabel = db.prepare(`
    UPDATE tag_labels SET name = ?, slug = ? WHERE tag_id = ? AND locale = ?
  `);

  for (const category of plan.insertedCategories) {
    insertCategory.run(category.id, category.sortOrder);
    for (const locale of Object.keys(category.labels)) {
      insertCategoryLabel.run(category.id, locale, category.labels[locale].name, category.labels[locale].slug);
    }
  }
  for (const category of plan.updatedCategories) {
    updateCategory.run(category.sortOrder, category.id);
    for (const locale of Object.keys(category.labels)) {
      updateCategoryLabel.run(category.labels[locale].name, category.labels[locale].slug, category.id, locale);
    }
  }
  for (const tag of plan.insertedTags) {
    insertTag.run(tag.id, tag.categoryId, tag.sortOrder);
    for (const locale of Object.keys(tag.labels)) {
      insertTagLabel.run(tag.id, locale, tag.labels[locale].name, tag.labels[locale].slug);
    }
  }
  for (const tag of plan.updatedTags) {
    updateTag.run(tag.categoryId, tag.sortOrder, tag.id);
    for (const locale of Object.keys(tag.labels)) {
      updateTagLabel.run(tag.labels[locale].name, tag.labels[locale].slug, tag.id, locale);
    }
  }
}

function rewireArticleTags(db, plan) {
  const insertRewired = db.prepare(`
    INSERT OR IGNORE INTO article_tags (article_id, tag_id)
    SELECT article_id, ? FROM article_tags WHERE tag_id = ?
  `);
  const deleteRewired = db.prepare('DELETE FROM article_tags WHERE tag_id = ?');
  for (const rewire of plan.legacyRewires) {
    insertRewired.run(rewire.tagId, rewire.legacyTagId);
    deleteRewired.run(rewire.legacyTagId);
  }
}

function deleteUnreferencedRows(db, plan) {
  const deleteTag = db.prepare('DELETE FROM tags WHERE id = ?');
  const deleteCategory = db.prepare('DELETE FROM categories WHERE id = ?');
  // Foreign keys (ON DELETE RESTRICT) make it impossible to delete a row that
  // still has references; only now-unreferenced non-system rows are removed.
  for (const tag of plan.deletedTags) {
    deleteTag.run(tag.id);
  }
  for (const category of plan.deletedCategories) {
    deleteCategory.run(category.id);
  }
}

/**
 * Predict the post-apply DB hash by replaying the exact apply transaction on a
 * `VACUUM INTO` copy of the current database, then hashing the copy. Recovery
 * needs the post hash before any live change so a crash between the commit and
 * the `db-committed` manifest write can still be recognized as post-state.
 * Hooks and injected failures are intentionally not run on the prediction.
 */
function predictPostDbHash(db, plan, preDbHash, stagingRoot) {
  const simulatePath = path.join(stagingRoot, 'simulate.db');
  db.exec(`VACUUM INTO '${simulatePath.replaceAll("'", "''")}'`);
  const clone = new Database(simulatePath);
  try {
    clone.pragma('foreign_keys = ON');
    commitDatabaseTransaction(clone, plan, preDbHash, {});
    return { postDbHash: dbStateHash(clone) };
  } finally {
    clone.close();
  }
}

function resolveDbPath(db, rootDir) {
  const name = db.name || 'blog.db';
  return path.resolve(path.isAbsolute(name) ? name : path.join(rootDir, name));
}

/**
 * Apply a validated taxonomy plan with compensation and journaling.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {object} catalog
 * @param {object} options - { articlesDir, tempDir, operationsDir, rootDir,
 *   operationId, pauseMs, hooks, injectFailures }
 * @returns {object} the applied TaxonomySyncPlan
 */
function applyTaxonomySync(db, catalog, options = {}) {
  const operationsDir = path.resolve(options.operationsDir);
  const articlesDir = path.resolve(options.articlesDir);
  const tempDir = path.resolve(options.tempDir);
  const rootDir = path.resolve(options.rootDir || process.cwd());
  const operationId = options.operationId || nextOperationId();
  validateOperationId(operationId);

  // Mutual exclusion first: a live owner reports busy, a dead one is a stale
  // lock that only the matching recovery flow may take over.
  acquireOperationLock(operationsDir, { type: 'taxonomy-sync', operationId });
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

    const plan = planTaxonomySync(db, catalog, options);
    if (plan.conflicts.length > 0 || plan.blockedSlugChanges.length > 0 || plan.blockedDeletions.length > 0) {
      throw new OperationError('plan_blocked', 'taxonomy plan is blocked and cannot be applied', { plan });
    }

    const stagingRoot = path.join(tempDir, `taxonomy-sync-${operationId}`);
    manifest = createOperation(operationsDir, {
      operationId,
      type: 'taxonomy-sync',
      owner: { type: 'taxonomy-sync', operationId },
      extra: {
        rootDir,
        dbPath: resolveDbPath(db, rootDir),
        articlesDir,
        tempDir,
        stagingRoot
      }
    });
    maybePause(options);
    hooks.afterLockAcquired?.();

    const preDbHash = dbStateHash(db);
    const stagedFilesRoot = path.join(stagingRoot, 'files');
    fs.mkdirSync(stagedFilesRoot, { recursive: true });

    const files = [];
    for (const [index, rewrite] of plan.markdownRewrites.entries()) {
      const source = fileWithin(articlesDir, rewrite.path);
      const currentHash = fileSha256(source);
      if (currentHash !== rewrite.originalHash) {
        throw new OperationError('file_hash_mismatch', `source file changed since planning: ${rewrite.path}`);
      }
      const stagedPath = path.join(stagedFilesRoot, `${index}.md`);
      const rewrittenDocument = rewriteMarkdownTags(fs.readFileSync(source, 'utf8'), rewrite.tags);
      fs.writeFileSync(stagedPath, rewrittenDocument, { flag: 'wx' });
      // Durable staging: the payload must be on disk before any promotion.
      fsyncFile(stagedPath);
      const stagedHash = fileSha256(stagedPath);
      if (stagedHash !== rewrite.stagedHash) {
        throw new OperationError('file_hash_mismatch', `staged rewrite diverged from plan: ${rewrite.path}`);
      }
      files.push({
        path: rewrite.path,
        originalHash: rewrite.originalHash,
        stagedHash: rewrite.stagedHash,
        tombstone: `.taxonomy-sync-${operationId}-${index}.md`,
        stagedPath: path.relative(rootDir, stagedPath),
        tombstoned: false,
        promoted: false
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

    // Tombstone every original; the hash is verified immediately before the
    // rename so a concurrent writer cannot be silently overwritten. The parent
    // directory is fsynced after the rename and before the durable flag
    // update, so the manifest never claims a rename that is not durable.
    for (const file of files) {
      const source = sourcePath(manifest, file);
      hooks.beforeTombstone?.(file);
      const currentHash = fileSha256(source);
      if (currentHash !== file.originalHash) {
        throw new OperationError('file_hash_mismatch', `source file changed before tombstone: ${file.path}`);
      }
      fs.renameSync(source, tombstonePath(source, file));
      fsyncDirectory(path.dirname(source));
      hooks.afterTombstoneRename?.(file);
      injectFailure(options, 'tombstone-rename');
      maybePause(options);
      file.tombstoned = true;
      manifest = updateManifest(operationsDir, operationId, { files });
      hooks.afterTombstone?.(file);
      injectFailure(options, 'tombstone');
      maybePause(options);
    }

    // Promote every staged rewrite (refusing to clobber an unexpected
    // destination), verify the staged hash at the destination, and fsync the
    // destination directory before the durable promoted flag is written.
    for (const file of files) {
      const source = sourcePath(manifest, file);
      const stagedPath = fileWithin(manifest.rootDir, file.stagedPath);
      if (fs.existsSync(source)) {
        throw new OperationError('destination_collision', `destination already exists: ${file.path}`);
      }
      hooks.beforePromote?.(file);
      fs.renameSync(stagedPath, source);
      fsyncDirectory(path.dirname(source));
      const destinationHash = fileSha256(source);
      if (destinationHash !== file.stagedHash) {
        throw new OperationError('file_hash_mismatch', `promoted file hash mismatch: ${file.path}`);
      }
      file.promoted = true;
      manifest = updateManifest(operationsDir, operationId, { files });
      hooks.afterPromote?.(file);
      injectFailure(options, 'promote');
      maybePause(options);
    }

    manifest = updateManifest(operationsDir, operationId, { phase: 'files-promoted' });
    maybePause(options);

    hooks.beforeDbTransaction?.();
    commitDatabaseTransaction(db, plan, preDbHash, options);
    const actualPostDbHash = dbStateHash(db);
    dbCommitted = true;

    manifest = updateManifest(operationsDir, operationId, {
      phase: 'db-committed',
      postDbHash: actualPostDbHash
    });
    maybePause(options);

    // Cleanup: tombstones then staging, then finalize the journal.
    for (const file of files) {
      if (!file.tombstoned) continue;
      fs.rmSync(tombstonePath(sourcePath(manifest, file), file), { force: true });
    }
    removeStaging(manifest);
    hooks.afterCleanup?.();

    updateManifest(operationsDir, operationId, { phase: 'cleanup-complete', completedAt: new Date().toISOString() });
    removeJournal(operationsDir, operationId);
    return plan;
  } catch (error) {
    if (dbCommitted) {
      // The transaction committed; the journal stays as a recoverable
      // `db-committed` operation directory with lock evidence.
      throw new OperationError('cleanup_failed', `apply committed but cleanup failed: ${error.message}`, { cause: error });
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

/**
 * Recover an interrupted taxonomy-sync operation under the shared lock.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {string} operationId
 * @param {object} options - { operationsDir, pauseMs }
 * @returns {{ operationId: string, state: string }}
 */
function recoverTaxonomySync(db, operationId, options = {}) {
  validateOperationId(operationId);
  const operationsDir = path.resolve(options.operationsDir);
  acquireOperationLock(operationsDir, { type: 'taxonomy-sync', operationId }, { takeoverStaleIfOwner: operationId });

  const manifest = readManifest(operationsDir, operationId);
  if (!manifest) {
    releaseOperationLock(operationsDir);
    throw new OperationError('operation_not_found', `no operation ${operationId} exists to recover`);
  }
  validateManifest(manifest);

  // A crash in the lock-acquired phase has made no live changes; recovery may
  // remove it after verifying the recorded locations (pre-state by phase).
  if (manifest.phase === 'lock-acquired') {
    removeStaging(manifest);
    finalizeRecovery(operationsDir, operationId);
    return { operationId, state: 'pre-state-restored' };
  }
  if (manifest.phase === 'cleanup-complete') {
    finalizeRecovery(operationsDir, operationId);
    return { operationId, state: 'already-complete' };
  }

  const currentHash = dbStateHash(db);
  let dbState = 'ambiguous';
  if (currentHash === manifest.preDbHash) dbState = 'pre';
  else if (currentHash === manifest.postDbHash) dbState = 'post';

  try {
    if (dbState === 'pre') {
      // The database is untouched; a committed database can never be pre-state.
      if (manifest.phase === 'db-committed') {
        throw new OperationError('recovery_ambiguous', 'database is pre-state but the operation phase is db-committed');
      }
      verifyUntouchedSources(manifest);
      removeStaging(manifest);
      finalizeRecovery(operationsDir, operationId);
      return { operationId, state: 'pre-state-restored' };
    }
    if (dbState === 'post') {
      // The transaction committed; unpromoted files cannot precede the commit.
      if (manifest.phase === 'prepared') {
        throw new OperationError('recovery_ambiguous', 'database is post-state but files were never promoted');
      }
      finalizeCommittedOperation(manifest, operationsDir, operationId, options);
      finalizeRecovery(operationsDir, operationId);
      return { operationId, state: 'post-state-finalized' };
    }
  } catch (error) {
    // Refusals and I/O errors keep the journal and lock as evidence.
    if (error instanceof OperationError) throw error;
    throw new OperationError('recovery_ambiguous', `recovery could not complete: ${error.message}`, { cause: error });
  }

  throw new OperationError(
    'recovery_ambiguous',
    'database matches neither the recorded pre-state nor post-state; restore the complete same-point-in-time backup before retrying'
  );
}

function validateManifest(manifest) {
  validateOperationId(manifest.operationId);
  if (!OPERATION_PHASES.includes(manifest.phase)) {
    throw new OperationError('invalid_manifest', `invalid operation phase: ${JSON.stringify(manifest.phase)}`);
  }
  if (manifest.phase === 'lock-acquired') {
    if (!Array.isArray(manifest.files) || manifest.files.length > 0) {
      throw new OperationError('invalid_manifest', 'lock-acquired manifest must not describe live file changes');
    }
    return;
  }
  if (!manifest.articlesDir || !manifest.stagingRoot) {
    throw new OperationError('invalid_manifest', 'manifest is missing file locations');
  }
  for (const file of manifest.files || []) {
    sourcePath(manifest, file);
    validateTombstoneName(file.tombstone);
    fileWithin(manifest.rootDir, file.stagedPath);
  }
  if (!manifest.plan || typeof manifest.plan !== 'object') {
    throw new OperationError('invalid_manifest', 'manifest has no recorded plan');
  }
  if (typeof manifest.preDbHash !== 'string' || typeof manifest.postDbHash !== 'string') {
    throw new OperationError('invalid_manifest', 'manifest has no recorded pre/post database hashes');
  }
}

/**
 * Pre-state recovery: every recorded source must still match its original
 * hash. Files whose durable flag says they were tombstoned are restored from
 * the verified tombstone; files whose source is missing but whose tombstone is
 * hash-valid (crash between rename and flag persistence) are restored the same
 * way; any other mismatch refuses automated recovery.
 */
function verifyUntouchedSources(manifest) {
  for (const file of manifest.files || []) {
    if (file.tombstoned) {
      restoreSource(manifest, file);
    } else {
      verifyOrRestoreSource(manifest, file);
    }
  }
}

/**
 * Post-state recovery: the transaction committed, so verify every promoted
 * destination against its staged hash, drop tombstones/staging, and advance
 * the phase machine to cleanup-complete.
 */
function finalizeCommittedOperation(manifest, operationsDir, operationId, options) {
  for (const file of manifest.files || []) {
    const source = sourcePath(manifest, file);
    if (!file.promoted) {
      throw new OperationError('recovery_ambiguous', `database is post-state but ${file.path} was never promoted`);
    }
    const destinationHash = fileSha256(source);
    if (destinationHash !== file.stagedHash) {
      throw new OperationError('recovery_ambiguous', `promoted file hash mismatch for ${file.path}`);
    }
    if (file.tombstoned) {
      fs.rmSync(tombstonePath(source, file), { force: true });
    }
  }
  removeStaging(manifest);
  if (manifest.phase !== 'db-committed') {
    updateManifest(operationsDir, operationId, { phase: 'db-committed' });
  }
  updateManifest(operationsDir, operationId, { phase: 'cleanup-complete', completedAt: new Date().toISOString() });
  maybePause(options);
}

module.exports = {
  applyTaxonomySync,
  recoverTaxonomySync
};

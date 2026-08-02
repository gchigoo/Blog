'use strict';

/**
 * Durable operation journal shared by taxonomy sync and the later content
 * migration. Owns:
 *
 *  - the exclusive cross-process lock at `var/operations/active.lock`
 *    (a lock directory whose `owner.json` records the owning pid, type, and
 *    operation id; a dead owner is taken over only by the matching recovery
 *    flow through an atomic stale-lock rename),
 *  - per-operation manifest directories `var/operations/<operation-id>/`
 *    with the phase machine `lock-acquired -> prepared -> files-promoted ->
 *    db-committed -> cleanup-complete`,
 *  - deterministic sha256 hashes for DB rows and files that recovery compares
 *    against the manifest's pre/post state.
 *
 * The registry lives outside `uploads/temp`; generic upload-temp cleanup must
 * never touch it.
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const JOURNAL_SCHEMA = 1;
const OPERATION_TYPES = Object.freeze(['taxonomy-sync']);
const OPERATION_PHASES = Object.freeze([
  'lock-acquired',
  'prepared',
  'files-promoted',
  'db-committed',
  'cleanup-complete'
]);
const LOCK_DIRNAME = 'active.lock';
const MANIFEST_FILENAME = 'operation.json';
const OPERATION_ID_PATTERN = /^[a-z0-9-]+$/i;
const STALE_PREFIX = 'stale-';
const TOMBSTONE_PATTERN = /^\.taxonomy-sync-[a-z0-9-]+-\d+\.md$/i;

class OperationError extends Error {
  constructor(code, message, options = {}) {
    super(message);
    this.name = 'OperationError';
    this.code = code;
    if (options.plan !== undefined) this.plan = options.plan;
    if (options.cause !== undefined) this.cause = options.cause;
  }
}

function sha256Hex(input) {
  return crypto.createHash('sha256').update(input).digest('hex');
}

/**
 * Deterministic file hash: `sha256:<hex>` of the raw bytes.
 * Throws the underlying ENOENT when the file is missing.
 */
function fileSha256(filePath) {
  let handle;
  try {
    handle = fs.openSync(filePath, 'r');
    const hash = crypto.createHash('sha256');
    const buffer = Buffer.allocUnsafe(1 << 16);
    let bytesRead;
    while ((bytesRead = fs.readSync(handle, buffer, 0, buffer.length, null)) > 0) {
      hash.update(buffer.subarray(0, bytesRead));
    }
    return `sha256:${hash.digest('hex')}`;
  } finally {
    if (handle !== undefined) fs.closeSync(handle);
  }
}

const DB_HASH_TABLES = Object.freeze([
  ['categories', 'SELECT id, sort_order, origin FROM categories ORDER BY id'],
  ['category_labels', 'SELECT category_id, locale, name, slug FROM category_labels ORDER BY category_id, locale'],
  ['tags', 'SELECT id, category_id, sort_order, origin, is_system FROM tags ORDER BY id'],
  ['tag_labels', 'SELECT tag_id, locale, name, slug FROM tag_labels ORDER BY tag_id, locale'],
  ['article_tags', 'SELECT article_id, tag_id FROM article_tags ORDER BY article_id, tag_id'],
  ['articles', 'SELECT id, post_id, locale, slug FROM articles ORDER BY id'],
  ['article_fts', 'SELECT rowid, title, content, taxonomy FROM article_fts ORDER BY rowid']
]);

/**
 * Deterministic hash over every row the taxonomy apply touches (taxonomy
 * tables, normalized tag attachments, article identity, and the standalone
 * FTS). Recovery compares the current database against the manifest's
 * pre/post hashes.
 */
function dbStateHash(db) {
  const state = {};
  for (const [table, sql] of DB_HASH_TABLES) {
    state[table] = db.prepare(sql).all();
  }
  return `sha256:${sha256Hex(JSON.stringify(state))}`;
}

function fsyncFile(filePath) {
  const descriptor = fs.openSync(filePath, 'r');
  try {
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
}

function fsyncDirectory(directory) {
  const descriptor = fs.openSync(directory, 'r');
  try {
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
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

function validateOperationId(operationId) {
  if (typeof operationId !== 'string' || !OPERATION_ID_PATTERN.test(operationId)) {
    throw new OperationError('invalid_operation_id', `invalid operation id: ${JSON.stringify(operationId)}`);
  }
  return operationId;
}

function validateOperationType(type) {
  if (!OPERATION_TYPES.includes(type)) {
    throw new OperationError('invalid_operation_type', `invalid operation type: ${JSON.stringify(type)}`);
  }
  return type;
}

function lockDirectory(operationsDir) {
  return path.join(operationsDir, LOCK_DIRNAME);
}

function operationDirectory(operationsDir, operationId) {
  return path.join(operationsDir, validateOperationId(operationId));
}

function manifestFilePath(operationsDir, operationId) {
  return path.join(operationDirectory(operationsDir, operationId), MANIFEST_FILENAME);
}

function readLockOwner(lockDir) {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(lockDir, 'owner.json'), 'utf8'));
    if (!parsed || typeof parsed !== 'object' || !Number.isInteger(parsed.pid)) return null;
    return parsed;
  } catch {
    return null;
  }
}

function writeLockOwner(lockDir, owner) {
  const ownerPath = path.join(lockDir, 'owner.json');
  fs.writeFileSync(ownerPath, JSON.stringify({
    ...owner,
    pid: process.pid,
    hostname: os.hostname(),
    acquiredAt: new Date().toISOString()
  }, null, 2));
  fsyncFile(ownerPath);
}

/**
 * Acquire the shared operation lock as an exclusive lock directory.
 *
 * - A live owner throws `operation_busy`.
 * - A dead owner throws `operation_stale_lock` unless `takeoverStaleIfOwner`
 *   names exactly that operation; then the stale lock directory is renamed
 *   out of the way atomically before this process creates its own lock.
 */
function acquireOperationLock(operationsDir, owner, options = {}) {
  fs.mkdirSync(operationsDir, { recursive: true });
  const lockDir = lockDirectory(operationsDir);
  try {
    fs.mkdirSync(lockDir);
  } catch (error) {
    if (error.code !== 'EEXIST') {
      throw new OperationError('operation_lock_io', `cannot create operation lock: ${error.message}`, { cause: error });
    }
    const existingOwner = readLockOwner(lockDir);
    if (!existingOwner) {
      throw new OperationError('operation_stale_lock', 'operation lock exists but its owner metadata is unreadable');
    }
    if (pidAlive(existingOwner.pid)) {
      throw new OperationError(
        'operation_busy',
        `another operation is active (${existingOwner.operationId || 'unknown'}, pid ${existingOwner.pid})`
      );
    }
    const takeoverFor = options.takeoverStaleIfOwner;
    if (takeoverFor && existingOwner.operationId === takeoverFor) {
      const stalePath = path.join(operationsDir, `${STALE_PREFIX}${Date.now()}-${existingOwner.pid}.lock`);
      try {
        fs.renameSync(lockDir, stalePath);
      } catch (renameError) {
        if (renameError.code === 'ENOENT') {
          throw new OperationError('operation_busy', 'operation lock was taken by a concurrent recovery');
        }
        throw new OperationError('operation_lock_io', `cannot rename stale operation lock: ${renameError.message}`, { cause: renameError });
      }
      try {
        fs.mkdirSync(lockDir);
      } catch (mkdirError) {
        if (mkdirError.code === 'EEXIST') {
          throw new OperationError('operation_busy', 'operation lock was taken by a concurrent process');
        }
        throw new OperationError('operation_lock_io', `cannot recreate operation lock: ${mkdirError.message}`, { cause: mkdirError });
      }
    } else {
      throw new OperationError(
        'operation_stale_lock',
        `stale operation lock exists (owner ${existingOwner.operationId || 'unknown'}); run --recover first`
      );
    }
  }
  writeLockOwner(lockDir, owner);
  fsyncDirectory(operationsDir);
  return lockDir;
}

function releaseOperationLock(operationsDir) {
  try {
    fs.rmSync(lockDirectory(operationsDir), { recursive: true, force: true });
    fsyncDirectory(operationsDir);
  } catch (error) {
    throw new OperationError('operation_lock_io', `cannot release operation lock: ${error.message}`, { cause: error });
  }
}

function writeManifestAtomic(manifestPath, manifest) {
  const temporaryPath = `${manifestPath}.tmp`;
  fs.writeFileSync(temporaryPath, JSON.stringify(manifest, null, 2));
  fsyncFile(temporaryPath);
  fs.renameSync(temporaryPath, manifestPath);
  fsyncDirectory(path.dirname(manifestPath));
}

function readManifest(operationsDir, operationId) {
  const filePath = manifestFilePath(operationsDir, operationId);
  if (!fs.existsSync(filePath)) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

function createOperation(operationsDir, { operationId, type, owner, extra = {} }) {
  validateOperationType(type);
  const directory = operationDirectory(operationsDir, operationId);
  fs.mkdirSync(directory, { recursive: true });
  const manifest = {
    schema: JOURNAL_SCHEMA,
    operationId,
    type,
    owner,
    phase: 'lock-acquired',
    createdAt: new Date().toISOString(),
    rootDir: process.cwd(),
    dbPath: null,
    articlesDir: null,
    tempDir: null,
    operationsDir,
    plan: null,
    preDbHash: null,
    postDbHash: null,
    files: [],
    stagingRoot: null,
    completedAt: null,
    ...extra
  };
  writeManifestAtomic(manifestFilePath(operationsDir, operationId), manifest);
  return manifest;
}

function updateManifest(operationsDir, operationId, patch) {
  const manifest = readManifest(operationsDir, operationId);
  if (!manifest) throw new OperationError('operation_not_found', `operation ${operationId} has no manifest`);
  Object.assign(manifest, patch);
  writeManifestAtomic(manifestFilePath(operationsDir, operationId), manifest);
  return manifest;
}

/**
 * Operation directories currently present (excluding the live lock and any
 * renamed stale locks). A completed operation removes its directory, so any
 * remaining directory is incomplete evidence.
 */
function listOperations(operationsDir) {
  if (!fs.existsSync(operationsDir)) return [];
  return fs.readdirSync(operationsDir, { withFileTypes: true })
    .filter(entry => entry.isDirectory())
    .map(entry => entry.name)
    .filter(name => name !== LOCK_DIRNAME && !name.startsWith(STALE_PREFIX))
    .sort();
}

function removeOperation(operationsDir, operationId) {
  fs.rmSync(operationDirectory(operationsDir, operationId), { recursive: true, force: true });
}

/**
 * Remove renamed stale lock directories (`stale-*`) whose owner process is
 * confirmed dead. Called only after a successful recovery has already taken
 * the matching lock over; dead lock dirs are lock evidence, not operation
 * evidence (the operation directory itself is retained on refusal).
 */
function cleanupStaleLocks(operationsDir) {
  if (!fs.existsSync(operationsDir)) return;
  for (const name of fs.readdirSync(operationsDir, { withFileTypes: true })
    .filter(entry => entry.isDirectory())
    .map(entry => entry.name)
    .filter(name => name.startsWith(STALE_PREFIX))) {
    const owner = readLockOwner(path.join(operationsDir, name));
    if (owner && !pidAlive(owner.pid)) {
      fs.rmSync(path.join(operationsDir, name), { recursive: true, force: true });
    }
  }
}

function nextOperationId() {
  return crypto.randomUUID();
}

function syncSleep(milliseconds) {
  if (!Number.isFinite(milliseconds) || milliseconds <= 0) return;
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

module.exports = {
  JOURNAL_SCHEMA,
  LOCK_DIRNAME,
  MANIFEST_FILENAME,
  OPERATION_ID_PATTERN,
  OPERATION_PHASES,
  OPERATION_TYPES,
  STALE_PREFIX,
  TOMBSTONE_PATTERN,
  OperationError,
  acquireOperationLock,
  cleanupStaleLocks,
  createOperation,
  dbStateHash,
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
  validateOperationType,
  writeManifestAtomic
};

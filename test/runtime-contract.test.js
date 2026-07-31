const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const test = require('node:test');
const Database = require('better-sqlite3');

const { LATEST_SCHEMA_VERSION, migrateDatabase } = require('../server/migrations');
const config = require('../server/config');
const { validateRuntimePaths } = require('../server/utils/runtime-paths');

const root = path.resolve(__dirname, '..');

test('project declares the Node 24 runtime and built-in test runner', () => {
  const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const nvmrc = fs.readFileSync(path.join(root, '.nvmrc'), 'utf8').trim();

  assert.equal(packageJson.engines.node, '>=24 <25');
  assert.equal(packageJson.scripts.test, 'node --test test/*.test.js');
  assert.equal(nvmrc, '24');
  assert.equal(Number(process.versions.node.split('.')[0]), 24);
});

test('runtime config defaults to loopback and validates the listen host', () => {
  const baseEnv = {
    JWT_SECRET: 'test-only-jwt-secret-with-at-least-32-characters',
    ANALYTICS_HMAC_SECRET: Buffer.alloc(32, 7).toString('base64url')
  };

  assert.equal(config.loadRuntimeConfig(baseEnv).host, '127.0.0.1');
  assert.equal(config.loadRuntimeConfig({ ...baseEnv, BLOG_LISTEN_HOST: '::1' }).host, '::1');
  assert.throws(
    () => config.loadRuntimeConfig({ ...baseEnv, BLOG_LISTEN_HOST: '0.0.0.0' }),
    /BLOG_LISTEN_HOST/
  );
});

test('database migration applies analytics traffic schema version 2 idempotently', () => {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE articles (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      slug TEXT UNIQUE NOT NULL,
      content TEXT NOT NULL,
      html TEXT NOT NULL,
      tags TEXT,
      created_at TEXT,
      updated_at TEXT
    );
    CREATE TABLE access_metrics (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      bucket_utc TEXT NOT NULL,
      path TEXT NOT NULL,
      visitor_day_hmac TEXT NOT NULL,
      device_kind TEXT NOT NULL
    );
    CREATE TABLE access_event_details (
      metric_id INTEGER PRIMARY KEY REFERENCES access_metrics(id) ON DELETE CASCADE,
      event_id TEXT UNIQUE NOT NULL,
      observed_at_utc TEXT NOT NULL,
      ip_address TEXT NOT NULL
    );
    INSERT INTO access_metrics (bucket_utc, path, visitor_day_hmac, device_kind)
    VALUES ('2026-07-01T00:00:00.000Z', '/legacy', 'legacy', 'desktop');
  `);

  assert.equal(LATEST_SCHEMA_VERSION, 2);
  assert.equal(migrateDatabase(db), 2);
  assert.equal(migrateDatabase(db), 2);
  assert.deepEqual(
    db.prepare('SELECT version FROM schema_migrations ORDER BY version').all().map(row => row.version),
    [1, 2]
  );
  assert.equal(
    db.prepare("SELECT traffic_kind FROM access_metrics WHERE path = '/legacy'").get().traffic_kind,
    'human'
  );
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM schema_migrations WHERE version = 2').get().count, 1);
  for (const name of [
    'idx_access_metrics_traffic_bucket',
    'idx_event_details_traffic_observed',
    'idx_event_details_traffic_ip_observed'
  ]) {
    assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = ?").get(name));
  }
  for (const name of [
    'analytics_detail_traffic_insert_guard',
    'analytics_detail_traffic_update_guard',
    'analytics_metric_traffic_update_guard'
  ]) {
    assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'trigger' AND name = ?").get(name));
  }
  db.close();
});

test('runtime path validation creates writable data directories and requires About content', t => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'blog-runtime-paths-'));
  t.after(() => fs.rmSync(fixture, { recursive: true, force: true }));
  fs.mkdirSync(path.join(fixture, 'content'));
  fs.writeFileSync(path.join(fixture, 'content/about.md'), '# About');
  const config = {
    uploadDir: 'uploads/temp', imagesDir: 'public/images', audioDir: 'public/audio',
    articlesDir: 'articles', aboutPath: 'content/about.md'
  };
  assert.equal(validateRuntimePaths(config, fixture), true);
  for (const directory of ['uploads/temp', 'public/images', 'public/audio', 'articles']) {
    assert.equal(fs.statSync(path.join(fixture, directory)).isDirectory(), true);
  }
  fs.rmSync(path.join(fixture, 'content/about.md'));
  assert.throws(() => validateRuntimePaths(config, fixture), /ENOENT/);
});

const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');
const bcrypt = require('bcrypt');
const Database = require('better-sqlite3');
const { createProjectFixture, runNode } = require('./helpers/project-fixture');

const STRONG_PASSWORD = 'S3cure!Node24';

function readAdmin(root) {
  const db = new Database(path.join(root, 'blog.db'));
  try {
    return db.prepare('SELECT username, password_hash FROM users WHERE username = ?').get('admin');
  } finally {
    db.close();
  }
}

test('empty database refuses initialization when INITIAL_ADMIN_PASSWORD is missing', async t => {
  const root = await createProjectFixture(t);
  const result = runNode(root, 'server/scripts/init-db.js', [], {
    INITIAL_ADMIN_PASSWORD: ''
  });

  assert.notEqual(result.status, 0, `unexpected success:\n${result.stdout}`);
  const admin = readAdmin(root);
  assert.equal(admin, undefined);
  assert.doesNotMatch(`${result.stdout}${result.stderr}`, /admin123/);
});

test('empty database refuses a weak initial administrator password', async t => {
  const root = await createProjectFixture(t);
  const result = runNode(root, 'server/scripts/init-db.js', [], {
    INITIAL_ADMIN_PASSWORD: 'admin123'
  });

  assert.notEqual(result.status, 0, `unexpected success:\n${result.stdout}`);
  assert.equal(readAdmin(root), undefined);
});

test('strong initial password creates admin without logging the secret', async t => {
  const root = await createProjectFixture(t);
  const result = runNode(root, 'server/scripts/init-db.js', [], {
    INITIAL_ADMIN_PASSWORD: STRONG_PASSWORD
  });

  assert.equal(result.status, 0, result.stderr);
  const admin = readAdmin(root);
  assert.ok(admin);
  assert.equal(bcrypt.compareSync(STRONG_PASSWORD, admin.password_hash), true);
  assert.doesNotMatch(`${result.stdout}${result.stderr}`, new RegExp(STRONG_PASSWORD));
});

test('CLI password change rejects a weak password without changing the hash', async t => {
  const root = await createProjectFixture(t);
  const db = new Database(path.join(root, 'blog.db'));
  db.exec(`
    CREATE TABLE users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);
  const originalHash = bcrypt.hashSync(STRONG_PASSWORD, 10);
  db.prepare('INSERT INTO users (username, password_hash) VALUES (?, ?)')
    .run('admin', originalHash);
  db.close();

  const result = runNode(root, 'scripts/change-password.js', ['short']);
  assert.notEqual(result.status, 0, `unexpected success:\n${result.stdout}`);
  assert.equal(readAdmin(root).password_hash, originalHash);
});

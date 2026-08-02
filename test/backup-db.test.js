const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const Database = require('better-sqlite3');
const { createProjectFixture, runNode } = require('./helpers/project-fixture');

const INITIAL_PASSWORD = 'S3cure!Node24';

test('backup includes committed WAL data and passes integrity verification', async t => {
  const root = await createProjectFixture(t);
  const init = runNode(root, 'server/scripts/init-db.js', [], {
    INITIAL_ADMIN_PASSWORD: INITIAL_PASSWORD
  });
  assert.equal(init.status, 0, init.stderr);

  const source = new Database(path.join(root, 'blog.db'));
  try {
    source.pragma('journal_mode = WAL');
    source.pragma('wal_autocheckpoint = 0');
    const postId = Number(source.prepare(`
      INSERT INTO posts (translation_key, created_at, updated_at)
      VALUES ('wal-article', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')
    `).run().lastInsertRowid);
    source.prepare(`
      INSERT INTO articles (post_id, locale, title, slug, content, html, status, created_at, updated_at)
      VALUES (?, 'zh', 'WAL article', 'wal-article', 'body', '<p>body</p>', 'published',
              '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')
    `).run(postId);

    const result = runNode(root, 'scripts/backup-db.js');
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);

    const files = fs.readdirSync(path.join(root, 'backups'));
    const backups = files.filter(file => file.endsWith('.db'));
    assert.equal(backups.length, 1);
    assert.equal(files.some(file => file.endsWith('.tmp')), false);

    const backup = new Database(path.join(root, 'backups', backups[0]), {
      readonly: true,
      fileMustExist: true
    });
    try {
      assert.equal(backup.pragma('integrity_check', { simple: true }), 'ok');
      assert.equal(
        backup.prepare('SELECT title FROM articles WHERE slug = ?').get('wal-article').title,
        'WAL article'
      );
    } finally {
      backup.close();
    }
  } finally {
    source.close();
  }
});

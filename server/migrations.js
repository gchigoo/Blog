const { migrateAnalyticsTrafficSchema } = require('./analytics/traffic-schema');
const { migrateLocalizedArticleSchema } = require('./articles/schema');

const LATEST_SCHEMA_VERSION = 3;

function columnNames(db, table) {
  return new Set(db.prepare(`PRAGMA table_info(${table})`).all().map(column => column.name));
}

function applyArticleSearchMigration(db) {
  const columns = columnNames(db, 'articles');
  if (!columns.has('status')) {
    db.exec("ALTER TABLE articles ADD COLUMN status TEXT NOT NULL DEFAULT 'published' CHECK (status IN ('draft', 'published'))");
  }
  if (!columns.has('description')) {
    db.exec('ALTER TABLE articles ADD COLUMN description TEXT');
  }

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_articles_status_created
      ON articles(status, created_at DESC, id DESC);

    CREATE TABLE IF NOT EXISTS article_tags (
      article_id INTEGER NOT NULL REFERENCES articles(id) ON DELETE CASCADE,
      tag TEXT NOT NULL,
      PRIMARY KEY (article_id, tag)
    );
    CREATE INDEX IF NOT EXISTS idx_article_tags_tag_article
      ON article_tags(tag, article_id);

    CREATE VIRTUAL TABLE IF NOT EXISTS article_fts USING fts5(
      title,
      content,
      tags,
      content='articles',
      content_rowid='id'
    );

    CREATE TRIGGER IF NOT EXISTS articles_search_ai AFTER INSERT ON articles BEGIN
      INSERT INTO article_fts(rowid, title, content, tags)
      VALUES (new.id, new.title, new.content, COALESCE(new.tags, ''));
      INSERT OR IGNORE INTO article_tags(article_id, tag)
      SELECT new.id, trim(value)
      FROM json_each(CASE WHEN json_valid(new.tags) THEN new.tags ELSE '[]' END)
      WHERE type = 'text' AND trim(value) <> '';
    END;

    CREATE TRIGGER IF NOT EXISTS articles_search_ad AFTER DELETE ON articles BEGIN
      INSERT INTO article_fts(article_fts, rowid, title, content, tags)
      VALUES ('delete', old.id, old.title, old.content, COALESCE(old.tags, ''));
      DELETE FROM article_tags WHERE article_id = old.id;
    END;

    CREATE TRIGGER IF NOT EXISTS articles_search_au AFTER UPDATE ON articles BEGIN
      INSERT INTO article_fts(article_fts, rowid, title, content, tags)
      VALUES ('delete', old.id, old.title, old.content, COALESCE(old.tags, ''));
      INSERT INTO article_fts(rowid, title, content, tags)
      VALUES (new.id, new.title, new.content, COALESCE(new.tags, ''));
      DELETE FROM article_tags WHERE article_id = old.id;
      INSERT OR IGNORE INTO article_tags(article_id, tag)
      SELECT new.id, trim(value)
      FROM json_each(CASE WHEN json_valid(new.tags) THEN new.tags ELSE '[]' END)
      WHERE type = 'text' AND trim(value) <> '';
    END;
  `);

  db.exec(`
    DELETE FROM article_tags;
    INSERT OR IGNORE INTO article_tags(article_id, tag)
    SELECT articles.id, trim(json_each.value)
    FROM articles, json_each(CASE WHEN json_valid(articles.tags) THEN articles.tags ELSE '[]' END)
    WHERE json_each.type = 'text' AND trim(json_each.value) <> '';
    INSERT INTO article_fts(article_fts) VALUES ('rebuild');
  `);
}

/**
 * Schema v3 rebuilds tables behind foreign keys. SQLite requires foreign keys
 * to be disabled before the DDL (the legacy articles table is dropped and
 * `articles_v3` is renamed into place), and child foreign keys are only
 * verified afterwards with `PRAGMA foreign_key_check` inside the transaction.
 */
function applyWithForeignKeysOff(db, migration, options) {
  if (db.inTransaction) {
    throw new Error(`migration ${migration.version} requires no active transaction`);
  }
  db.pragma('foreign_keys = OFF');
  try {
    db.transaction(() => {
      migration.apply(db, options);
      const violations = db.prepare('PRAGMA foreign_key_check').all();
      if (violations.length > 0) {
        const detail = violations.map(violation => JSON.stringify(violation)).join('; ');
        throw new Error(`foreign key violations after migration ${migration.version}: ${detail}`);
      }
      db.prepare('INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)')
        .run(migration.version, new Date().toISOString());
    })();
  } finally {
    db.pragma('foreign_keys = ON');
  }
  if (db.pragma('foreign_keys', { simple: true }) !== 1) {
    throw new Error(`foreign_keys must be enabled after migration ${migration.version}`);
  }
}

function migrateDatabase(db, options = {}) {
  // Versioned migrations own article table creation: a fresh database gets the
  // legacy base table here so versions 1 -> 2 -> 3 can run without duplicate
  // DDL in the initializer.
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS articles (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      slug TEXT UNIQUE NOT NULL,
      content TEXT NOT NULL,
      html TEXT NOT NULL,
      tags TEXT,
      created_at TEXT,
      updated_at TEXT
    );
  `);
  const applied = new Set(db.prepare('SELECT version FROM schema_migrations').all().map(row => row.version));
  const migrations = /** @type {Array<{version: number, foreignKeysOff: boolean, apply: (db: any, options?: any) => void}>} */ (
    [
      { version: 1, foreignKeysOff: false, apply: applyArticleSearchMigration },
      { version: 2, foreignKeysOff: false, apply: migrateAnalyticsTrafficSchema },
      { version: 3, foreignKeysOff: true, apply: migrateLocalizedArticleSchema }
    ]
  );
  for (const migration of migrations) {
    if (applied.has(migration.version)) continue;
    if (migration.foreignKeysOff) {
      applyWithForeignKeysOff(db, migration, options);
    } else {
      db.transaction(() => {
        migration.apply(db, options);
        db.prepare('INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)')
          .run(migration.version, new Date().toISOString());
      })();
    }
  }
  return LATEST_SCHEMA_VERSION;
}

module.exports = { LATEST_SCHEMA_VERSION, migrateDatabase };

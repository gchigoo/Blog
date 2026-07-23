const LATEST_SCHEMA_VERSION = 1;

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

function migrateDatabase(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL
    )
  `);
  const applied = new Set(db.prepare('SELECT version FROM schema_migrations').all().map(row => row.version));
  const migrations = /** @type {Array<[number, (database: any) => void]>} */ (
    [[1, applyArticleSearchMigration]]
  );
  const apply = db.transaction(() => {
    for (const [version, migration] of migrations) {
      if (applied.has(version)) continue;
      migration(db);
      db.prepare('INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)')
        .run(version, new Date().toISOString());
    }
  });
  apply();
  return LATEST_SCHEMA_VERSION;
}

module.exports = { LATEST_SCHEMA_VERSION, migrateDatabase };

function normalizeDisplayName(value) {
  const withoutControls = typeof value === 'string'
    ? value.replace(/\p{Cc}/gu, '').trim()
    : '';
  return Array.from(withoutControls).slice(0, 80).join('') || '读者';
}

function createCommentIdentityStore(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS comment_users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      google_sub TEXT NOT NULL UNIQUE,
      display_name TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      last_login_at TEXT NOT NULL
    )
  `);

  const upsertStatement = db.prepare(`
    INSERT INTO comment_users (
      google_sub, display_name, created_at, updated_at, last_login_at
    ) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(google_sub) DO UPDATE SET
      display_name = excluded.display_name,
      updated_at = excluded.updated_at,
      last_login_at = excluded.last_login_at
    RETURNING id, display_name
  `);
  const findStatement = db.prepare(`
    SELECT id, display_name
    FROM comment_users
    WHERE id = ?
  `);

  return Object.freeze({
    upsertIdentity(identity, timestamp) {
      if (typeof identity?.subject !== 'string'
        || identity.subject.length === 0
        || identity.subject.length > 255) {
        return null;
      }
      return upsertStatement.get(
        identity.subject,
        normalizeDisplayName(identity.displayName),
        timestamp,
        timestamp,
        timestamp
      );
    },

    findById(id) {
      return findStatement.get(id) || null;
    }
  });
}

module.exports = {
  createCommentIdentityStore,
  normalizeDisplayName
};

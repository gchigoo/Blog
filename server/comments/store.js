const { createHash } = require('node:crypto');
const { createCommentIdentityStore } = require('./identity-store');

const COMMENT_STATUSES = new Set(['pending', 'approved', 'rejected']);
const REVIEW_STATUSES = new Set(['approved', 'rejected']);
const DEFAULT_RATE_LIMIT = 5;
const DEFAULT_RATE_WINDOW_MS = 10 * 60 * 1000;

class CommentStoreError extends Error {
  constructor(code) {
    super(code);
    this.name = 'CommentStoreError';
    this.code = code;
  }
}

function mapComment(row) {
  if (!row) return null;
  return {
    id: row.id,
    articleId: row.article_id,
    commenterId: row.comment_user_id,
    content: row.content,
    status: row.status,
    createdAt: row.created_at,
    reviewedAt: row.reviewed_at,
    reviewedBy: row.reviewed_by,
    ...(row.display_name !== undefined ? { displayName: row.display_name } : {}),
    ...(row.article_title !== undefined ? { articleTitle: row.article_title } : {}),
    ...(row.article_slug !== undefined ? { articleSlug: row.article_slug } : {})
  };
}

function hashOAuthTokenId(tokenId) {
  if (typeof tokenId !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(tokenId)) {
    throw new TypeError('tokenId must be a 32-byte base64url value');
  }
  return createHash('sha256').update(tokenId, 'ascii').digest('hex');
}

function requireIsoTimestamp(value, name) {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) {
    throw new TypeError(`${name} must be an ISO date`);
  }
}

function createCommentStore(db, {
  rateLimit = DEFAULT_RATE_LIMIT,
  rateWindowMs = DEFAULT_RATE_WINDOW_MS
} = {}) {
  const identities = createCommentIdentityStore(db);

  db.exec(`
    CREATE TABLE IF NOT EXISTS comment_oauth_contexts (
      token_id_hash TEXT PRIMARY KEY CHECK (length(token_id_hash) = 64),
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      consumed_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_comment_oauth_contexts_expires
      ON comment_oauth_contexts(expires_at);

    CREATE TABLE IF NOT EXISTS comments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      article_id INTEGER NOT NULL REFERENCES articles(id) ON DELETE CASCADE,
      comment_user_id INTEGER NOT NULL REFERENCES comment_users(id) ON DELETE RESTRICT,
      content TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'approved', 'rejected')),
      created_at TEXT NOT NULL,
      reviewed_at TEXT,
      reviewed_by INTEGER REFERENCES users(id) ON DELETE SET NULL
    );
    CREATE INDEX IF NOT EXISTS idx_comments_article_status_created
      ON comments(article_id, status, created_at);
    CREATE INDEX IF NOT EXISTS idx_comments_user_created
      ON comments(comment_user_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_comments_status_created
      ON comments(status, created_at);
  `);

  const findArticle = db.prepare('SELECT id FROM articles WHERE id = ?');
  const deleteExpiredOAuthContexts = db.prepare(`
    DELETE FROM comment_oauth_contexts
    WHERE expires_at <= ?
  `);
  const insertOAuthContext = db.prepare(`
    INSERT INTO comment_oauth_contexts (
      token_id_hash, created_at, expires_at, consumed_at
    ) VALUES (?, ?, ?, NULL)
  `);
  const consumeOAuthContext = db.prepare(`
    UPDATE comment_oauth_contexts
    SET consumed_at = ?
    WHERE token_id_hash = ?
      AND consumed_at IS NULL
      AND expires_at > ?
  `);
  const countRecent = db.prepare(`
    SELECT COUNT(*) AS count
    FROM comments
    WHERE comment_user_id = ? AND created_at >= ?
  `);
  const insertComment = db.prepare(`
    INSERT INTO comments (article_id, comment_user_id, content, status, created_at)
    VALUES (?, ?, ?, 'pending', ?)
    RETURNING *
  `);
  const findComment = db.prepare('SELECT * FROM comments WHERE id = ?');
  const updateReview = db.prepare(`
    UPDATE comments
    SET status = ?, reviewed_at = ?, reviewed_by = ?
    WHERE id = ?
    RETURNING *
  `);
  const deleteCommentStatement = db.prepare('DELETE FROM comments WHERE id = ?');
  const listApproved = db.prepare(`
    SELECT comments.*, comment_users.display_name
    FROM comments
    JOIN comment_users ON comment_users.id = comments.comment_user_id
    WHERE comments.article_id = ? AND comments.status = 'approved'
    ORDER BY comments.created_at ASC, comments.id ASC
  `);
  const listModeration = db.prepare(`
    SELECT
      comments.*,
      comment_users.display_name,
      articles.title AS article_title,
      articles.slug AS article_slug
    FROM comments
    JOIN comment_users ON comment_users.id = comments.comment_user_id
    JOIN articles ON articles.id = comments.article_id
    WHERE comments.status = ?
    ORDER BY comments.created_at ASC, comments.id ASC
  `);

  const createPendingTransaction = db.transaction(({
    articleId,
    commenterId,
    content,
    createdAt
  }) => {
    if (!findArticle.get(articleId)) {
      throw new CommentStoreError('article_not_found');
    }
    const createdAtMs = Date.parse(createdAt);
    if (!Number.isFinite(createdAtMs)) {
      throw new TypeError('createdAt must be an ISO date');
    }
    const windowStart = new Date(createdAtMs - rateWindowMs).toISOString();
    if (countRecent.get(commenterId, windowStart).count >= rateLimit) {
      throw new CommentStoreError('rate_limited');
    }
    return mapComment(insertComment.get(articleId, commenterId, content, createdAt));
  });
  const registerOAuthContextTransaction = db.transaction(({
    tokenId,
    createdAt,
    expiresAt
  }) => {
    requireIsoTimestamp(createdAt, 'createdAt');
    requireIsoTimestamp(expiresAt, 'expiresAt');
    if (Date.parse(expiresAt) <= Date.parse(createdAt)) {
      throw new TypeError('expiresAt must be after createdAt');
    }
    deleteExpiredOAuthContexts.run(createdAt);
    insertOAuthContext.run(hashOAuthTokenId(tokenId), createdAt, expiresAt);
  });

  return Object.freeze({
    ...identities,

    registerOAuthContext(input) {
      registerOAuthContextTransaction(input);
    },

    consumeOAuthContext({ tokenId, consumedAt }) {
      requireIsoTimestamp(consumedAt, 'consumedAt');
      return consumeOAuthContext.run(
        consumedAt,
        hashOAuthTokenId(tokenId),
        consumedAt
      ).changes === 1;
    },

    createPendingComment(input) {
      return createPendingTransaction(input);
    },

    listApprovedByArticle(articleId) {
      return listApproved.all(articleId).map(mapComment);
    },

    listForModeration(status) {
      if (!COMMENT_STATUSES.has(status)) {
        throw new CommentStoreError('invalid_status');
      }
      return listModeration.all(status).map(mapComment);
    },

    reviewComment({ commentId, targetStatus, reviewerId, reviewedAt }) {
      if (targetStatus === 'pending') {
        throw new CommentStoreError('invalid_transition');
      }
      if (!REVIEW_STATUSES.has(targetStatus)) {
        throw new CommentStoreError('invalid_status');
      }
      const current = findComment.get(commentId);
      if (!current) {
        throw new CommentStoreError('comment_not_found');
      }
      if (current.status === targetStatus) {
        return mapComment(current);
      }
      return mapComment(updateReview.get(
        targetStatus,
        reviewedAt,
        reviewerId,
        commentId
      ));
    },

    deleteComment(commentId) {
      return deleteCommentStatement.run(commentId).changes === 1;
    }
  });
}

module.exports = {
  CommentStoreError,
  createCommentStore
};

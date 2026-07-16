const assert = require('node:assert/strict');
const test = require('node:test');
const Database = require('better-sqlite3');
const { CommentStoreError, createCommentStore } = require('../server/comments/store');

function createFixture(t) {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE articles (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      slug TEXT NOT NULL UNIQUE
    );
    CREATE TABLE users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL UNIQUE
    );
    INSERT INTO articles (title, slug) VALUES ('First', 'first'), ('Second', 'second');
    INSERT INTO users (username) VALUES ('admin-one'), ('admin-two');
  `);
  const store = createCommentStore(db);
  t.after(() => db.close());
  return { db, store };
}

function createCommenter(store, subject = 'subject-1', displayName = 'Reader', timestamp = '2026-07-16T00:00:00.000Z') {
  return store.upsertIdentity({ subject, displayName }, timestamp);
}

test('comment schema has isolated users, constraints, and required indexes', t => {
  const { db, store } = createFixture(t);
  const first = createCommenter(store, 'stable-subject', 'First Name');
  const second = createCommenter(
    store,
    'stable-subject',
    'Updated Name',
    '2026-07-16T01:00:00.000Z'
  );

  assert.equal(first.id, second.id);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM comment_users').get().count, 1);
  assert.deepEqual(
    db.prepare('SELECT display_name, created_at, updated_at, last_login_at FROM comment_users').get(),
    {
      display_name: 'Updated Name',
      created_at: '2026-07-16T00:00:00.000Z',
      updated_at: '2026-07-16T01:00:00.000Z',
      last_login_at: '2026-07-16T01:00:00.000Z'
    }
  );

  const indexes = db.prepare("SELECT name FROM sqlite_master WHERE type = 'index'").all()
    .map(row => row.name);
  assert.ok(indexes.includes('idx_comments_article_status_created'));
  assert.ok(indexes.includes('idx_comments_user_created'));
  assert.ok(indexes.includes('idx_comments_status_created'));
});

test('OAuth contexts are stored as hashes and consumed once across store instances', t => {
  const { db, store } = createFixture(t);
  const tokenId = 'A'.repeat(43);
  store.registerOAuthContext({
    tokenId,
    createdAt: '2026-07-16T00:00:00.000Z',
    expiresAt: '2026-07-16T00:10:00.000Z'
  });

  const row = db.prepare('SELECT * FROM comment_oauth_contexts').get();
  assert.equal(row.token_id_hash.length, 64);
  assert.notEqual(row.token_id_hash, tokenId);
  assert.equal(JSON.stringify(row).includes(tokenId), false);

  const restartedStore = createCommentStore(db);
  assert.equal(restartedStore.consumeOAuthContext({
    tokenId,
    consumedAt: '2026-07-16T00:01:00.000Z'
  }), true);
  assert.equal(store.consumeOAuthContext({
    tokenId,
    consumedAt: '2026-07-16T00:02:00.000Z'
  }), false);
});

test('new comments are pending and public reads return only approved comments in stable order', t => {
  const { store } = createFixture(t);
  const commenter = createCommenter(store);
  const first = store.createPendingComment({
    articleId: 1,
    commenterId: commenter.id,
    content: 'first pending',
    createdAt: '2026-07-16T00:00:00.000Z'
  });
  const second = store.createPendingComment({
    articleId: 1,
    commenterId: commenter.id,
    content: 'second pending',
    createdAt: '2026-07-16T00:00:00.000Z'
  });
  const otherArticle = store.createPendingComment({
    articleId: 2,
    commenterId: commenter.id,
    content: 'other article',
    createdAt: '2026-07-16T00:00:01.000Z'
  });

  assert.equal(first.status, 'pending');
  assert.deepEqual(store.listApprovedByArticle(1), []);
  store.reviewComment({
    commentId: second.id,
    targetStatus: 'approved',
    reviewerId: 1,
    reviewedAt: '2026-07-16T01:00:00.000Z'
  });
  store.reviewComment({
    commentId: first.id,
    targetStatus: 'approved',
    reviewerId: 1,
    reviewedAt: '2026-07-16T01:00:01.000Z'
  });
  store.reviewComment({
    commentId: otherArticle.id,
    targetStatus: 'approved',
    reviewerId: 1,
    reviewedAt: '2026-07-16T01:00:02.000Z'
  });

  assert.deepEqual(
    store.listApprovedByArticle(1).map(comment => comment.content),
    ['first pending', 'second pending']
  );
});

test('moderation transitions update metadata, preserve idempotency, and reject pending rollback', t => {
  const { store } = createFixture(t);
  const commenter = createCommenter(store);
  const comment = store.createPendingComment({
    articleId: 1,
    commenterId: commenter.id,
    content: 'review me',
    createdAt: '2026-07-16T00:00:00.000Z'
  });

  const approved = store.reviewComment({
    commentId: comment.id,
    targetStatus: 'approved',
    reviewerId: 1,
    reviewedAt: '2026-07-16T01:00:00.000Z'
  });
  const idempotent = store.reviewComment({
    commentId: comment.id,
    targetStatus: 'approved',
    reviewerId: 2,
    reviewedAt: '2026-07-16T02:00:00.000Z'
  });
  assert.equal(idempotent.reviewedBy, approved.reviewedBy);
  assert.equal(idempotent.reviewedAt, approved.reviewedAt);

  const rejected = store.reviewComment({
    commentId: comment.id,
    targetStatus: 'rejected',
    reviewerId: 2,
    reviewedAt: '2026-07-16T03:00:00.000Z'
  });
  assert.equal(rejected.status, 'rejected');
  assert.equal(rejected.reviewedBy, 2);
  assert.equal(rejected.reviewedAt, '2026-07-16T03:00:00.000Z');

  const reapproved = store.reviewComment({
    commentId: comment.id,
    targetStatus: 'approved',
    reviewerId: 1,
    reviewedAt: '2026-07-16T04:00:00.000Z'
  });
  assert.equal(reapproved.status, 'approved');
  assert.equal(reapproved.reviewedBy, 1);

  assert.throws(
    () => store.reviewComment({
      commentId: comment.id,
      targetStatus: 'pending',
      reviewerId: 1,
      reviewedAt: '2026-07-16T05:00:00.000Z'
    }),
    error => error instanceof CommentStoreError && error.code === 'invalid_transition'
  );
});

test('rate-limit check and pending insert share one transaction', t => {
  const { db, store } = createFixture(t);
  const commenter = createCommenter(store);
  const created = [];

  for (let index = 0; index < 5; index += 1) {
    created.push(store.createPendingComment({
      articleId: 1,
      commenterId: commenter.id,
      content: `comment ${index}`,
      createdAt: `2026-07-16T00:0${index}:00.000Z`
    }));
  }

  assert.throws(
    () => store.createPendingComment({
      articleId: 1,
      commenterId: commenter.id,
      content: 'sixth comment',
      createdAt: '2026-07-16T00:05:00.000Z'
    }),
    error => error instanceof CommentStoreError && error.code === 'rate_limited'
  );
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM comments').get().count, 5);

  assert.equal(store.deleteComment(created[0].id), true);
  store.createPendingComment({
    articleId: 1,
    commenterId: commenter.id,
    content: 'replacement after admin deletion',
    createdAt: '2026-07-16T00:05:00.000Z'
  });
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM comments').get().count, 5);

  store.createPendingComment({
    articleId: 1,
    commenterId: commenter.id,
    content: 'outside window',
    createdAt: '2026-07-16T00:14:01.000Z'
  });
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM comments').get().count, 6);

  assert.throws(
    () => store.createPendingComment({
      articleId: 999,
      commenterId: commenter.id,
      content: 'missing article',
      createdAt: '2026-07-16T01:00:00.000Z'
    }),
    error => error instanceof CommentStoreError && error.code === 'article_not_found'
  );
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM comments').get().count, 6);
});

test('hard deletion is irreversible and article deletion cascades while commenter deletion is restricted', t => {
  const { db, store } = createFixture(t);
  const commenter = createCommenter(store);
  const deleted = store.createPendingComment({
    articleId: 1,
    commenterId: commenter.id,
    content: 'delete me',
    createdAt: '2026-07-16T00:00:00.000Z'
  });
  const cascaded = store.createPendingComment({
    articleId: 2,
    commenterId: commenter.id,
    content: 'cascade me',
    createdAt: '2026-07-16T00:00:01.000Z'
  });

  assert.throws(() => db.prepare('DELETE FROM comment_users WHERE id = ?').run(commenter.id));

  assert.equal(store.deleteComment(deleted.id), true);
  assert.equal(store.deleteComment(deleted.id), false);
  assert.throws(
    () => store.reviewComment({
      commentId: deleted.id,
      targetStatus: 'approved',
      reviewerId: 1,
      reviewedAt: '2026-07-16T01:00:00.000Z'
    }),
    error => error instanceof CommentStoreError && error.code === 'comment_not_found'
  );

  store.reviewComment({
    commentId: cascaded.id,
    targetStatus: 'approved',
    reviewerId: 1,
    reviewedAt: '2026-07-16T01:00:00.000Z'
  });
  db.prepare('DELETE FROM users WHERE id = ?').run(1);
  assert.equal(db.prepare('SELECT reviewed_by FROM comments WHERE id = ?').get(cascaded.id).reviewed_by, null);

  db.prepare('DELETE FROM articles WHERE id = ?').run(2);
  assert.equal(db.prepare('SELECT id FROM comments WHERE id = ?').get(cascaded.id), undefined);
});

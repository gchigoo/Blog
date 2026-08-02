const assert = require('node:assert/strict');
const test = require('node:test');
const Database = require('better-sqlite3');
const express = require('express');
const { createProjectFixture, runNode, startServer } = require('./helpers/project-fixture');
const { parseCommentsConfig } = require('../server/comments/config');
const { createCommentStore } = require('../server/comments/store');
const { createCommentsModule } = require('../server/comments/module');

const CONFIG_KEYS = [
  'GOOGLE_CLIENT_ID',
  'GOOGLE_CLIENT_SECRET',
  'GOOGLE_REDIRECT_URI',
  'COMMENT_SESSION_SECRET'
];

function commentsEnv(overrides = {}) {
  return {
    GOOGLE_CLIENT_ID: 'google-client-id',
    GOOGLE_CLIENT_SECRET: 'google-client-secret',
    GOOGLE_REDIRECT_URI: 'http://127.0.0.1:3000/auth/google/callback',
    COMMENT_SESSION_SECRET: '0123456789abcdef0123456789abcdef',
    NODE_ENV: 'test',
    ...overrides
  };
}

function disabledCommentsEnv() {
  return Object.fromEntries(CONFIG_KEYS.map(key => [key, '']));
}

test('all missing comment settings disable the module', () => {
  const config = parseCommentsConfig({
    GOOGLE_CLIENT_ID: '  ',
    GOOGLE_CLIENT_SECRET: '',
    GOOGLE_REDIRECT_URI: '\t',
    COMMENT_SESSION_SECRET: undefined,
    NODE_ENV: 'production'
  });

  assert.deepEqual(config, { enabled: false });
});

test('partial comment settings fail without exposing configured values', () => {
  const configuredValue = 'do-not-leak-this-client-id';

  assert.throws(
    () => parseCommentsConfig({ GOOGLE_CLIENT_ID: configuredValue }),
    error => {
      assert.match(error.message, /GOOGLE_CLIENT_SECRET.*required/);
      assert.match(error.message, /GOOGLE_REDIRECT_URI.*required/);
      assert.match(error.message, /COMMENT_SESSION_SECRET.*required/);
      assert.doesNotMatch(error.message, new RegExp(configuredValue));
      return true;
    }
  );
});

test('invalid redirect URI and weak secret settings are rejected', () => {
  const cases = [
    ['relative URI', { GOOGLE_REDIRECT_URI: '/auth/google/callback' }, /GOOGLE_REDIRECT_URI.*absolute/],
    ['credentials', { GOOGLE_REDIRECT_URI: 'https://user:pass@example.com/auth/google/callback' }, /GOOGLE_REDIRECT_URI.*credentials/],
    ['query', { GOOGLE_REDIRECT_URI: 'https://example.com/auth/google/callback?x=1' }, /GOOGLE_REDIRECT_URI.*query/],
    ['fragment', { GOOGLE_REDIRECT_URI: 'https://example.com/auth/google/callback#x' }, /GOOGLE_REDIRECT_URI.*fragment/],
    ['callback path', { GOOGLE_REDIRECT_URI: 'https://example.com/auth/google/callback/' }, /GOOGLE_REDIRECT_URI.*path/],
    ['non-local development HTTP', { GOOGLE_REDIRECT_URI: 'http://example.com/auth/google/callback' }, /GOOGLE_REDIRECT_URI.*HTTPS/],
    ['production HTTP', { GOOGLE_REDIRECT_URI: 'http://localhost:3000/auth/google/callback', NODE_ENV: 'production' }, /GOOGLE_REDIRECT_URI.*HTTPS/],
    ['weak secret', { COMMENT_SESSION_SECRET: 'short' }, /COMMENT_SESSION_SECRET.*32/]
  ];

  for (const [name, overrides, expected] of cases) {
    assert.throws(
      () => parseCommentsConfig(commentsEnv(overrides)),
      expected,
      name
    );
  }
});

test('valid settings are trimmed and enable comments', () => {
  const config = parseCommentsConfig(commentsEnv({
    GOOGLE_CLIENT_ID: ' google-client-id ',
    GOOGLE_CLIENT_SECRET: ' google-client-secret ',
    GOOGLE_REDIRECT_URI: ' http://localhost:3000/auth/google/callback ',
    COMMENT_SESSION_SECRET: ' 0123456789abcdef0123456789abcdef '
  }));

  assert.equal(config.enabled, true);
  assert.equal(config.googleClientId, 'google-client-id');
  assert.equal(config.googleClientSecret, 'google-client-secret');
  assert.equal(config.googleRedirectUri, 'http://localhost:3000/auth/google/callback');
  assert.equal(config.sessionSecret, '0123456789abcdef0123456789abcdef');
});

test('partial settings make the real server fail fast without leaking values', async t => {
  const root = await createProjectFixture(t);
  const configuredValue = 'startup-secret-value-must-not-leak';
  const result = runNode(root, 'server/index.js', [], {
    ...disabledCommentsEnv(),
    GOOGLE_CLIENT_ID: configuredValue
  });
  const output = `${result.stdout}\n${result.stderr}`;

  assert.notEqual(result.status, 0);
  assert.match(output, /GOOGLE_CLIENT_SECRET.*required/);
  assert.doesNotMatch(output, new RegExp(configuredValue));
});

test('disabled comments leave dedicated routes as ordinary 404s', async t => {
  const root = await createProjectFixture(t);
  const init = runNode(root, 'server/scripts/init-db.js', [], {
    INITIAL_ADMIN_PASSWORD: 'S3cure!Node24'
  });
  assert.equal(init.status, 0, init.stderr);

  const db = new Database(`${root}/blog.db`);
  const postId = Number(db.prepare(`
    INSERT INTO posts (translation_key, created_at, updated_at)
    VALUES ('disabled-comments', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')
  `).run().lastInsertRowid);
  db.prepare(`
    INSERT INTO articles (post_id, locale, title, slug, content, html, status, created_at, updated_at)
    VALUES (?, 'zh', 'Disabled comments', 'disabled-comments', 'body', '<p>body</p>', 'published',
            '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')
  `).run(postId);
  db.close();

  const { baseUrl } = await startServer(t, root, disabledCommentsEnv());
  const [authResponse, submitResponse, articleResponse] = await Promise.all([
    fetch(`${baseUrl}/auth/google`),
    fetch(`${baseUrl}/api/articles/1/comments`, { method: 'POST' }),
    fetch(`${baseUrl}/article/disabled-comments`)
  ]);

  assert.equal(authResponse.status, 404);
  assert.equal(submitResponse.status, 404);
  assert.equal(articleResponse.status, 200);
  assert.doesNotMatch(await articleResponse.text(), /id="comments"/);
});

test('a complete fake configuration creates mountable module surfaces', () => {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE articles (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      slug TEXT NOT NULL UNIQUE
    );
    CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT);
  `);
  const config = parseCommentsConfig(commentsEnv());
  const identityClient = {
    createAuthorizationUrl: () => 'https://accounts.google.com/o/oauth2/v2/auth',
    exchangeCode: async () => ({ subject: 'subject', displayName: 'Reader' })
  };
  const comments = createCommentsModule({
    db,
    config,
    identityClient,
    clock: { now: () => new Date('2026-07-16T00:00:00.000Z') }
  });
  const app = express();

  app.use(comments.authRouter);
  app.use(comments.publicRouter);
  app.use(comments.adminRouter);

  assert.equal(comments.enabled, true);
  assert.equal(typeof comments.commenterSession, 'function');
  assert.equal(typeof comments.getArticleCommentsViewModel, 'function');
  assert.deepEqual(comments.getArticleCommentsViewModel(1, null), {
    enabled: true,
    comments: [],
    commenter: null,
    csrfToken: null
  });

  db.close();
});

test('the minimal configuration still constructs while the normalized schema serves moderation locale and translation key', () => {
  // Minimal fixture (legacy articles/users only): construction must not touch
  // moderation SQL, which is prepared lazily only when the admin API is used.
  const minimalDb = new Database(':memory:');
  minimalDb.exec(`
    CREATE TABLE articles (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      slug TEXT NOT NULL UNIQUE
    );
    CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT);
  `);
  const config = parseCommentsConfig(commentsEnv());
  const identityClient = {
    createAuthorizationUrl: () => 'https://accounts.google.com/o/oauth2/v2/auth',
    exchangeCode: async () => ({ subject: 'subject', displayName: 'Reader' })
  };
  const minimalComments = createCommentsModule({
    db: minimalDb,
    config,
    identityClient,
    clock: { now: () => new Date('2026-07-16T00:00:00.000Z') }
  });
  assert.equal(minimalComments.enabled, true);
  assert.equal(typeof minimalComments.getArticleCommentsViewModel, 'function');
  assert.deepEqual(minimalComments.getArticleCommentsViewModel(1, null), {
    enabled: true,
    comments: [],
    commenter: null,
    csrfToken: null
  });
  minimalDb.close();

  // Normalized posts/localized-articles schema: moderation returns the
  // localized article identity for each sibling thread.
  const normalizedDb = new Database(':memory:');
  normalizedDb.pragma('foreign_keys = ON');
  normalizedDb.exec(`
    CREATE TABLE posts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      translation_key TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE articles (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      post_id INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
      locale TEXT NOT NULL CHECK (locale IN ('zh', 'en')),
      title TEXT NOT NULL,
      slug TEXT NOT NULL,
      content TEXT NOT NULL,
      html TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'published',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(post_id, locale),
      UNIQUE(locale, slug)
    );
    CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT);
    INSERT INTO posts (translation_key, created_at, updated_at)
    VALUES ('config-key', '2026-07-16T00:00:00.000Z', '2026-07-16T00:00:00.000Z');
    INSERT INTO articles (post_id, locale, title, slug, content, html, status, created_at, updated_at)
    VALUES (1, 'zh', '中文文章', 'zh-post', 'body', '<p>body</p>', 'published',
            '2026-07-16T00:00:00.000Z', '2026-07-16T00:00:00.000Z');
    INSERT INTO articles (post_id, locale, title, slug, content, html, status, created_at, updated_at)
    VALUES (1, 'en', 'English Post', 'en-post', 'body', '<p>body</p>', 'published',
            '2026-07-16T00:00:00.000Z', '2026-07-16T00:00:00.000Z');
  `);
  const store = createCommentStore(normalizedDb);
  const commenter = store.upsertIdentity(
    { subject: 'config-subject', displayName: 'Reader' },
    '2026-07-16T00:00:00.000Z'
  );
  store.createPendingComment({
    articleId: 1,
    commenterId: commenter.id,
    content: 'zh pending',
    createdAt: '2026-07-16T00:00:00.000Z'
  });
  store.createPendingComment({
    articleId: 2,
    commenterId: commenter.id,
    content: 'en pending',
    createdAt: '2026-07-16T00:00:00.500Z'
  });
  const moderation = store.listForModeration('pending');
  assert.equal(moderation.length, 2);
  const byLocale = new Map(moderation.map(comment => [comment.articleLocale, comment]));
  assert.equal(byLocale.get('zh').translationKey, 'config-key');
  assert.equal(byLocale.get('zh').articleSlug, 'zh-post');
  assert.equal(byLocale.get('en').translationKey, 'config-key');
  assert.equal(byLocale.get('en').articleSlug, 'en-post');
  normalizedDb.close();
});

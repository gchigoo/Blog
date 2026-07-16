const assert = require('node:assert/strict');
const test = require('node:test');
const Database = require('better-sqlite3');
const express = require('express');
const { createProjectFixture, runNode, startServer } = require('./helpers/project-fixture');
const { parseCommentsConfig } = require('../server/comments/config');
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
  db.prepare(`
    INSERT INTO articles (title, slug, content, html, tags)
    VALUES (?, ?, ?, ?, ?)
  `).run('Disabled comments', 'disabled-comments', 'body', '<p>body</p>', '[]');
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

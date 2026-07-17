const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const test = require('node:test');
const { hkdfSync } = require('node:crypto');
const Database = require('better-sqlite3');
const cookieParser = require('cookie-parser');
const express = require('express');
const jwt = require('jsonwebtoken');
const appConfig = require('../server/config');
const { parseCommentsConfig } = require('../server/comments/config');
const { GoogleIdentityError } = require('../server/comments/google-identity');
const { createCommentsModule } = require('../server/comments/module');

const ROOT_SECRET = '0123456789abcdef0123456789abcdef';
const FIXED_NOW_SECONDS = Math.floor(Date.parse('2026-07-16T01:00:00.000Z') / 1000);

function baseSchema(db) {
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
    INSERT INTO articles (title, slug) VALUES ('Article', 'article');
    INSERT INTO users (username) VALUES ('admin');
  `);
}

function createConfig(production = false) {
  return parseCommentsConfig({
    GOOGLE_CLIENT_ID: 'google-client-id',
    GOOGLE_CLIENT_SECRET: 'google-client-secret',
    GOOGLE_REDIRECT_URI: production
      ? 'https://blog.example/auth/google/callback'
      : 'http://127.0.0.1:3000/auth/google/callback',
    COMMENT_SESSION_SECRET: ROOT_SECRET,
    NODE_ENV: production ? 'production' : 'test'
  });
}

function getSetCookies(response) {
  return typeof response.headers.getSetCookie === 'function'
    ? response.headers.getSetCookie()
    : [response.headers.get('set-cookie')].filter(Boolean);
}

function extractCookie(response, name) {
  const header = getSetCookies(response).find(value => value.startsWith(`${name}=`));
  assert.ok(header, `missing ${name} cookie`);
  return header.split(';', 1)[0];
}

async function listen(t, app, db) {
  const server = http.createServer(app);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  t.after(async () => {
    await new Promise(resolve => server.close(resolve));
    db.close();
  });
  return `http://127.0.0.1:${port}`;
}

function fakeIdentityClient(exchangeCode = async () => ({
  subject: 'stable-subject',
  displayName: 'Reader'
})) {
  return {
    createAuthorizationUrl({ state, codeChallenge }) {
      const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
      url.searchParams.set('state', state);
      url.searchParams.set('code_challenge', codeChallenge);
      return url.toString();
    },
    exchangeCode
  };
}

async function beginLogin(baseUrl) {
  const response = await fetch(`${baseUrl}/auth/google?returnTo=/article/article`, {
    redirect: 'manual'
  });
  return {
    cookie: extractCookie(response, 'comment_oauth'),
    response,
    state: new URL(response.headers.get('location')).searchParams.get('state')
  };
}

test('production OAuth and commenter cookies are always Secure', async t => {
  const db = new Database(':memory:');
  baseSchema(db);
  const comments = createCommentsModule({
    db,
    config: createConfig(true),
    identityClient: fakeIdentityClient(),
    clock: { now: () => new Date('2026-07-16T01:00:00.000Z') }
  });
  const app = express();
  app.use(cookieParser());
  app.use(comments.commenterSession);
  app.use(comments.authRouter);
  const baseUrl = await listen(t, app, db);

  const login = await beginLogin(baseUrl);
  const oauthHeader = getSetCookies(login.response)
    .find(value => value.startsWith('comment_oauth='));
  assert.match(oauthHeader, /; Secure/i);

  const callback = await fetch(
    `${baseUrl}/auth/google/callback?code=valid&state=${login.state}`,
    { headers: { cookie: login.cookie }, redirect: 'manual' }
  );
  const sessionHeader = getSetCookies(callback)
    .find(value => value.startsWith('comment_session='));
  assert.match(sessionHeader, /; Secure/i);
});

test('session verifier rejects wrong algorithm, key, issuer, audience, token_use, and missing users', async t => {
  const db = new Database(':memory:');
  baseSchema(db);
  const comments = createCommentsModule({
    db,
    config: createConfig(),
    identityClient: fakeIdentityClient(),
    clock: { now: () => new Date(FIXED_NOW_SECONDS * 1000) }
  });
  const user = db.prepare(`
    INSERT INTO comment_users (google_sub, display_name, created_at, updated_at, last_login_at)
    VALUES ('subject', 'Reader', 'now', 'now', 'now')
    RETURNING id
  `).get();
  const app = express();
  app.use(cookieParser());
  app.use(comments.commenterSession);
  app.get('/_session', (req, res) => res.json({ commenter: req.commenter }));
  const baseUrl = await listen(t, app, db);

  const sessionKey = Buffer.from(hkdfSync(
    'sha256',
    Buffer.from(ROOT_SECRET),
    Buffer.from('minimalist-blog-comments-v1'),
    Buffer.from('comment-session'),
    32
  ));
  const claims = {
    sub: String(user.id),
    csrf: 'x'.repeat(43),
    token_use: 'comment_session',
    iat: FIXED_NOW_SECONDS,
    exp: FIXED_NOW_SECONDS + 3600
  };
  const sign = (payload, key = sessionKey, options = {}) => jwt.sign(payload, key, {
    algorithm: 'HS256',
    issuer: 'minimalist-blog-comments',
    audience: 'comment-session',
    ...options
  });
  const tokens = [
    jwt.sign(claims, '', { algorithm: 'none' }),
    sign(claims, ROOT_SECRET),
    sign(claims, sessionKey, { issuer: 'wrong-issuer' }),
    sign(claims, sessionKey, { audience: 'wrong-audience' }),
    sign({ ...claims, token_use: 'oauth_context' }),
    sign({ ...claims, sub: '999' })
  ];

  for (const token of tokens) {
    const response = await fetch(`${baseUrl}/_session`, {
      headers: { cookie: `comment_session=${token}` }
    });
    assert.equal((await response.json()).commenter, null);
  }
});

test('OAuth, submission, and moderation logs never include codes, subjects, bodies, tokens, or secrets', async t => {
  const sensitiveCode = 'sensitive-authorization-code';
  const sensitiveSubject = 'sensitive-google-subject';
  const sensitiveContent = 'sensitive-comment-body';
  let failExchange = true;
  const db = new Database(':memory:');
  baseSchema(db);
  const identityClient = fakeIdentityClient(async () => {
    if (failExchange) throw new GoogleIdentityError('exchange_failed');
    return { subject: sensitiveSubject, displayName: 'Reader' };
  });
  const comments = createCommentsModule({
    db,
    config: createConfig(),
    identityClient,
    clock: { now: () => new Date('2026-07-16T01:00:00.000Z') }
  });
  const app = express();
  app.set('trust proxy', 'loopback');
  app.use(express.json());
  app.use(cookieParser());
  app.use(comments.commenterSession);
  app.use(comments.authRouter);
  app.use(comments.publicRouter);
  app.use(comments.adminRouter);
  app.get('/_session', (req, res) => {
    res.json({ csrfToken: req.commentSession?.csrfToken || null });
  });
  const baseUrl = await listen(t, app, db);
  const logs = [];
  const originals = {
    info: console.info,
    warn: console.warn,
    error: console.error
  };
  console.info = message => { logs.push(String(message)); };
  console.warn = message => { logs.push(String(message)); };
  console.error = message => { logs.push(String(message)); };
  t.after(() => {
    console.info = originals.info;
    console.warn = originals.warn;
    console.error = originals.error;
  });

  const failedLogin = await beginLogin(baseUrl);
  await fetch(
    `${baseUrl}/auth/google/callback?code=${sensitiveCode}&state=${failedLogin.state}`,
    { headers: { cookie: failedLogin.cookie }, redirect: 'manual' }
  );

  failExchange = false;
  const login = await beginLogin(baseUrl);
  const callback = await fetch(
    `${baseUrl}/auth/google/callback?code=valid&state=${login.state}`,
    { headers: { cookie: login.cookie }, redirect: 'manual' }
  );
  const sessionCookie = extractCookie(callback, 'comment_session');
  const session = await fetch(`${baseUrl}/_session`, {
    headers: { cookie: sessionCookie }
  });
  const { csrfToken } = await session.json();
  const submitted = await fetch(`${baseUrl}/api/articles/1/comments`, {
    method: 'POST',
    headers: { cookie: sessionCookie, 'content-type': 'application/json' },
    body: JSON.stringify({ content: sensitiveContent, csrfToken })
  });
  const { comment } = await submitted.json();
  const adminToken = jwt.sign({ id: 1, username: 'admin' }, appConfig.jwtSecret, {
    expiresIn: '5m'
  });
  await fetch(`${baseUrl}/api/admin/comments/${comment.id}`, {
    method: 'PATCH',
    headers: {
      cookie: `token=${adminToken}`,
      origin: baseUrl,
      'content-type': 'application/json'
    },
    body: JSON.stringify({ status: 'approved' })
  });

  const output = logs.join('\n');
  assert.doesNotMatch(output, new RegExp(sensitiveCode));
  assert.doesNotMatch(output, new RegExp(sensitiveSubject));
  assert.doesNotMatch(output, new RegExp(sensitiveContent));
  assert.doesNotMatch(output, new RegExp(ROOT_SECRET));
  assert.doesNotMatch(output, /eyJ[A-Za-z0-9_-]+\./);
});

test('schema and source keep comments plain-text and exclude forbidden community/profile fields', () => {
  const db = new Database(':memory:');
  baseSchema(db);
  createCommentsModule({
    db,
    config: createConfig(),
    identityClient: fakeIdentityClient(),
    clock: { now: () => new Date('2026-07-16T01:00:00.000Z') }
  });

  const columns = [
    ...db.prepare('PRAGMA table_info(comment_users)').all(),
    ...db.prepare('PRAGMA table_info(comments)').all(),
    ...db.prepare('PRAGMA table_info(comment_oauth_contexts)').all()
  ].map(column => column.name);
  for (const forbidden of [
    'email',
    'avatar',
    'access_token',
    'refresh_token',
    'parent_comment_id',
    'likes',
    'notification_id'
  ]) {
    assert.equal(columns.includes(forbidden), false, forbidden);
  }
  assert.deepEqual(
    db.prepare('PRAGMA table_info(comment_oauth_contexts)').all()
      .map(column => column.name)
      .sort(),
    ['consumed_at', 'created_at', 'expires_at', 'token_id_hash']
  );
  db.close();

  const articleView = fs.readFileSync(path.resolve(__dirname, '..', 'views/article.ejs'), 'utf8');
  const publicScript = fs.readFileSync(path.resolve(__dirname, '..', 'public/js/comments.js'), 'utf8');
  const adminScript = fs.readFileSync(path.resolve(__dirname, '..', 'public/js/admin-comments.js'), 'utf8');
  const moduleSource = fs.readFileSync(path.resolve(__dirname, '..', 'server/comments/module.js'), 'utf8');
  const packageJson = JSON.parse(fs.readFileSync(path.resolve(__dirname, '..', 'package.json'), 'utf8'));

  assert.match(articleView, /<%= comment\.content %>/);
  assert.doesNotMatch(articleView, /<%- comment\.content %>/);
  assert.doesNotMatch(`${publicScript}\n${adminScript}`, /innerHTML/);
  assert.doesNotMatch(moduleSource, /NODE_ENV\s*===?\s*['"]test['"]/);
  assert.equal(packageJson.dependencies.passport, undefined);
  assert.equal(packageJson.dependencies.ejs, '6.0.1');
  assert.equal(packageJson.engines.node, '>=24 <25');
});

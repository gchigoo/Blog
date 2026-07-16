const assert = require('node:assert/strict');
const http = require('node:http');
const test = require('node:test');
const Database = require('better-sqlite3');
const cookieParser = require('cookie-parser');
const express = require('express');
const jwt = require('jsonwebtoken');
const { parseCommentsConfig } = require('../server/comments/config');
const { GoogleIdentityError, createGoogleIdentityClient } = require('../server/comments/google-identity');
const { createCommentsModule } = require('../server/comments/module');

function validConfig() {
  return parseCommentsConfig({
    GOOGLE_CLIENT_ID: 'google-client-id',
    GOOGLE_CLIENT_SECRET: 'google-client-secret',
    GOOGLE_REDIRECT_URI: 'http://127.0.0.1:3000/auth/google/callback',
    COMMENT_SESSION_SECRET: '0123456789abcdef0123456789abcdef',
    NODE_ENV: 'test'
  });
}

function mutableClock() {
  let now = Date.parse('2026-07-16T00:00:00.000Z');
  return {
    now: () => new Date(now),
    advance: milliseconds => { now += milliseconds; }
  };
}

function getSetCookies(response) {
  if (typeof response.headers.getSetCookie === 'function') {
    return response.headers.getSetCookie();
  }
  const combined = response.headers.get('set-cookie');
  return combined ? [combined] : [];
}

function extractCookie(response, name) {
  const header = getSetCookies(response).find(value => value.startsWith(`${name}=`));
  assert.ok(header, `missing ${name} Set-Cookie header`);
  return header.split(';', 1)[0];
}

function assertCookieCleared(response, name) {
  const header = getSetCookies(response).find(value => value.startsWith(`${name}=`));
  assert.ok(header, `missing ${name} clearing header`);
  assert.match(header, /(?:Max-Age=0|Expires=Thu, 01 Jan 1970)/i);
}

function createFakeIdentityClient() {
  const state = {
    authorizationRequests: [],
    exchanges: [],
    identity: { subject: 'google-subject-1', displayName: ' Reader\u0000 Name ' }
  };

  return {
    state,
    createAuthorizationUrl(input) {
      state.authorizationRequests.push(input);
      const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
      url.searchParams.set('state', input.state);
      url.searchParams.set('code_challenge', input.codeChallenge);
      return url.toString();
    },
    async exchangeCode(input) {
      state.exchanges.push(input);
      if (input.code === 'invalid-grant') throw new GoogleIdentityError('invalid_callback');
      if (input.code === 'network-failure') throw new GoogleIdentityError('exchange_failed');
      if (input.code === 'invalid-identity') throw new GoogleIdentityError('identity_invalid');
      return state.identity;
    }
  };
}

async function createHarness(t, { identityClient = createFakeIdentityClient(), clock = mutableClock() } = {}) {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE articles (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      slug TEXT NOT NULL UNIQUE
    );
    CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT);
  `);
  const comments = createCommentsModule({
    db,
    config: validConfig(),
    identityClient,
    clock
  });
  const app = express();
  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));
  app.use(cookieParser());
  app.use(comments.commenterSession);
  app.use(comments.authRouter);
  app.get('/_session', (req, res) => {
    res.json({
      commenter: req.commenter,
      csrfToken: req.commentSession?.csrfToken || null
    });
  });

  const server = http.createServer(app);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();

  t.after(async () => {
    await new Promise(resolve => server.close(resolve));
    db.close();
  });

  return {
    baseUrl: `http://127.0.0.1:${port}`,
    clock,
    comments,
    db,
    identityClient
  };
}

async function beginLogin(baseUrl, returnTo = '/article/safe-slug') {
  const response = await fetch(
    `${baseUrl}/auth/google?returnTo=${encodeURIComponent(returnTo)}`,
    { redirect: 'manual' }
  );
  assert.equal(response.status, 302);
  return {
    oauthCookie: extractCookie(response, 'comment_oauth'),
    state: new URL(response.headers.get('location')).searchParams.get('state'),
    response
  };
}

async function completeLogin(baseUrl, login, code = 'valid-code') {
  return fetch(
    `${baseUrl}/auth/google/callback?code=${encodeURIComponent(code)}&state=${encodeURIComponent(login.state)}`,
    {
      headers: { cookie: login.oauthCookie },
      redirect: 'manual'
    }
  );
}

test('Google login uses state and PKCE then issues an isolated local comment session', async t => {
  const harness = await createHarness(t);
  const login = await beginLogin(harness.baseUrl);

  assert.match(login.oauthCookie, /^comment_oauth=/);
  assert.match(getSetCookies(login.response).join('\n'), /HttpOnly/i);
  assert.match(getSetCookies(login.response).join('\n'), /SameSite=Lax/i);
  assert.match(getSetCookies(login.response).join('\n'), /Path=\/auth\/google\/callback/i);
  assert.match(harness.identityClient.state.authorizationRequests[0].codeChallenge, /^[A-Za-z0-9_-]{43}$/);

  const callback = await completeLogin(harness.baseUrl, login);
  assert.equal(callback.status, 302);
  assert.equal(callback.headers.get('location'), '/article/safe-slug');
  assertCookieCleared(callback, 'comment_oauth');
  const sessionCookie = extractCookie(callback, 'comment_session');
  const sessionHeader = getSetCookies(callback).find(value => value.startsWith('comment_session='));
  assert.match(sessionHeader, /HttpOnly/i);
  assert.match(sessionHeader, /SameSite=Lax/i);
  assert.match(sessionHeader, /Path=\//i);
  assert.match(sessionHeader, /Max-Age=604800/i);

  assert.match(harness.identityClient.state.exchanges[0].codeVerifier, /^[A-Za-z0-9_-]{43}$/);
  const storedUser = harness.db.prepare('SELECT * FROM comment_users').get();
  assert.equal(storedUser.google_sub, 'google-subject-1');
  assert.equal(storedUser.display_name, 'Reader Name');

  const decoded = jwt.decode(sessionCookie.slice('comment_session='.length));
  assert.equal(typeof decoded.sub, 'string');
  assert.equal(decoded.token_use, 'comment_session');
  assert.equal(decoded.aud, 'comment-session');
  assert.equal(decoded.iss, 'minimalist-blog-comments');
  assert.equal(typeof decoded.csrf, 'string');
  assert.equal(decoded.displayName, undefined);
  assert.equal(decoded.email, undefined);

  const sessionResponse = await fetch(`${harness.baseUrl}/_session`, {
    headers: { cookie: sessionCookie }
  });
  const session = await sessionResponse.json();
  assert.equal(session.commenter.displayName, 'Reader Name');
  assert.equal(session.commenter.id, storedUser.id);
  assert.equal(typeof session.csrfToken, 'string');
});

test('OAuth context rejects unsafe return paths, tampering, expiry, state mismatch, and replay', async t => {
  const harness = await createHarness(t);
  const unsafeLogin = await beginLogin(harness.baseUrl, 'https://evil.example/steal');
  const safeCallback = await completeLogin(harness.baseUrl, unsafeLogin);
  assert.equal(safeCallback.status, 302);
  assert.equal(safeCallback.headers.get('location'), '/');

  const tamperedLogin = await beginLogin(harness.baseUrl);
  const [name, value] = tamperedLogin.oauthCookie.split('=');
  const tamperedCookie = `${name}=${value.slice(0, -1)}${value.endsWith('a') ? 'b' : 'a'}`;
  const tamperedResponse = await fetch(
    `${harness.baseUrl}/auth/google/callback?code=valid-code&state=${tamperedLogin.state}`,
    { headers: { cookie: tamperedCookie }, redirect: 'manual' }
  );
  assert.equal(tamperedResponse.status, 400);
  assertCookieCleared(tamperedResponse, 'comment_oauth');

  const mismatchLogin = await beginLogin(harness.baseUrl);
  const mismatchResponse = await fetch(
    `${harness.baseUrl}/auth/google/callback?code=valid-code&state=wrong-state`,
    { headers: { cookie: mismatchLogin.oauthCookie }, redirect: 'manual' }
  );
  assert.equal(mismatchResponse.status, 400);

  const expiredLogin = await beginLogin(harness.baseUrl);
  harness.clock.advance(11 * 60 * 1000);
  const expiredResponse = await completeLogin(harness.baseUrl, expiredLogin);
  assert.equal(expiredResponse.status, 400);

  const replayLogin = await beginLogin(harness.baseUrl);
  const first = await completeLogin(harness.baseUrl, replayLogin);
  assert.equal(first.status, 302);
  const exchangesAfterFirstCallback = harness.identityClient.state.exchanges.length;
  const replay = await fetch(
    `${harness.baseUrl}/auth/google/callback?code=valid-code&state=${replayLogin.state}`,
    { headers: { cookie: replayLogin.oauthCookie }, redirect: 'manual' }
  );
  assert.equal(replay.status, 400);
  assert.equal(harness.identityClient.state.exchanges.length, exchangesAfterFirstCallback);

  const secondCodeReplay = await completeLogin(harness.baseUrl, replayLogin, 'second-code');
  assert.equal(secondCodeReplay.status, 400);
  assert.equal(harness.identityClient.state.exchanges.length, exchangesAfterFirstCallback);

  const concurrentLogin = await beginLogin(harness.baseUrl);
  const exchangesBeforeConcurrentCallbacks = harness.identityClient.state.exchanges.length;
  const concurrentCallbacks = await Promise.all([
    completeLogin(harness.baseUrl, concurrentLogin, 'concurrent-code-a'),
    completeLogin(harness.baseUrl, concurrentLogin, 'concurrent-code-b')
  ]);
  assert.deepEqual(
    concurrentCallbacks.map(response => response.status).sort(),
    [302, 400]
  );
  assert.equal(
    harness.identityClient.state.exchanges.length,
    exchangesBeforeConcurrentCallbacks + 1
  );
});

test('OAuth provider and identity failures have stable status codes and never create users', async t => {
  const harness = await createHarness(t);
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = message => { warnings.push(message); };
  t.after(() => { console.warn = originalWarn; });
  const cases = [
    ['invalid-grant', 400],
    ['network-failure', 502],
    ['invalid-identity', 400]
  ];

  const deniedWithoutContext = await fetch(`${harness.baseUrl}/auth/google/callback?error=access_denied`, {
    redirect: 'manual'
  });
  assert.equal(deniedWithoutContext.status, 400);
  assertCookieCleared(deniedWithoutContext, 'comment_oauth');

  const deniedLogin = await beginLogin(harness.baseUrl);
  const denied = await fetch(
    `${harness.baseUrl}/auth/google/callback?error=access_denied&state=${deniedLogin.state}`,
    { headers: { cookie: deniedLogin.oauthCookie }, redirect: 'manual' }
  );
  assert.equal(denied.status, 400);
  assert.ok(warnings.some(message => message.endsWith('invalid_callback')));
  assert.ok(warnings.some(message => message.endsWith('provider_denied')));

  for (const [code, expectedStatus] of cases) {
    const login = await beginLogin(harness.baseUrl);
    const response = await completeLogin(harness.baseUrl, login, code);
    assert.equal(response.status, expectedStatus, code);
    assertCookieCleared(response, 'comment_oauth');
  }

  const missingCodeLogin = await beginLogin(harness.baseUrl);
  const missingCode = await fetch(
    `${harness.baseUrl}/auth/google/callback?state=${missingCodeLogin.state}`,
    { headers: { cookie: missingCodeLogin.oauthCookie }, redirect: 'manual' }
  );
  assert.equal(missingCode.status, 400);
  assert.equal(harness.db.prepare('SELECT COUNT(*) AS count FROM comment_users').get().count, 0);
  assert.equal(getSetCookies(missingCode).some(value => value.startsWith('comment_session=')), false);
});

test('unexpected local persistence failures return 500 without issuing a session', async t => {
  const harness = await createHarness(t);
  const login = await beginLogin(harness.baseUrl);
  harness.db.exec('DROP TABLE comment_users');

  const callback = await completeLogin(harness.baseUrl, login);
  assert.equal(callback.status, 500);
  assertCookieCleared(callback, 'comment_oauth');
  assert.equal(getSetCookies(callback).some(value => value.startsWith('comment_session=')), false);
});

test('OAuth and comment-session tokens cannot be used across token types', async t => {
  const harness = await createHarness(t);
  const login = await beginLogin(harness.baseUrl);
  const oauthToken = login.oauthCookie.slice('comment_oauth='.length);
  const oauthAsSession = await fetch(`${harness.baseUrl}/_session`, {
    headers: { cookie: `comment_session=${oauthToken}` }
  });
  assert.equal((await oauthAsSession.json()).commenter, null);

  const callback = await completeLogin(harness.baseUrl, login);
  const sessionCookie = extractCookie(callback, 'comment_session');
  const sessionToken = sessionCookie.slice('comment_session='.length);
  const sessionAsOauth = await fetch(
    `${harness.baseUrl}/auth/google/callback?code=valid-code&state=${login.state}`,
    { headers: { cookie: `comment_oauth=${sessionToken}` }, redirect: 'manual' }
  );
  assert.equal(sessionAsOauth.status, 400);
});

test('tampered and expired comment sessions are treated as logged out', async t => {
  const harness = await createHarness(t);
  const login = await beginLogin(harness.baseUrl);
  const callback = await completeLogin(harness.baseUrl, login);
  const sessionCookie = extractCookie(callback, 'comment_session');
  const [name, value] = sessionCookie.split('=');
  const tamperedCookie = `${name}=${value.slice(0, -1)}${value.endsWith('a') ? 'b' : 'a'}`;

  const tampered = await fetch(`${harness.baseUrl}/_session`, {
    headers: { cookie: tamperedCookie }
  });
  assert.equal((await tampered.json()).commenter, null);
  assertCookieCleared(tampered, 'comment_session');

  harness.clock.advance(8 * 24 * 60 * 60 * 1000);
  const expired = await fetch(`${harness.baseUrl}/_session`, {
    headers: { cookie: sessionCookie }
  });
  assert.equal((await expired.json()).commenter, null);
  assertCookieCleared(expired, 'comment_session');
});

test('logout requires the valid session CSRF nonce and clears only valid sessions', async t => {
  const harness = await createHarness(t);
  const login = await beginLogin(harness.baseUrl);
  const callback = await completeLogin(harness.baseUrl, login);
  const sessionCookie = extractCookie(callback, 'comment_session');
  const sessionResponse = await fetch(`${harness.baseUrl}/_session`, {
    headers: { cookie: sessionCookie }
  });
  const { csrfToken } = await sessionResponse.json();

  const forged = await fetch(`${harness.baseUrl}/auth/logout`, {
    method: 'POST',
    headers: { cookie: sessionCookie, 'content-type': 'application/json' },
    body: JSON.stringify({ csrfToken: 'forged' })
  });
  assert.equal(forged.status, 403);

  const logout = await fetch(`${harness.baseUrl}/auth/logout`, {
    method: 'POST',
    headers: { cookie: sessionCookie, 'content-type': 'application/json' },
    body: JSON.stringify({ csrfToken })
  });
  assert.equal(logout.status, 204);
  assertCookieCleared(logout, 'comment_session');
});

test('official Google adapter requests online openid profile and classifies exchange failures', async () => {
  const calls = [];
  const oauthClient = {
    generateAuthUrl(options) {
      calls.push(['authorize', options]);
      return 'https://accounts.google.com/o/oauth2/v2/auth';
    },
    async getToken(options) {
      calls.push(['token', options]);
      if (options.code === 'invalid') {
        const error = new Error('provider rejected code');
        error.response = { status: 400, data: { error: 'invalid_grant' } };
        throw error;
      }
      if (options.code === 'network') {
        const error = new Error('network unavailable');
        error.code = 'ETIMEDOUT';
        throw error;
      }
      if (options.code === 'missing-id-token') return { tokens: {} };
      return { tokens: { id_token: options.code } };
    },
    async verifyIdToken(options) {
      calls.push(['verify', options]);
      if (options.idToken === 'verify-network') {
        const error = new Error('certificate lookup timed out');
        error.code = 'ETIMEDOUT';
        throw error;
      }
      if (options.idToken === 'verify-dns') {
        const error = new Error('certificate host not found');
        error.code = 'ENOTFOUND';
        throw error;
      }
      if (options.idToken === 'verify-nested-dns') {
        const error = new Error('certificate request failed');
        error.cause = Object.assign(new Error('temporary DNS failure'), {
          code: 'EAI_AGAIN'
        });
        throw error;
      }
      if (options.idToken === 'verify-5xx') {
        const error = new Error('certificate endpoint unavailable');
        error.response = { status: 503 };
        throw error;
      }
      if (options.idToken === 'verify-invalid') {
        throw new Error('invalid token signature');
      }
      return { getPayload: () => ({ sub: 'subject-1', name: 'Reader' }) };
    }
  };
  const identityClient = createGoogleIdentityClient({
    clientId: 'google-client-id',
    clientSecret: 'google-client-secret',
    redirectUri: 'https://blog.example/auth/google/callback',
    oauthClient
  });

  identityClient.createAuthorizationUrl({ state: 'state', codeChallenge: 'challenge' });
  assert.deepEqual(calls[0][1].scope, ['openid', 'profile']);
  assert.equal(calls[0][1].access_type, 'online');
  assert.equal(calls[0][1].state, 'state');
  assert.equal(calls[0][1].code_challenge, 'challenge');
  assert.equal(calls[0][1].code_challenge_method, 'S256');

  const identity = await identityClient.exchangeCode({ code: 'valid', codeVerifier: 'verifier' });
  assert.deepEqual(identity, { subject: 'subject-1', displayName: 'Reader' });
  assert.deepEqual(calls.find(([kind]) => kind === 'token')[1], {
    code: 'valid',
    codeVerifier: 'verifier'
  });
  assert.equal(calls.find(([kind]) => kind === 'verify')[1].audience, 'google-client-id');

  await assert.rejects(
    identityClient.exchangeCode({ code: 'invalid', codeVerifier: 'verifier' }),
    error => error.code === 'invalid_callback'
  );
  await assert.rejects(
    identityClient.exchangeCode({ code: 'network', codeVerifier: 'verifier' }),
    error => error.code === 'exchange_failed'
  );
  await assert.rejects(
    identityClient.exchangeCode({ code: 'missing-id-token', codeVerifier: 'verifier' }),
    error => error.code === 'identity_invalid'
  );
  await assert.rejects(
    identityClient.exchangeCode({ code: 'verify-network', codeVerifier: 'verifier' }),
    error => error.code === 'exchange_failed'
  );
  await assert.rejects(
    identityClient.exchangeCode({ code: 'verify-5xx', codeVerifier: 'verifier' }),
    error => error.code === 'exchange_failed'
  );
  await assert.rejects(
    identityClient.exchangeCode({ code: 'verify-dns', codeVerifier: 'verifier' }),
    error => error.code === 'exchange_failed'
  );
  await assert.rejects(
    identityClient.exchangeCode({ code: 'verify-nested-dns', codeVerifier: 'verifier' }),
    error => error.code === 'exchange_failed'
  );
  await assert.rejects(
    identityClient.exchangeCode({ code: 'verify-invalid', codeVerifier: 'verifier' }),
    error => error.code === 'identity_invalid'
  );
});

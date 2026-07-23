const assert = require('node:assert/strict');
const test = require('node:test');
const { createLoginRateLimiter } = require('../server/auth/login-rate-limiter');
const { createProjectFixture, runNode, startServer } = require('./helpers/project-fixture');

const INITIAL_PASSWORD = 'S3cure!Node24';

async function initializedServer(t, env = {}) {
  const root = await createProjectFixture(t);
  const init = runNode(root, 'server/scripts/init-db.js', [], {
    INITIAL_ADMIN_PASSWORD: INITIAL_PASSWORD
  });
  assert.equal(init.status, 0, init.stderr);
  return startServer(t, root, env.NODE_ENV === 'production'
    ? { BLOG_PUBLIC_ORIGIN: 'https://blog.example.test', ...env }
    : env);
}

test('production startup requires a stable strong JWT secret', async t => {
  const root = await createProjectFixture(t);
  const analyticsSecret = Buffer.alloc(32, 9).toString('base64url');

  for (const jwtSecret of ['', 'too-short']) {
    const result = runNode(root, 'server/index.js', [], {
      NODE_ENV: 'production',
      JWT_SECRET: jwtSecret,
      ANALYTICS_HMAC_SECRET: analyticsSecret
    });
    assert.notEqual(result.status, 0);
    assert.match(`${result.stdout}${result.stderr}`, /JWT_SECRET/);
  }

  const missingOrigin = runNode(root, 'server/index.js', [], {
    NODE_ENV: 'production',
    JWT_SECRET: 'production-jwt-secret-with-at-least-32-characters',
    ANALYTICS_HMAC_SECRET: analyticsSecret
  });
  assert.notEqual(missingOrigin.status, 0);
  assert.match(`${missingOrigin.stdout}${missingOrigin.stderr}`, /BLOG_PUBLIC_ORIGIN/);
});

test('login limiter blocks bursts and refills over time', () => {
  let now = 0;
  const limiter = createLoginRateLimiter({
    capacity: 2,
    refillIntervalMs: 1_000,
    now: () => now
  });

  assert.equal(limiter.consume('127.0.0.1').allowed, true);
  assert.equal(limiter.consume('127.0.0.1').allowed, true);
  const blocked = limiter.consume('127.0.0.1');
  assert.equal(blocked.allowed, false);
  assert.equal(blocked.retryAfter, 1);

  now = 1_000;
  assert.equal(limiter.consume('127.0.0.1').allowed, true);
});

test('login endpoint rejects a missing body without turning it into a server error', async t => {
  const { baseUrl } = await initializedServer(t);
  const response = await fetch(`${baseUrl}/api/auth/login`, { method: 'POST' });
  assert.equal(response.status, 400);
});

test('login endpoint rate-limits repeated authentication attempts', async t => {
  const { baseUrl } = await initializedServer(t);
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const response = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'missing', password: 'wrong-password' })
    });
    assert.equal(response.status, 401);
  }

  const blocked = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: INITIAL_PASSWORD })
  });
  assert.equal(blocked.status, 429);
  assert.ok(Number(blocked.headers.get('retry-after')) >= 1);
});

test('admin HTML authentication redirects while API authentication stays JSON', async t => {
  const { baseUrl } = await initializedServer(t);
  const pageResponse = await fetch(`${baseUrl}/admin/upload`, {
    redirect: 'manual',
    headers: { accept: 'text/html' }
  });
  const apiResponse = await fetch(`${baseUrl}/api/admin/articles`);

  assert.equal(pageResponse.status, 303);
  assert.equal(pageResponse.headers.get('location'), '/admin/login');
  assert.equal(apiResponse.status, 401);
  assert.equal(apiResponse.headers.get('content-type').startsWith('application/json'), true);
});

test('production login cookie is secure and responses include security headers', async t => {
  const { baseUrl } = await initializedServer(t, { NODE_ENV: 'production' });
  const response = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: INITIAL_PASSWORD })
  });

  assert.equal(response.status, 200, await response.text());
  const cookie = response.headers.get('set-cookie');
  assert.match(cookie, /HttpOnly/i);
  assert.match(cookie, /SameSite=Strict/i);
  assert.match(cookie, /Secure/i);
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(response.headers.get('x-frame-options'), 'DENY');
  assert.match(response.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  assert.match(response.headers.get('strict-transport-security'), /max-age=31536000/);
  assert.equal(response.headers.get('x-powered-by'), null);
});

test('public article pagination rejects unbounded values', async t => {
  const { baseUrl } = await initializedServer(t);
  const negative = await fetch(`${baseUrl}/api/articles?pageSize=-1`);
  const excessive = await fetch(`${baseUrl}/api/articles?pageSize=101`);

  assert.equal(negative.status, 400);
  assert.equal(excessive.status, 400);
});

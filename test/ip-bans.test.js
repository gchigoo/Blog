const assert = require('node:assert/strict');
const test = require('node:test');
const Database = require('better-sqlite3');
const express = require('express');
const jwt = require('jsonwebtoken');
const appConfig = require('../server/config');
const {
  banNetwork,
  createIpBanGuard,
  isProbePath,
  isVerifiedCrawler
} = require('../server/security/ip-bans');
const { createIpBanAdminRouter } = require('../server/security/admin-api');

const quietLogger = { log() {}, error() {} };
const VALID_SECRET = Buffer.alloc(32, 7).toString('base64url');

// No DNS in tests: only the documented Googlebot address verifies.
const fakeResolver = {
  async reverse(ip) {
    if (ip === '66.249.66.1') return ['crawl-66-249-66-1.googlebot.com'];
    if (ip === '34.1.2.3') return ['3.2.1.34.bc.googleusercontent.com'];
    if (ip === '203.0.113.40') return ['crawl-203-0-113-40.googlebot.com'];
    throw Object.assign(new Error('not found'), { code: 'ENOTFOUND' });
  },
  async lookup(host) {
    if (host === 'crawl-66-249-66-1.googlebot.com') return [{ address: '66.249.66.1', family: 4 }];
    if (host === 'crawl-203-0-113-40.googlebot.com') return [{ address: '66.249.66.99', family: 4 }];
    return [];
  }
};

async function serve(app, run) {
  const server = await new Promise(resolve => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    return await run((path, ip, headers = {}) => fetch(`${base}${path}`, {
      headers: { 'x-forwarded-for': ip, 'user-agent': 'Mozilla/5.0 (X11; Linux x86_64)', ...headers }
    }));
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
}

function blogApp(guard) {
  const app = express();
  // As in production: nginx on loopback overwrites X-Forwarded-For with the real client.
  app.set('trust proxy', 'loopback');
  app.use(guard.middleware);
  app.get('/', (req, res) => res.send('home'));
  app.get('/wp-content', (req, res) => res.send('a real page'));
  app.use((req, res) => res.status(404).send('not found'));
  return app;
}

function newGuard(db, options = {}) {
  return createIpBanGuard({
    db,
    resolver: fakeResolver,
    logger: quietLogger,
    now: () => Date.parse('2026-10-31T08:00:00Z'),
    ...options
  });
}

test('probe paths match production probes and leave blog pages alone', () => {
  for (const path of [
    '/.env', '/.env.local', '/api/.env', '/config/.env.bak', '/.git/config', '/.aws/credentials',
    '/index.php', '/wp-admin/admin-ajax.php', '/vendor/phpunit/phpunit/src/Util/PHP/eval-stdin.php',
    '/wp-content/plugins/x/readme.txt', '/phpmyadmin/', '/%2Eenv', '/.DS_Store'
  ]) assert.equal(isProbePath(path), true, path);
  for (const path of [
    '/', '/zh/', '/zh/tag/Node.js', '/zh/tag/ASP.NET', '/en/articles/hello-world', '/zh/tag/PHP',
    '/images/cover.webp', '/css/custom.css', '/.well-known/security.txt', '/env', '/%E0%A4%A'
  ]) assert.equal(isProbePath(path), false, path);
});

test('bans cover an IPv4 address or an IPv6 /64', () => {
  assert.equal(banNetwork('203.0.113.7'), '203.0.113.7');
  assert.equal(banNetwork('::ffff:203.0.113.7'), '203.0.113.7');
  assert.equal(banNetwork('2001:db8:1:2:aaaa::1'), '2001:db8:1:2::/64');
  assert.equal(banNetwork('2001:db8::1'), '2001:db8::/64');
  assert.equal(banNetwork('not-an-ip'), null);
});

test('a crawler user agent counts only with matching reverse and forward DNS', async () => {
  const googlebot = 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)';
  assert.equal(await isVerifiedCrawler('66.249.66.1', googlebot, fakeResolver), true);
  assert.equal(await isVerifiedCrawler('34.1.2.3', googlebot, fakeResolver), false);
  assert.equal(await isVerifiedCrawler('203.0.113.40', googlebot, fakeResolver), false);
  assert.equal(await isVerifiedCrawler('203.0.113.41', googlebot, fakeResolver), false);
  let asked = false;
  const watching = { reverse: async () => { asked = true; return []; }, lookup: async () => [] };
  assert.equal(await isVerifiedCrawler('66.249.66.1', 'Mozilla/5.0 Chrome/130', watching), false);
  assert.equal(asked, false);
});

test('a missed probe bans the client, which then gets 403 for everything', async () => {
  const db = new Database(':memory:');
  const guard = newGuard(db);
  guard.start();
  await serve(blogApp(guard), async get => {
    assert.equal((await get('/.git/config', '203.0.113.7')).status, 404);
    await guard.settled();
    for (const path of ['/', '/css/custom.css', '/health']) {
      const blocked = await get(path, '203.0.113.7');
      assert.equal(blocked.status, 403);
      assert.equal(blocked.headers.get('cache-control'), 'private, no-store');
      assert.equal(await blocked.text(), 'Forbidden');
    }
    assert.equal((await get('/', '203.0.113.8')).status, 200);
    // IPv6 bans cover the whole /64.
    await get('/wp-login.php', '2001:db8:1:2::10');
    await guard.settled();
    assert.equal((await get('/', '2001:db8:1:2:ffff::1')).status, 403);
    assert.equal((await get('/', '2001:db8:1:3::10')).status, 200);
  });
  guard.flush();
  const row = db.prepare("SELECT * FROM ip_bans WHERE network = '203.0.113.7'").get();
  assert.equal(row.path, '/.git/config');
  assert.equal(row.status, 404);
  assert.equal(row.hits, 3);
  assert.equal(row.last_hit_at, '2026-10-31T08:00:00.000Z');
  await guard.stop();

  // A restart keeps the ban.
  const restarted = newGuard(db);
  restarted.start();
  await serve(blogApp(restarted), async get => {
    assert.equal((await get('/', '203.0.113.7')).status, 403);
  });
  assert.equal(restarted.unban('203.0.113.7'), true);
  await serve(blogApp(restarted), async get => {
    assert.equal((await get('/', '203.0.113.7')).status, 200);
  });
  await restarted.stop();
});

test('only a probe the blog answered with a 4xx bans anyone', async () => {
  const db = new Database(':memory:');
  const guard = newGuard(db);
  guard.start();
  await serve(blogApp(guard), async get => {
    assert.equal((await get('/wp-content', '203.0.113.7')).status, 200);
    assert.equal((await get('/missing-page', '203.0.113.7')).status, 404);
    await guard.settled();
    assert.equal((await get('/', '203.0.113.7')).status, 200);
  });
  assert.equal(guard.list().total, 0);
  await guard.stop();
});

test('internal, allowlisted, Cloudflare-owned, owner and verified crawler clients are spared', async () => {
  const db = new Database(':memory:');
  const guard = newGuard(db, {
    internalIps: ['198.51.100.5'],
    isOwner: req => req.get('x-test-owner') === 'yes'
  });
  guard.start();
  const googlebot = { 'user-agent': 'Mozilla/5.0 (compatible; Googlebot/2.1)' };
  await serve(blogApp(guard), async get => {
    await get('/.env', '10.0.0.5');
    await get('/.env', '198.51.100.5');
    await get('/.env', '2a06:98c0:3600::103');
    await get('/.env', '203.0.113.20', { 'x-test-owner': 'yes' });
    await get('/wp-login.php', '66.249.66.1', googlebot);
    await get('/wp-login.php', '34.1.2.3', googlebot);
    await guard.settled();
  });
  assert.deepEqual(guard.list().bans.map(ban => ban.network), ['34.1.2.3']);
  await guard.stop();
});

test('a disabled guard passes everything through', async () => {
  const db = new Database(':memory:');
  const guard = newGuard(db, { enabled: false });
  guard.start();
  await serve(blogApp(guard), async get => {
    await get('/.env', '203.0.113.7');
    await guard.settled();
    assert.equal((await get('/', '203.0.113.7')).status, 200);
  });
  assert.equal(guard.list().total, 0);
  await guard.stop();
});

test('the admin API lists bans and lifts one, signed in only', async () => {
  const db = new Database(':memory:');
  const guard = newGuard(db);
  guard.start();
  await serve(blogApp(guard), async get => {
    await get('/.env', '2001:db8:1:2::10');
    await guard.settled();
  });
  const app = express();
  app.use(express.json());
  app.use('/api/admin/ip-bans', createIpBanAdminRouter({ guard }));
  const token = jwt.sign({ id: 1, username: 'admin' }, appConfig.jwtSecret, { algorithm: 'HS256' });
  const server = await new Promise(resolve => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
  });
  const base = `http://127.0.0.1:${server.address().port}/api/admin/ip-bans`;
  const call = (path, options = {}) => fetch(`${base}${path}`, {
    ...options,
    headers: { 'content-type': 'application/json', ...(options.headers || {}) }
  });
  const signedIn = { authorization: `Bearer ${token}` };
  try {
    assert.equal((await call('/')).status, 401);
    const listed = await call('/', { headers: signedIn });
    assert.equal(listed.headers.get('cache-control'), 'no-store');
    const body = await listed.json();
    assert.equal(body.total, 1);
    assert.equal(body.bans[0].network, '2001:db8:1:2::/64');
    assert.equal(body.bans[0].path, '/.env');

    const unban = network => call('/unban', {
      method: 'POST', headers: signedIn, body: JSON.stringify({ network })
    });
    assert.equal((await unban('not-an-ip')).status, 400);
    assert.equal((await unban('203.0.113.9')).status, 404);
    // Any address in the /64 lifts its ban.
    const lifted = await unban('2001:db8:1:2::abcd');
    assert.equal(lifted.status, 200);
    assert.deepEqual(await lifted.json(), { unbanned: '2001:db8:1:2::/64' });
    assert.equal(guard.list().total, 0);
  } finally {
    await new Promise(resolve => server.close(resolve));
    await guard.stop();
  }
});

test('IP_BAN_ENABLED is off by default and must be true or false', () => {
  const env = { NODE_ENV: 'test', ANALYTICS_HMAC_SECRET: VALID_SECRET };
  assert.equal(appConfig.loadRuntimeConfig(env).ipBans.enabled, false);
  assert.equal(appConfig.loadRuntimeConfig({ ...env, IP_BAN_ENABLED: 'true' }).ipBans.enabled, true);
  assert.throws(() => appConfig.loadRuntimeConfig({ ...env, IP_BAN_ENABLED: 'yes' }), /IP_BAN_ENABLED.*true or false/);
});

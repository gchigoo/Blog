const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const { createAnalyticsMiddleware, deviceKind, isTrackableRequest } = require('../server/analytics/middleware');
const { cleanupMetrics, getOverview, initializeAnalytics, visitorDayHmac } = require('../server/analytics/store');

function makeResponse(statusCode = 200) {
  const listeners = new Map();
  return {
    statusCode,
    locals: {},
    on(event, listener) { listeners.set(event, listener); },
    getHeader(name) { return name.toLowerCase() === 'content-type' ? 'text/html; charset=utf-8' : undefined; },
    finish() { listeners.get('finish')?.(); }
  };
}

function makeRequest({ path = '/', method = 'GET', ip = '203.0.113.10', userAgent = 'Mozilla/5.0' } = {}) {
  return { path, method, ip, get: name => name === 'user-agent' ? userAgent : undefined };
}

test('analytics records only successful public requests without raw request fields', () => {
  const db = new Database(':memory:');
  initializeAnalytics(db);
  const middleware = createAnalyticsMiddleware({ db, secret: 'test-secret', now: () => Date.UTC(2026, 6, 15, 4, 35) });
  const response = makeResponse();
  middleware(makeRequest({ path: '/article/privacy?secret=ignored' }), response, () => {});
  response.finish();

  const row = db.prepare('SELECT * FROM access_metrics').get();
  assert.deepEqual(
    Object.keys(row).sort(),
    ['bucket_utc', 'device_kind', 'id', 'path', 'traffic_kind', 'visitor_day_hmac']
  );
  assert.equal(row.traffic_kind, 'human');
  assert.equal(row.path, '/article/privacy');
  assert.equal(row.device_kind, 'desktop');
  assert.equal(row.visitor_day_hmac.length, 64);
  assert.notEqual(row.visitor_day_hmac, '203.0.113.10');
});

test('analytics stores bots while excluding admin, API, assets, and failed responses', () => {
  const db = new Database(':memory:');
  initializeAnalytics(db);
  const middleware = createAnalyticsMiddleware({ db, secret: 'test-secret' });
  for (const request of [
    makeRequest({ path: '/admin/analytics' }), makeRequest({ path: '/api/admin/analytics' }),
    makeRequest({ path: '/auth/google/callback?code=SECRET&state=STATE' }),
    makeRequest({ path: '/css/custom.css' }),
    makeRequest({ path: '/audio/example-song/track.mp3' })
  ]) {
    const response = makeResponse(); middleware(request, response, () => {}); response.finish();
  }
  for (const [path, userAgent] of [['/', 'Googlebot/2.1'], ['/about', 'GPTBot/1.2']]) {
    const botResponse = makeResponse();
    middleware(makeRequest({ path, userAgent }), botResponse, () => {});
    botResponse.finish();
  }
  const failed = makeResponse(404); middleware(makeRequest({ path: '/missing' }), failed, () => {}); failed.finish();
  const nonHtml = makeResponse();
  nonHtml.getHeader = () => 'application/json';
  middleware(makeRequest({ path: '/feed' }), nonHtml, () => {});
  nonHtml.finish();
  assert.deepEqual(
    db.prepare('SELECT path, traffic_kind FROM access_metrics ORDER BY path').all(),
    [{ path: '/', traffic_kind: 'bot' }, { path: '/about', traffic_kind: 'bot' }]
  );
  assert.equal(isTrackableRequest(makeRequest({ method: 'POST' })), false);
});

test('analytics excludes loopback and configured server addresses', () => {
  const db = new Database(':memory:');
  initializeAnalytics(db);
  const middleware = createAnalyticsMiddleware({
    db,
    secret: 'test-secret',
    internalIps: ['23.254.158.109']
  });
  for (const ip of ['127.0.0.1', '127.10.20.30', '::1', '::ffff:127.0.0.1', '23.254.158.109']) {
    const response = makeResponse();
    middleware(makeRequest({ ip }), response, () => {});
    response.finish();
  }
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM access_metrics').get().count, 0);
  db.close();
});

test('analytics aggregates visitor HMACs and removes entries older than 30 days', () => {
  const db = new Database(':memory:');
  initializeAnalytics(db);
  const now = Date.UTC(2026, 6, 15, 12);
  const middleware = createAnalyticsMiddleware({ db, secret: 'test-secret', now: () => now });
  for (const path of ['/', '/article/one']) {
    const response = makeResponse(); middleware(makeRequest({ path, ip: '203.0.113.10', userAgent: 'Mozilla/5.0 (iPhone)' }), response, () => {}); response.finish();
  }
  db.prepare(`INSERT INTO access_metrics (bucket_utc, path, visitor_day_hmac, device_kind) VALUES (?, '/', 'expired', 'desktop')`)
    .run(new Date(now - 31 * 24 * 60 * 60 * 1000).toISOString());
  assert.equal(cleanupMetrics(db, now), 1);
  const overview = getOverview(db, now, 7);
  assert.equal(overview.pageViews, 2);
  assert.equal(overview.anonymousVisitors, 1);
  assert.equal(overview.byPage.length, 2);
  assert.deepEqual(overview.byDevice, [{ deviceKind: 'mobile', pageViews: 2 }]);
  assert.notEqual(
    visitorDayHmac('203.0.113.10', 'test-secret', now),
    visitorDayHmac('203.0.113.10', 'test-secret', now + 24 * 60 * 60 * 1000)
  );
  const beforeMidnight = Date.parse('2026-07-17T15:59:59.999Z');
  const atMidnight = Date.parse('2026-07-17T16:00:00.000Z');
  assert.notEqual(
    visitorDayHmac('203.0.113.10', 'test-secret', beforeMidnight),
    visitorDayHmac('203.0.113.10', 'test-secret', atMidnight)
  );
  assert.equal(
    visitorDayHmac('203.0.113.10', 'test-secret', atMidnight),
    visitorDayHmac('203.0.113.10', 'test-secret', atMidnight + 60_000)
  );
  assert.equal(deviceKind('Mozilla/5.0 (iPad)'), 'tablet');
});

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const Database = require('better-sqlite3');
const { parseAnalyticsConfig } = require('../server/analytics/config');
const { createAnalyticsModule } = require('../server/analytics/module');
const { createAnalyticsMiddleware } = require('../server/analytics/middleware');
const { initializeAnalytics } = require('../server/analytics/store');

const VALID_SECRET = Buffer.alloc(32, 7).toString('base64url');

function analyticsEnv(overrides = {}) {
  return {
    ANALYTICS_DETAILS_ENABLED: 'false',
    ANALYTICS_HMAC_SECRET: VALID_SECRET,
    ANALYTICS_RETENTION_DAYS: '30',
    NODE_ENV: 'test',
    ...overrides
  };
}

test('analytics config is fail-fast and details-only settings are conditional', () => {
  assert.deepEqual(parseAnalyticsConfig(analyticsEnv()), {
    detailsEnabled: false,
    hmacSecret: Buffer.from(VALID_SECRET, 'base64url'),
    retentionDays: 30,
    geoIpCityDbPath: null,
    geoIpUpdateStatusPath: null,
    publicOrigin: null
  });

  for (const [overrides, expected] of [
    [{ ANALYTICS_HMAC_SECRET: '' }, /ANALYTICS_HMAC_SECRET.*required/],
    [{ ANALYTICS_HMAC_SECRET: 'not=canonical' }, /ANALYTICS_HMAC_SECRET.*base64url/],
    [{ ANALYTICS_HMAC_SECRET: Buffer.alloc(16).toString('base64url') }, /ANALYTICS_HMAC_SECRET.*32 bytes/],
    [{ ANALYTICS_DETAILS_ENABLED: 'yes' }, /ANALYTICS_DETAILS_ENABLED.*true.*false/],
    [{ ANALYTICS_RETENTION_DAYS: '0' }, /ANALYTICS_RETENTION_DAYS.*1.*365/],
    [{ ANALYTICS_RETENTION_DAYS: '7.5' }, /ANALYTICS_RETENTION_DAYS.*integer/],
    [{ ANALYTICS_DETAILS_ENABLED: 'true' }, /ANALYTICS_GEOIP_CITY_DB_PATH.*required/],
    [{ ANALYTICS_DETAILS_ENABLED: 'true', ANALYTICS_GEOIP_CITY_DB_PATH: '/tmp/city.mmdb' }, /ANALYTICS_PUBLIC_ORIGIN.*required/],
    [{
      ANALYTICS_DETAILS_ENABLED: 'true',
      ANALYTICS_GEOIP_CITY_DB_PATH: '/tmp/city.mmdb',
      ANALYTICS_PUBLIC_ORIGIN: 'https://user:pass@example.com'
    }, /ANALYTICS_PUBLIC_ORIGIN.*credentials/],
    [{
      ANALYTICS_DETAILS_ENABLED: 'true',
      ANALYTICS_GEOIP_CITY_DB_PATH: '/tmp/city.mmdb',
      ANALYTICS_PUBLIC_ORIGIN: 'http://example.com',
      NODE_ENV: 'production'
    }, /ANALYTICS_PUBLIC_ORIGIN.*HTTPS/]
  ]) {
    assert.throws(() => parseAnalyticsConfig(analyticsEnv(overrides)), expected);
  }

  const enabled = parseAnalyticsConfig(analyticsEnv({
    ANALYTICS_DETAILS_ENABLED: 'true',
    ANALYTICS_GEOIP_CITY_DB_PATH: '/tmp/GeoLite2-City.mmdb',
    ANALYTICS_PUBLIC_ORIGIN: 'https://blog.example.com/'
  }));
  assert.equal(enabled.publicOrigin, 'https://blog.example.com');
  assert.equal(enabled.geoIpUpdateStatusPath, '/tmp/update-status.json');
});

test('analytics module exposes mountable surfaces and owns lifecycle resources', async () => {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  const calls = [];
  const geoResolver = {
    async start() { calls.push('geo:start'); },
    stop() { calls.push('geo:stop'); },
    resolve() { return { status: 'not_found', data: null }; },
    getStatus() { return { reader: null, updater: { state: 'missing', result: 'unknown' }, stale: false }; }
  };
  const analytics = await createAnalyticsModule({
    db,
    config: parseAnalyticsConfig(analyticsEnv({
      ANALYTICS_DETAILS_ENABLED: 'true',
      ANALYTICS_GEOIP_CITY_DB_PATH: '/tmp/GeoLite2-City.mmdb',
      ANALYTICS_PUBLIC_ORIGIN: 'http://127.0.0.1:3000'
    })),
    geoResolver,
    clock: { now: () => Date.parse('2026-07-17T00:00:00.000Z') },
    logger: { error() {}, info() {} }
  });

  assert.equal(typeof analytics.collectorMiddleware, 'function');
  assert.equal(typeof analytics.publicContextRouter, 'function');
  assert.equal(typeof analytics.adminApiRouter, 'function');
  assert.equal(typeof analytics.adminPageRouter, 'function');
  assert.equal(typeof analytics.lifecycle.start, 'function');
  assert.equal(typeof analytics.lifecycle.stop, 'function');
  assert.equal(analytics.geoStatus().updater.state, 'missing');

  await analytics.lifecycle.start();
  analytics.lifecycle.stop();
  assert.deepEqual(calls, ['geo:start', 'geo:stop']);
  assert.equal(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='access_metrics'").get().name, 'access_metrics');
  db.close();
});

test('server mounts context parsing before global JSON and collection before public surfaces', () => {
  const source = fs.readFileSync(path.resolve(__dirname, '..', 'server/index.js'), 'utf8');
  const contextIndex = source.indexOf('app.use(analyticsModule.publicContextRouter)');
  const jsonIndex = source.indexOf('app.use(express.json())');
  const collectorIndex = source.indexOf('app.use(analyticsModule.collectorMiddleware)');
  const staticIndex = source.indexOf("app.use(express.static(path.join(__dirname, '..', 'public')))" );

  assert.ok(contextIndex >= 0 && contextIndex < jsonIndex);
  assert.ok(jsonIndex < collectorIndex);
  assert.ok(collectorIndex < staticIndex);
});

test('detailed collector records exact event data after a successful HTML response', () => {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  initializeAnalytics(db);
  let finish;
  const response = {
    statusCode: 200,
    locals: {},
    on(event, listener) { if (event === 'finish') finish = listener; },
    getHeader(name) {
      return { 'content-type': 'text/html; charset=utf-8', 'content-length': undefined }[name.toLowerCase()];
    }
  };
  const headers = {
    'user-agent': 'Mozilla/5.0',
    'accept-language': 'zh-CN',
    referer: 'https://example.com/from?token=SECRET'
  };
  let now = Date.parse('2026-07-17T00:00:00.123Z');
  const middleware = createAnalyticsMiddleware({
    db,
    secret: VALID_SECRET,
    now: () => now,
    detailsEnabled: true,
    publicOrigin: 'https://blog.example.com',
    geoResolver: {
      resolve: () => ({ status: 'not_found', data: null }),
      getStatus: () => ({ reader: { datasetDate: '2026-07-01T00:00:00.000Z' } })
    },
    clientParser: { parse: () => ({ status: 'unknown', data: null }) },
    tokenSigner: {
      createEventId: () => '0123456789abcdef0123456789abcdef',
      sign: () => 'v1.fixture.signature'
    }
  });
  const request = {
    method: 'GET',
    path: '/tag/%E5%B7%A5%E5%85%B7',
    originalUrl: '/tag/%E5%B7%A5%E5%85%B7?utm_source=test',
    ip: '::ffff:203.0.113.10',
    get: name => headers[name.toLowerCase()]
  };

  middleware(request, response, () => {});
  assert.equal(response.locals.analyticsEventToken, 'v1.fixture.signature');
  now += 25;
  finish();

  const row = db.prepare('SELECT * FROM access_event_details').get();
  assert.equal(row.event_id, '0123456789abcdef0123456789abcdef');
  assert.equal(row.observed_at_utc, '2026-07-17T00:00:00.123Z');
  assert.equal(row.request_path, '/tag/%E5%B7%A5%E5%85%B7');
  assert.equal(row.query_string, 'utm_source=test');
  assert.equal(row.ip_address, '203.0.113.10');
  assert.equal(row.duration_ms, 25);
  assert.equal(row.response_bytes, null);
  assert.doesNotMatch(row.referrer, /SECRET/);
  db.close();
});

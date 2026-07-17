const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const Database = require('better-sqlite3');
const express = require('express');
const ejs = require('ejs');
const cookieParser = require('cookie-parser');
const { createAnalyticsModule } = require('../server/analytics/module');
const { validateClientContext } = require('../server/analytics/context-validator');
const { createEventTokenSigner } = require('../server/analytics/event-token');
const { generateToken } = require('../server/middleware/auth');

const SECRET = Buffer.alloc(32, 7);

async function createHarness(t) {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  const config = {
    detailsEnabled: true,
    hmacSecret: SECRET,
    retentionDays: 30,
    geoIpCityDbPath: '/fixture/GeoLite2-City.mmdb',
    geoIpUpdateStatusPath: '/fixture/update-status.json',
    publicOrigin: null
  };
  const geoResolver = {
    async start() {}, stop() {},
    resolve: () => ({ status: 'not_found', data: null }),
    getStatus: () => ({ reader: { datasetDate: '2026-07-01T00:00:00.000Z' }, updater: { state: 'ok', result: 'no-op' }, stale: false })
  };
  let analytics;
  const app = express();
  const server = http.createServer(app);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  config.publicOrigin = `http://127.0.0.1:${port}`;
  analytics = createAnalyticsModule({ db, config, geoResolver, logger: { error() {}, info() {} } });
  await analytics.lifecycle.start();

  app.set('view engine', 'ejs');
  app.set('views', path.resolve(__dirname, '..', 'views'));
  app.use(analytics.publicContextRouter);
  app.use(express.json());
  app.use(cookieParser());
  app.use('/api/admin/analytics', analytics.adminApiRouter);
  app.use(analytics.adminPageRouter);
  app.use(analytics.collectorMiddleware);
  app.get('/about', (req, res) => res.render('about', { user: null }));
  app.get('/auth/google/callback', (req, res) => res.type('html').send('<p>callback</p>'));
  app.use((req, res) => res.status(404).render('404', { user: null }));

  t.after(async () => {
    await new Promise(resolve => server.close(resolve));
    analytics.lifecycle.stop();
    db.close();
  });
  return {
    baseUrl: config.publicOrigin,
    db,
    adminCookie: `token=${generateToken({ id: 1, username: 'admin' })}`
  };
}

function tokenFrom(html) {
  const match = html.match(/<meta name="analytics-event-token" content="([^"]+)">/);
  assert.ok(match, 'analytics event token meta is missing');
  return match[1];
}

test('tracked public HTML is no-store and client context is idempotently attached to the same event', async t => {
  const { baseUrl, db } = await createHarness(t);
  const page = await fetch(`${baseUrl}/about`, { headers: { 'user-agent': 'Mozilla/5.0' } });
  const html = await page.text();
  const token = tokenFrom(html);
  assert.match(page.headers.get('cache-control') || '', /private/);
  assert.match(page.headers.get('cache-control') || '', /no-store/);
  assert.match(html, /\/js\/analytics-context\.js/);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM access_event_details').get().count, 1);

  const missing = await fetch(`${baseUrl}/missing`);
  assert.doesNotMatch(await missing.text(), /analytics-event-token/);
  const callback = await fetch(`${baseUrl}/auth/google/callback?code=SECRET&state=STATE`);
  assert.doesNotMatch(await callback.text(), /analytics-event-token|SECRET|STATE/);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM access_event_details').get().count, 1);

  const body = JSON.stringify({ context: {
    viewport: { width: 1280, height: 720 },
    screen: { width: 1920, height: 1080 },
    language: 'zh-CN',
    timezone: 'Asia/Shanghai'
  } });
  const send = payload => fetch(`${baseUrl}/api/analytics/client-context`, {
    method: 'POST',
    headers: {
      origin: baseUrl,
      'content-type': 'application/json',
      'x-analytics-event-token': token
    },
    body: payload
  });
  assert.equal((await send(body)).status, 204);
  assert.equal((await send(body)).status, 204);
  assert.equal((await send(JSON.stringify({ context: { viewport: { width: 800, height: 600 } } }))).status, 409);

  const stored = db.prepare('SELECT context_hash, viewport_width FROM access_event_details').get();
  assert.equal(stored.context_hash.length, 64);
  assert.equal(stored.viewport_width, 1280);
});

test('context endpoint enforces media type, origin, token, JSON size, and event readiness', async t => {
  const { baseUrl } = await createHarness(t);
  const signer = createEventTokenSigner({ secret: SECRET });
  const token = signer.sign('f'.repeat(32));
  const request = (headers, body = '{"context":{"language":"zh-CN"}}') => fetch(`${baseUrl}/api/analytics/client-context`, {
    method: 'POST', headers, body
  });

  assert.equal((await request({ origin: baseUrl, 'content-type': 'text/plain', 'x-analytics-event-token': token })).status, 415);
  assert.equal((await request({ origin: 'https://evil.example', 'content-type': 'application/json', 'x-analytics-event-token': token })).status, 403);
  assert.equal((await request({ origin: baseUrl, 'content-type': 'application/json', 'x-analytics-event-token': 'invalid' })).status, 401);
  assert.equal((await request({ origin: baseUrl, 'content-type': 'application/json', 'x-analytics-event-token': token }, '{')).status, 400);
  assert.equal((await request({ origin: baseUrl, 'content-type': 'application/json', 'x-analytics-event-token': token }, JSON.stringify({ context: { language: 'x'.repeat(17000) } }))).status, 413);
  const notReady = await request({ origin: baseUrl, 'content-type': 'application/json', 'x-analytics-event-token': token });
  assert.equal(notReady.status, 425);
  assert.equal(notReady.headers.get('retry-after'), '1');
});

test('admin analytics API/page require authentication, are no-store, and expose list/detail', async t => {
  const { baseUrl, adminCookie } = await createHarness(t);
  await fetch(`${baseUrl}/about`, { headers: { 'user-agent': 'Mozilla/5.0' } });
  const unauthorizedApi = await fetch(`${baseUrl}/api/admin/analytics/events`);
  assert.equal(unauthorizedApi.status, 401);
  assert.match(unauthorizedApi.headers.get('cache-control') || '', /no-store/);
  for (const [headers, expectedStatus] of [[{}, 401], [{ cookie: 'token=invalid' }, 403]]) {
    const unauthorizedPage = await fetch(`${baseUrl}/admin/analytics`, { headers });
    assert.equal(unauthorizedPage.status, expectedStatus);
    assert.match(unauthorizedPage.headers.get('cache-control') || '', /no-store/);
  }

  const listResponse = await fetch(`${baseUrl}/api/admin/analytics/events`, {
    headers: { cookie: adminCookie }
  });
  assert.equal(listResponse.status, 200);
  assert.match(listResponse.headers.get('cache-control') || '', /no-store/);
  const list = await listResponse.json();
  assert.equal(list.items.length, 1);
  const detailResponse = await fetch(`${baseUrl}/api/admin/analytics/events/${list.items[0].id}`, {
    headers: { cookie: adminCookie }
  });
  assert.equal(detailResponse.status, 200);
  assert.equal((await detailResponse.json()).raw.userAgent, 'Mozilla/5.0');

  const page = await fetch(`${baseUrl}/admin/analytics`, { headers: { cookie: adminCookie } });
  const html = await page.text();
  assert.equal(page.status, 200);
  assert.match(page.headers.get('cache-control') || '', /no-store/);
  assert.match(html, /逐次访问明细/);
  assert.match(html, /203\.0\.113|127\.0\.0\.1|::1/);
});

test('browser collector retries only 425 on immediate/1/2/4/8 second attempts', async () => {
  const source = fs.readFileSync(path.resolve(__dirname, '..', 'public/js/analytics-context.js'), 'utf8');
  const delays = [];
  const calls = [];
  const responses = [425, 425, 425, 425, 204];
  const context = {
    document: { querySelector: () => ({ content: 'v1.fixture.signature' }) },
    navigator: {
      language: 'zh-CN', languages: ['zh-CN'], hardwareConcurrency: 8,
      deviceMemory: 8, maxTouchPoints: 0,
      userAgentData: {
        brands: [{ brand: 'Chromium', version: '126' }], mobile: false, platform: 'Windows',
        async getHighEntropyValues() {
          return {
            brands: [{ brand: 'Chromium', version: '126' }], mobile: false, platform: 'Windows',
            architecture: 'x86', bitness: '64', model: '', platformVersion: '15.0.0',
            fullVersionList: [{ brand: 'Chromium', version: '126.0.0.0' }], wow64: false
          };
        }
      }
    },
    screen: { width: 1920, height: 1080, availWidth: 1920, availHeight: 1040, colorDepth: 24, pixelDepth: 24 },
    window: { innerWidth: 1280, innerHeight: 720, devicePixelRatio: 1 },
    Intl,
    JSON,
    fetch: async (...args) => {
      calls.push(args);
      const status = responses.shift();
      return { status, headers: { get: () => status === 425 ? '1' : null } };
    },
    setTimeout: (callback, delay) => {
      delays.push(delay);
      callback();
    }
  };
  context.window.navigator = context.navigator;
  context.window.screen = context.screen;
  context.window.fetch = context.fetch;
  context.window.setTimeout = context.setTimeout;

  await vm.runInNewContext(source, context);
  assert.equal(calls.length, 5);
  assert.deepEqual(delays, [1000, 2000, 4000, 8000]);
  assert.equal(calls[0][1].keepalive, true);
  assert.equal(calls[0][1].credentials, 'omit');
  assert.equal(calls[0][1].headers['X-Analytics-Event-Token'], 'v1.fixture.signature');
  const submitted = JSON.parse(calls[0][1].body);
  assert.deepEqual(Object.keys(submitted.context.userAgentData.highEntropy).sort(), [
    'architecture', 'bitness', 'fullVersionList', 'model', 'platformVersion', 'wow64'
  ]);
  assert.doesNotThrow(() => validateClientContext(submitted));
});

test('admin analytics view renders readable paths and hostile detail values as text-only UI', async () => {
  const emptyDimension = { items: [], distinctCount: 0, truncated: false, otherPageViews: 0 };
  const overview = {
    days: 7, pageViews: 1, anonymousVisitors: 1, detailCoverage: { pageViews: 1 },
    byHour: [], byDevice: [{ deviceKind: 'desktop', pageViews: 1 }],
    byPage: [{
      path: '/tag/%E5%B7%A5%E5%85%B7', displayPath: '/tag/工具', displayPathStatus: 'decoded',
      pageViews: 1, anonymousVisitors: 1
    }],
    byCountry: { ...emptyDimension, items: [{ key: 'CN', label: 'China', pageViews: 1 }], distinctCount: 1 },
    bySubdivision: { ...emptyDimension, items: [{ key: 'CN:unknown', label: 'China / Unknown', pageViews: 1 }], distinctCount: 1 },
    byCity: { ...emptyDimension, items: [{ key: 'unknown:unknown', label: 'Unknown / Unknown', pageViews: 1 }], distinctCount: 1 },
    byBrowser: emptyDimension,
    byOs: emptyDimension, byDeviceModel: emptyDimension, byReferrerHost: emptyDimension,
    geoData: { reader: { datasetDate: '2026-07-01T00:00:00.000Z', reloadStatus: 'ok' }, updater: { state: 'ok', result: 'no-op', lastSuccessAt: '2026-07-17T00:00:00.000Z' }, stale: false }
  };
  const events = {
    days: 7,
    nextCursor: null,
    items: [{
      id: '1'.repeat(32), observedAtUtc: '2026-07-17T00:00:00.000Z',
      requestPath: '/x/%3Cscript%3E', displayPath: '/x/<script>', displayPathStatus: 'decoded',
      fullUrl: 'https://blog.example.com/x', referrer: '"><img src=x onerror=alert(1)>',
      statusCode: 200, durationMs: 10, responseBytes: null, ipAddress: '203.0.113.10',
      location: { country: { code: 'CN', name: 'China' }, subdivision: { code: 'BJ', name: 'Beijing' }, city: 'Beijing' },
      client: { deviceType: 'desktop', vendor: null, model: null, os: { name: 'Windows', version: '11' }, browser: { name: 'Chrome', version: '126' }, engine: { name: 'Blink', version: '126' }, contextAvailable: true, sources: ['server', 'client-fetch'] }
    }]
  };
  const html = await ejs.renderFile(path.resolve(__dirname, '..', 'views/admin/analytics.ejs'), {
    overview,
    events,
    filters: { days: '7', ip: '', country: '', subdivision: '', city: '', browser: '', os: '', device: '', pathPrefix: '', referrerHost: '' },
    eventNextUrl: null,
    pageError: null,
    formatBeijingTime: value => value,
    user: { id: 1 }
  });
  assert.match(html, /\/tag\/工具/);
  assert.match(html, /\/tag\/%E5%B7%A5%E5%85%B7/);
  assert.match(html, /\/x\/&lt;script&gt;/);
  assert.doesNotMatch(html, /<img src=x onerror/);
  assert.doesNotMatch(html, /数据为匿名聚合，不保存原始 IP/);
  assert.match(html, /name="pathPrefix"/);
  assert.match(html, /id="analytics-detail-status"/);
  assert.match(html, /\/js\/admin-analytics\.js/);
  assert.doesNotMatch(html, /data-filter-value="(?:unknown:[^"]*|[^"]*:unknown)"/);

  const source = fs.readFileSync(path.resolve(__dirname, '..', 'public/js/admin-analytics.js'), 'utf8');
  assert.doesNotMatch(source, /innerHTML|insertAdjacentHTML|document\.write/);
  assert.match(source, /textContent/);
});

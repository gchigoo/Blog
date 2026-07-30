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

async function createHarness(t, overrides = {}) {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  const config = {
    detailsEnabled: true,
    hmacSecret: SECRET,
    retentionDays: 30,
    geoIpCityDbPath: '/fixture/GeoLite2-City.mmdb',
    geoIpUpdateStatusPath: '/fixture/update-status.json',
    publicOrigin: null,
    ...overrides.config
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

  app.set('trust proxy', 'loopback');
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
  const page = await fetch(`${baseUrl}/about`, { headers: { 'user-agent': 'Mozilla/5.0', 'x-forwarded-for': '203.0.113.10' } });
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

test('bot public HTML is stored without a browser context token or script', async t => {
  const { baseUrl, db } = await createHarness(t);
  const page = await fetch(`${baseUrl}/about`, {
    headers: {
      'user-agent': 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
      'x-forwarded-for': '203.0.113.40'
    }
  });
  const html = await page.text();

  assert.equal(page.status, 200);
  assert.doesNotMatch(html, /analytics-event-token/);
  assert.doesNotMatch(html, /\/js\/analytics-context\.js/);
  assert.deepEqual(
    db.prepare('SELECT traffic_kind, bot_name, context_collected_at FROM access_event_details').all(),
    [{ traffic_kind: 'bot', bot_name: 'Googlebot', context_collected_at: null }]
  );
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
  await fetch(`${baseUrl}/about`, { headers: { 'user-agent': 'Mozilla/5.0', 'x-forwarded-for': '203.0.113.10' } });
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
  const detail = await detailResponse.json();
  assert.equal(detail.raw.userAgent, 'Mozilla/5.0');
  assert.equal(detail.trafficKind, 'human');
  assert.equal(detail.botName, null);
  assert.deepEqual(detail.page, { kind: 'about', title: '关于', displayPath: '/about' });

  const botPage = await fetch(`${baseUrl}/about`, {
    headers: {
      'user-agent': 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
      'x-forwarded-for': '203.0.113.40'
    }
  });
  assert.equal(botPage.status, 200);
  const botListResponse = await fetch(`${baseUrl}/api/admin/analytics/events?traffic=bot`, {
    headers: { cookie: adminCookie }
  });
  assert.equal(botListResponse.status, 200);
  const botList = await botListResponse.json();
  assert.equal(botList.items.length, 1);
  assert.equal(botList.items[0].trafficKind, 'bot');
  assert.equal(botList.items[0].botName, 'Googlebot');
  assert.equal(botList.items[0].page.title, '关于');

  const invalid = await fetch(`${baseUrl}/api/admin/analytics/events?traffic=robot`, {
    headers: { cookie: adminCookie }
  });
  assert.equal(invalid.status, 400);
  assert.deepEqual(await invalid.json(), {
    error: 'invalid_filter', field: 'traffic', reason: 'unsupported_value'
  });

  const page = await fetch(`${baseUrl}/admin/analytics`, { headers: { cookie: adminCookie } });
  const html = await page.text();
  assert.equal(page.status, 200);
  assert.match(page.headers.get('cache-control') || '', /no-store/);
  assert.match(html, /逐次访问明细/);
  assert.match(html, /203\.0\.113|127\.0\.0\.1|::1/);

  const operaSearch = await fetch(
    `${baseUrl}/admin/analytics?days=7&search=about&traffic=human&ip=&country=&subdivision=&city=&browser=opera&os=&device=&pathPrefix=&referrerHost=`,
    { headers: { cookie: adminCookie } }
  );
  const operaHtml = await operaSearch.text();
  assert.equal(operaSearch.status, 200);
  assert.doesNotMatch(operaHtml, /筛选条件无效/);
  assert.match(operaHtml, /name="browser" value="opera"/);

  const paged = await fetch(`${baseUrl}/admin/analytics?days=7&search=about&traffic=all&limit=1`, {
    headers: { cookie: adminCookie }
  });
  const pagedHtml = await paged.text();
  assert.equal(paged.status, 200);
  assert.match(pagedHtml, /href="\/admin\/analytics\?[^"#]*search=about[^"#]*traffic=all[^"#]*cursor=[^"#]+#event-list"/);
});

test('admin retained-detail API and SSR are unavailable when details collection is disabled', async t => {
  const { baseUrl, adminCookie, db } = await createHarness(t, {
    config: {
      detailsEnabled: false,
      geoIpCityDbPath: null,
      geoIpUpdateStatusPath: null
    }
  });
  db.prepare(`
    INSERT INTO access_metrics (bucket_utc, path, visitor_day_hmac, device_kind, traffic_kind)
    VALUES (?, '/retained', 'retained', 'desktop', 'human')
  `).run(new Date().toISOString());

  for (const pathname of ['/api/admin/analytics/events', `/api/admin/analytics/events/${'f'.repeat(32)}`]) {
    const response = await fetch(`${baseUrl}${pathname}`, { headers: { cookie: adminCookie } });
    assert.equal(response.status, 409);
    assert.deepEqual(await response.json(), { error: 'analytics_details_disabled' });
  }

  const page = await fetch(`${baseUrl}/admin/analytics`, { headers: { cookie: adminCookie } });
  const html = await page.text();
  assert.equal(page.status, 200);
  assert.match(html, /今日活跃访客/);
  assert.match(html, /独立 IP/);
  assert.match(html, /真人访问量/);
  assert.match(html, /爬虫访问量/);
  assert.match(html, /未启用访问明细/);
  assert.doesNotMatch(html, /203\.0\.113|127\.0\.0\.1|::1/);
  assert.doesNotMatch(html, /analytics-event-table|analytics-event-cards|analytics-filter-form|analytics-detail-panel|admin-analytics\.js/);
});

test('admin page hides ranges beyond retention and includes the configured retention range', async t => {
  const { baseUrl, adminCookie } = await createHarness(t, { config: { retentionDays: 10 } });
  const page = await fetch(`${baseUrl}/admin/analytics`, { headers: { cookie: adminCookie } });
  const html = await page.text();
  assert.equal(page.status, 200);
  assert.match(html, /days=1/);
  assert.match(html, /days=7/);
  assert.match(html, /days=10/);
  assert.doesNotMatch(html, /days=30/);
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
    days: 7,
    todayActiveVisitors: 1,
    uniqueHumanIps: 1,
    humanPageViews: 1,
    botPageViews: 1,
    detailsAvailable: true,
    detailsComplete: true,
    pageViews: 1,
    anonymousVisitors: 1,
    detailCoverage: { pageViews: 1, humanPageViews: 1, complete: true },
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
    available: true,
    items: [{
      id: '1'.repeat(32), observedAtUtc: '2026-07-17T00:00:00.000Z',
      requestPath: '/x/%3Cscript%3E', displayPath: '/x/<script>', displayPathStatus: 'decoded',
      trafficKind: 'human', botName: null,
      page: { kind: 'article', title: '<svg onload=alert(2)>', displayPath: '/x/<script>' },
      fullUrl: 'https://blog.example.com/x', referrer: '"><img src=x onerror=alert(1)>',
      statusCode: 200, durationMs: 10, responseBytes: null, ipAddress: '203.0.113.10',
      location: { country: { code: 'CN', name: 'China' }, subdivision: { code: 'BJ', name: 'Beijing' }, city: 'Beijing' },
      client: { deviceType: 'desktop', vendor: null, model: null, os: { name: 'Windows', version: '11' }, browser: { name: 'Chrome', version: '126' }, engine: { name: 'Blink', version: '126' }, contextAvailable: true, sources: ['server', 'client-fetch'] }
    }, {
      id: '2'.repeat(32), observedAtUtc: '2026-07-16T23:00:00.000Z',
      requestPath: '/article/deleted', displayPath: '/article/deleted', displayPathStatus: 'unchanged',
      trafficKind: 'bot', botName: 'Googlebot',
      page: { kind: 'article', title: '文章（已删除或未知）', displayPath: '/article/deleted' },
      fullUrl: 'https://blog.example.com/article/deleted', referrer: null,
      statusCode: 200, durationMs: 8, responseBytes: null, ipAddress: '2001:db8::2',
      location: { country: { code: 'US', name: 'United States' }, subdivision: { code: null, name: null }, city: null },
      client: { deviceType: 'other', vendor: null, model: null, os: { name: null, version: null }, browser: { name: null, version: null }, engine: { name: null, version: null }, contextAvailable: false, sources: ['server'] }
    }]
  };
  const html = await ejs.renderFile(path.resolve(__dirname, '..', 'views/admin/analytics.ejs'), {
    overview,
    events,
    filters: { days: '7', search: '', traffic: 'all', ip: '', country: '', subdivision: '', city: '', browser: '', os: '', device: '', pathPrefix: '', referrerHost: '' },
    eventNextUrl: '/admin/analytics?days=7&traffic=all&cursor=fixture#event-list',
    pageError: null,
    rangeOptions: [1, 7, 30],
    systemStatus: {
      detailsEnabled: true,
      geoData: overview.geoData,
      warning: { severity: 'error', message: 'Geo warning fixture' }
    },
    formatBeijingTime: value => value,
    user: { id: 1 }
  });
  const overviewIndex = html.indexOf('id="analytics-overview"');
  const eventsIndex = html.indexOf('id="event-list"');
  const moreIndex = html.indexOf('id="analytics-more"');
  const systemIndex = html.indexOf('id="analytics-system-status"');
  assert.ok(overviewIndex >= 0 && overviewIndex < eventsIndex);
  assert.ok(eventsIndex < moreIndex && moreIndex < systemIndex);
  assert.match(html, /今日活跃访客/);
  assert.match(html, /独立 IP/);
  assert.match(html, /真人访问量/);
  assert.match(html, /爬虫访问量/);
  assert.match(html, /name="search"/);
  assert.match(html, /name="traffic"/);
  assert.match(html, /<details[^>]*id="analytics-more"/);
  assert.match(html, /href="[^"]*#event-list"/);
  assert.match(html, /文章（已删除或未知）/);
  assert.match(html, /data-traffic-kind="bot"/);
  assert.match(html, /Geo warning fixture/);
  assert.equal((html.match(/Geo warning fixture/g) || []).length, 1);
  assert.match(html, /\/tag\/工具/);
  assert.match(html, /&lt;svg onload=alert\(2\)&gt;/);
  assert.match(html, /\/x\/&lt;script&gt;/);
  assert.doesNotMatch(html, /原始编码/);
  assert.doesNotMatch(html, /\/tag\/%E5%B7%A5%E5%85%B7/);
  assert.doesNotMatch(html, /<img src=x onerror/);
  assert.doesNotMatch(html, /<svg onload=alert/);
  assert.doesNotMatch(html, /数据为匿名聚合，不保存原始 IP/);
  assert.match(html, /name="pathPrefix"/);
  assert.match(html, /id="analytics-event-summary"/);
  assert.match(html, /id="analytics-event-table-body"/);
  assert.match(html, /id="analytics-event-cards"/);
  assert.match(html, /data-analytics-page="previous"/);
  assert.match(html, /data-analytics-page="next"/);
  assert.match(html, /id="analytics-event-status"/);
  assert.match(html, /id="analytics-detail-status"/);
  assert.match(html, /\/js\/admin-analytics\.js/);
  assert.doesNotMatch(html, /data-filter-value="(?:unknown:[^"]*|[^"]*:unknown)"/);
  const eventListHtml = html.slice(eventsIndex, moreIndex);
  assert.doesNotMatch(eventListHtml, /&quot;&gt;&lt;img src=x onerror=alert\(1\)&gt;|直接访问\/未知/);

  const source = fs.readFileSync(path.resolve(__dirname, '..', 'public/js/admin-analytics.js'), 'utf8');
  assert.doesNotMatch(source, /innerHTML|insertAdjacentHTML|document\.write/);
  assert.match(source, /textContent/);
});

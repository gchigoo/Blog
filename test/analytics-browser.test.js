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
const { recordAccessEvent } = require('../server/analytics/repository');
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
  // A redirect route deliberately mounted AFTER the collector: the hardened
  // middleware must never persist it regardless of future mount-order changes.
  app.get('/redirect-fixture', (req, res) => res.redirect(302, '/about'));
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

function occurrenceCount(html, marker) {
  return html.split(marker).length - 1;
}

function decodeHtmlAttribute(value) {
  return value.replaceAll('&#38;', '&').replaceAll('&amp;', '&');
}

function assertEnabledWorkspaceHooksOnce(html) {
  for (const marker of [
    'id="event-list"',
    'id="analytics-event-summary"',
    'id="analytics-event-table-body"',
    'id="analytics-event-cards"',
    'id="analytics-event-status"',
    'id="analytics-filter-form"',
    'data-analytics-page="previous"',
    'data-analytics-page="next"'
  ]) {
    assert.equal(occurrenceCount(html, marker), 1, `${marker} must appear exactly once`);
  }
}

function assertAnalyticsTopLevelOrder(html) {
  const headingIndex = html.indexOf('class="analytics-heading"');
  const overviewIndex = html.indexOf('id="analytics-overview"');
  const eventsIndex = html.indexOf('id="event-list"');
  const moreIndex = html.indexOf('id="analytics-more"');
  const systemIndex = html.indexOf('id="analytics-system-status"');
  const detailIndex = html.indexOf('id="analytics-detail-status"');
  assert.ok(headingIndex >= 0 && headingIndex < overviewIndex);
  assert.ok(overviewIndex < eventsIndex);
  assert.ok(eventsIndex < moreIndex);
  assert.ok(moreIndex < systemIndex);
  assert.ok(systemIndex < detailIndex);
}

test('tracked public HTML is no-store and client context is idempotently attached to the same event', async t => {
  const { baseUrl, db } = await createHarness(t);
  const page = await fetch(`${baseUrl}/about`, {
    headers: {
      'user-agent': 'Mozilla/5.0',
      accept: 'text/html',
      'x-forwarded-for': '203.0.113.10'
    }
  });
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

test('collector never records redirects even when mounted before the redirect route', async t => {
  const { baseUrl, db } = await createHarness(t);
  const headers = {
    'user-agent': 'Mozilla/5.0',
    accept: 'text/html',
    'x-forwarded-for': '203.0.113.66'
  };
  const hop = await fetch(`${baseUrl}/redirect-fixture?utm=hop`, { redirect: 'manual', headers });
  assert.equal(hop.status, 302);
  await fetch(`${baseUrl}/about`, { headers });
  assert.equal((await fetch(`${baseUrl}/missing-page`, { headers })).status, 404);

  assert.deepEqual(
    db.prepare('SELECT path FROM access_metrics ORDER BY id').all().map(row => row.path),
    ['/about'],
    'the 302 hop and the 404 must not create metrics'
  );
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM access_event_details').get().count, 1);
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
  await fetch(`${baseUrl}/about`, {
    headers: {
      'user-agent': 'Mozilla/5.0',
      accept: 'text/html',
      'x-forwarded-for': '203.0.113.10'
    }
  });
  const unauthorizedApi = await fetch(`${baseUrl}/api/admin/analytics/events`);
  assert.equal(unauthorizedApi.status, 401);
  assert.match(unauthorizedApi.headers.get('cache-control') || '', /no-store/);
  for (const [headers, expectedStatus] of [[{}, 401], [{ cookie: 'token=invalid' }, 403]]) {
    const unauthorizedPage = await fetch(`${baseUrl}/admin/analytics`, { headers });
    assert.equal(unauthorizedPage.status, expectedStatus);
    assert.match(unauthorizedPage.headers.get('cache-control') || '', /no-store/);
  }

  const invalidOverview = await fetch(`${baseUrl}/api/admin/analytics?days=7days`, {
    headers: { cookie: adminCookie }
  });
  assert.equal(invalidOverview.status, 400);
  assert.deepEqual(await invalidOverview.json(), { error: 'invalid_filter' });

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
  assert.match(html, /id="event-list"[^>]*data-analytics-enhancement="enabled"/);
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
  assert.match(pagedHtml, /href="\/admin\/analytics\?[^"#]*search=about[^"#]*traffic=all[^"#]*limit=1[^"#]*cursor=[^"#]+#event-list"/);

  const geographic = await fetch(
    `${baseUrl}/admin/analytics?days=7&traffic=human&search=about&country=CN&subdivision=beijing&city=beijing&browser=opera&limit=1&opaque=kept&opaque=again`,
    { headers: { cookie: adminCookie } }
  );
  const geographicHtml = await geographic.text();
  assert.equal(geographic.status, 200);
  const countryLink = geographicHtml.match(/<a[^>]+href="([^"]+)"[^>]+data-analytics-remove-filter="country"/);
  assert.ok(countryLink, 'country removal chip must be rendered');
  const countryRemovalUrl = new URL(decodeHtmlAttribute(countryLink[1]), baseUrl);
  assert.equal(countryRemovalUrl.searchParams.has('country'), false);
  assert.equal(countryRemovalUrl.searchParams.has('subdivision'), false);
  assert.equal(countryRemovalUrl.searchParams.has('city'), false);
  assert.equal(countryRemovalUrl.searchParams.get('browser'), 'opera');
  assert.equal(countryRemovalUrl.searchParams.get('search'), 'about');
  assert.equal(countryRemovalUrl.searchParams.get('traffic'), 'human');
  assert.equal(countryRemovalUrl.searchParams.get('limit'), '1');
  assert.deepEqual(countryRemovalUrl.searchParams.getAll('opaque'), ['kept', 'again']);
  assert.equal(countryRemovalUrl.searchParams.has('cursor'), false);
  assert.equal(countryRemovalUrl.hash, '#event-list');

  const countryRemoval = await fetch(countryRemovalUrl, { headers: { cookie: adminCookie } });
  const countryRemovalHtml = await countryRemoval.text();
  assert.equal(countryRemoval.status, 200);
  assert.match(countryRemovalHtml, /name="browser" value="opera"/);
  assert.match(countryRemovalHtml, /逐次访问明细/);
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

test('admin analytics invalid query remains a local alert when details are disabled', async t => {
  const { baseUrl, adminCookie, db } = await createHarness(t, {
    config: {
      detailsEnabled: false,
      geoIpCityDbPath: null,
      geoIpUpdateStatusPath: null
    }
  });
  const observedAt = new Date().toISOString();
  db.prepare(`
    INSERT INTO access_metrics (bucket_utc, path, visitor_day_hmac, device_kind, traffic_kind)
    VALUES (?, '/aggregate-ranking-visible', 'aggregate-ranking-visible', 'desktop', 'human')
  `).run(observedAt);
  const retainedMetric = db.prepare(`
    INSERT INTO access_metrics (bucket_utc, path, visitor_day_hmac, device_kind, traffic_kind)
    VALUES (?, '/retained-detail-parent', 'retained-detail-parent', 'mobile', 'human')
  `).run(observedAt);
  db.prepare(`
    INSERT INTO access_event_details (
      metric_id, event_id, observed_at_utc, method, request_path, full_url,
      referrer, referrer_host, url_sanitization_status, referrer_parse_status,
      status_code, duration_ms, response_bytes, ip_address, ip_family, geo_status,
      user_agent, accept_language, request_client_hints_json, device_type,
      device_model, device_model_normalized, device_type_normalized, browser_name,
      browser_version, browser_name_normalized, client_parse_status, traffic_kind,
      bot_name, context_source
    ) VALUES (?, ?, ?, 'GET', '/retained-detail-parent',
      'https://blog.example.com/retained-detail-parent', ?, 'sensitive-referrer.example',
      'ok', 'ok', 200, 17, 2048, ?, 4, 'not_found', ?, 'zh-CN', '{}', 'mobile',
      'SensitiveDeviceMarker', 'sensitivedevicemarker', 'mobile',
      'SensitiveBrowserMarker', '9.9', 'sensitivebrowsermarker',
      'parsed', 'human', NULL, 'server')
  `).run(
    Number(retainedMetric.lastInsertRowid),
    'deadbeefdeadbeefdeadbeefdeadbeef',
    observedAt,
    'https://sensitive-referrer.example/private-marker',
    '198.51.100.244',
    'SensitiveRetainedAgent/9.9'
  );
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM access_event_details').get().count, 1);

  const page = await fetch(`${baseUrl}/admin/analytics?traffic=robot`, {
    headers: { cookie: adminCookie }
  });
  const html = await page.text();
  assert.equal(page.status, 400);
  assert.equal(occurrenceCount(html, 'id="analytics-event-status"'), 1);
  assert.equal(occurrenceCount(html, '筛选条件无效，请检查输入后重试。'), 1);
  assert.match(html, /id="analytics-event-status"[^>]*class="[^"]*error[^"]*"[^>]*role="alert"[^>]*>筛选条件无效，请检查输入后重试。/);
  const headingIndex = html.indexOf('class="analytics-heading"');
  const overviewIndex = html.indexOf('id="analytics-overview"');
  const eventsIndex = html.indexOf('id="event-list"');
  const moreIndex = html.indexOf('id="analytics-more"');
  const systemIndex = html.indexOf('id="analytics-system-status"');
  assert.ok(headingIndex >= 0 && headingIndex < overviewIndex);
  assert.ok(overviewIndex < eventsIndex && eventsIndex < moreIndex && moreIndex < systemIndex);
  assert.match(html, /\/aggregate-ranking-visible/);
  for (const sensitiveMarker of [
    '198.51.100.244',
    'deadbeefdeadbeefdeadbeefdeadbeef',
    'https://sensitive-referrer.example/private-marker',
    'SensitiveRetainedAgent/9.9',
    'SensitiveBrowserMarker',
    'SensitiveDeviceMarker'
  ]) {
    assert.doesNotMatch(html, new RegExp(sensitiveMarker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
  assert.doesNotMatch(html, /203\.0\.113|127\.0\.0\.1|::1/);
  assert.equal(occurrenceCount(html, 'id="analytics-detail-status"'), 0);
  assert.doesNotMatch(html, /analytics-event-table|analytics-event-cards|analytics-filter-form|analytics-detail-panel|admin-analytics\.js|data-analytics-page=/);
  assert.doesNotMatch(html, /访问明细未启用；此处不提供已保留或历史逐次访问数据。/);
});

test('details-disabled hostile pageError is escaped through one local alert', async () => {
  const emptyDimension = { items: [], distinctCount: 0, truncated: false, otherPageViews: 0 };
  const hostileError = '"><img data-page-error-injected src=x onerror=alert(8)>';
  const html = await ejs.renderFile(path.resolve(__dirname, '..', 'views/admin/analytics.ejs'), {
    overview: {
      days: 7,
      todayActiveVisitors: 0,
      uniqueHumanIps: null,
      humanPageViews: 0,
      botPageViews: 0,
      detailsAvailable: false,
      detailsComplete: false,
      pageViews: 0,
      anonymousVisitors: 0,
      detailCoverage: { pageViews: 0, humanPageViews: 0, complete: false },
      byHour: [], byDevice: [], byPage: [],
      byCountry: emptyDimension, bySubdivision: emptyDimension, byCity: emptyDimension,
      byBrowser: emptyDimension, byOs: emptyDimension, byDeviceModel: emptyDimension,
      byReferrerHost: emptyDimension, geoData: null
    },
    events: { available: false, days: 7, items: [], nextCursor: null },
    filters: { days: '7', search: '', traffic: 'all', ip: '', country: '', subdivision: '', city: '', browser: '', os: '', device: '', pathPrefix: '', referrerHost: '' },
    eventPreviousUrl: null,
    eventNextUrl: null,
    pageError: hostileError,
    analyticsEnhancementEnabled: false,
    rangeOptions: [1, 7, 30],
    systemStatus: { detailsEnabled: false, geoData: null, warning: null },
    formatBeijingTime: value => value,
    user: { id: 1 }
  });

  assert.equal(occurrenceCount(html, 'id="analytics-event-status"'), 1);
  assert.match(html, /id="analytics-event-status"[^>]*role="alert"[^>]*>&#34;&gt;&lt;img data-page-error-injected src=x onerror=alert\(8\)&gt;<\/p>/);
  assert.equal(occurrenceCount(html, '&#34;&gt;&lt;img data-page-error-injected src=x onerror=alert(8)&gt;'), 1);
  assert.doesNotMatch(html, /<img data-page-error-injected|\sdata-page-error-injected=/);
  const headingIndex = html.indexOf('class="analytics-heading"');
  const overviewIndex = html.indexOf('id="analytics-overview"');
  const eventsIndex = html.indexOf('id="event-list"');
  const moreIndex = html.indexOf('id="analytics-more"');
  const systemIndex = html.indexOf('id="analytics-system-status"');
  assert.ok(headingIndex >= 0 && headingIndex < overviewIndex);
  assert.ok(overviewIndex < eventsIndex && eventsIndex < moreIndex && moreIndex < systemIndex);
});

test('admin analytics SSR keeps enabled-empty list containers and stable hooks unique', async t => {
  const { baseUrl, adminCookie } = await createHarness(t);
  const page = await fetch(`${baseUrl}/admin/analytics?search=no-matching-visit`, {
    headers: { cookie: adminCookie }
  });
  const html = await page.text();
  assert.equal(page.status, 200);
  assert.match(html, /暂无符合条件的访问明细/);
  assertEnabledWorkspaceHooksOnce(html);
  assertAnalyticsTopLevelOrder(html);
});

test('admin analytics invalid-query SSR preserves order and reports through the local error hook', async t => {
  const { baseUrl, adminCookie } = await createHarness(t);
  const page = await fetch(`${baseUrl}/admin/analytics?traffic=robot`, {
    headers: { cookie: adminCookie }
  });
  const html = await page.text();
  assert.equal(page.status, 400);
  assert.match(html, /id="event-list"[^>]*data-analytics-enhancement="disabled"/);
  assertAnalyticsTopLevelOrder(html);
  assertEnabledWorkspaceHooksOnce(html);
  assert.equal(occurrenceCount(html, '筛选条件无效，请检查输入后重试。'), 1);
  assert.match(html, /id="analytics-event-status"[^>]*class="[^"]*error[^"]*"[^>]*role="alert"[^>]*>筛选条件无效，请检查输入后重试。/);
  const headingEnd = html.indexOf('</header>');
  const overviewIndex = html.indexOf('id="analytics-overview"');
  assert.doesNotMatch(html.slice(headingEnd, overviewIndex), /role="alert"|筛选条件无效/);
});

test('admin analytics structurally invalid cursors are SSR errors with enhancement disabled', async t => {
  const { baseUrl, adminCookie } = await createHarness(t);
  const page = await fetch(`${baseUrl}/admin/analytics?cursor=abc`, {
    headers: { cookie: adminCookie }
  });
  const html = await page.text();
  assert.equal(page.status, 400);
  assert.match(html, /id="event-list"[^>]*data-analytics-enhancement="disabled"/);
  assert.match(html, /筛选条件无效，请检查输入后重试。/);
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

test('admin analytics API and page present localized labels for article, taxonomy, static, and search paths', async t => {
  const { baseUrl, adminCookie, db } = await createHarness(t);
  db.exec(`
    CREATE TABLE articles (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      slug TEXT NOT NULL,
      locale TEXT NOT NULL DEFAULT 'zh' CHECK (locale IN ('zh', 'en')),
      status TEXT NOT NULL DEFAULT 'published',
      UNIQUE(locale, slug)
    );
    CREATE TABLE tag_labels (
      tag_id TEXT NOT NULL,
      locale TEXT NOT NULL,
      name TEXT NOT NULL,
      slug TEXT NOT NULL,
      PRIMARY KEY(tag_id, locale),
      UNIQUE(locale, slug)
    );
    CREATE TABLE category_labels (
      category_id TEXT NOT NULL,
      locale TEXT NOT NULL,
      name TEXT NOT NULL,
      slug TEXT NOT NULL,
      PRIMARY KEY(category_id, locale),
      UNIQUE(locale, slug)
    );
  `);
  db.prepare('INSERT INTO articles (title, slug, locale) VALUES (?, ?, ?)').run('中文标题', 'twin', 'zh');
  db.prepare('INSERT INTO articles (title, slug, locale) VALUES (?, ?, ?)').run('English Title', 'twin', 'en');
  db.prepare('INSERT INTO tag_labels (tag_id, locale, name, slug) VALUES (?, ?, ?, ?)').run('tools', 'zh', '工具', '工具');
  db.prepare('INSERT INTO tag_labels (tag_id, locale, name, slug) VALUES (?, ?, ?, ?)').run('tools', 'en', 'Tools', 'tools');
  db.prepare('INSERT INTO category_labels (category_id, locale, name, slug) VALUES (?, ?, ?, ?)').run('tech', 'zh', '技术', '技术');
  db.prepare('INSERT INTO category_labels (category_id, locale, name, slug) VALUES (?, ?, ?, ?)').run('tech', 'en', 'Technology', 'technology');

  const localizedEvent = (id, requestPath, overrides = {}) => {
    const observedAtUtc = new Date().toISOString();
    return {
      eventId: id.toString(16).padStart(32, '0'),
      observedAtUtc,
      bucketUtc: new Date(Math.floor(Date.parse(observedAtUtc) / 3_600_000) * 3_600_000).toISOString(),
      path: requestPath,
      visitorDayHmac: `visitor-${id}`,
      deviceKind: 'desktop',
      trafficKind: 'human',
      botName: null,
      method: 'GET',
      requestPath,
      queryString: null,
      fullUrl: `https://blog.example.com${requestPath}`,
      referrer: null,
      referrerHost: null,
      urlSanitizationStatus: 'ok',
      referrerParseStatus: 'ok',
      statusCode: 200,
      durationMs: 10,
      responseBytes: 1000,
      ipAddress: `203.0.113.${id}`,
      ipFamily: 4,
      geo: { status: 'not_found', data: null, datasetDate: null },
      requestClient: { userAgent: `Mozilla/${id}`, acceptLanguage: 'zh-CN', clientHints: {} },
      client: {
        status: 'parsed',
        data: {
          browserName: 'Chrome', browserVersion: '1', browserNameNormalized: 'chrome',
          osName: 'Windows', osNameNormalized: 'windows',
          deviceType: 'desktop', deviceTypeNormalized: 'desktop'
        }
      },
      ...overrides
    };
  };

  recordAccessEvent(db, localizedEvent(1, '/zh/article/twin'));
  recordAccessEvent(db, localizedEvent(2, '/en/article/twin'));
  recordAccessEvent(db, localizedEvent(3, '/zh/tag/%E5%B7%A5%E5%85%B7'));
  recordAccessEvent(db, localizedEvent(4, '/zh/category/%E6%8A%80%E6%9C%AF'));
  recordAccessEvent(db, localizedEvent(5, '/zh/search', {
    fullUrl: 'https://blog.example.com/zh/search?q=%E9%83%A8%E7%BD%B2'
  }));
  recordAccessEvent(db, localizedEvent(6, '/zh/article/unknown'));

  const listResponse = await fetch(`${baseUrl}/api/admin/analytics/events`, {
    headers: { cookie: adminCookie }
  });
  assert.equal(listResponse.status, 200);
  const list = await listResponse.json();
  const byPath = new Map(list.items.map(item => [item.requestPath, item]));
  assert.equal(byPath.get('/zh/article/twin').page.title, '中文标题');
  assert.equal(byPath.get('/en/article/twin').page.title, 'English Title');
  assert.equal(byPath.get('/zh/tag/%E5%B7%A5%E5%85%B7').page.title, '标签：工具');
  assert.equal(byPath.get('/zh/category/%E6%8A%80%E6%9C%AF').page.title, '分类：技术');
  assert.equal(byPath.get('/zh/search').page.title, '搜索');
  assert.doesNotMatch(JSON.stringify(byPath.get('/zh/search').page), /q=|%E9%83%A8%E7%BD%B2/);
  assert.equal(byPath.get('/zh/article/unknown').page.title, '文章（已删除或未知）');

  const page = await fetch(`${baseUrl}/admin/analytics`, { headers: { cookie: adminCookie } });
  const html = await page.text();
  assert.equal(page.status, 200);
  assert.match(html, /中文标题/);
  assert.match(html, /English Title/);
  assert.match(html, /标签：工具/);
  assert.match(html, /分类：技术/);
  assert.match(html, /<strong>搜索<\/strong>\s*<code class="analytics-break">\/zh\/search<\/code>/);
  assert.match(html, /文章（已删除或未知）/);
  assert.match(html, /\/zh\/tag\/工具/);
  assert.doesNotMatch(html, /q=%E9%83%A8%E7%BD%B2/);
});

test('admin analytics strips percent-encoded query/fragment payloads from stored labels', async t => {
  const { baseUrl, adminCookie, db } = await createHarness(t);
  db.exec(`
    CREATE TABLE articles (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      slug TEXT NOT NULL,
      locale TEXT NOT NULL DEFAULT 'zh' CHECK (locale IN ('zh', 'en')),
      status TEXT NOT NULL DEFAULT 'published',
      UNIQUE(locale, slug)
    );
    CREATE TABLE tag_labels (
      tag_id TEXT NOT NULL,
      locale TEXT NOT NULL,
      name TEXT NOT NULL,
      slug TEXT NOT NULL,
      PRIMARY KEY(tag_id, locale),
      UNIQUE(locale, slug)
    );
    CREATE TABLE category_labels (
      category_id TEXT NOT NULL,
      locale TEXT NOT NULL,
      name TEXT NOT NULL,
      slug TEXT NOT NULL,
      PRIMARY KEY(category_id, locale),
      UNIQUE(locale, slug)
    );
  `);
  db.prepare('INSERT INTO articles (title, slug, locale) VALUES (?, ?, ?)').run('中文标题', 'twin', 'zh');
  db.prepare('INSERT INTO tag_labels (tag_id, locale, name, slug) VALUES (?, ?, ?, ?)').run('tools', 'zh', '工具', '工具');
  db.prepare('INSERT INTO category_labels (category_id, locale, name, slug) VALUES (?, ?, ?, ?)').run('tech', 'zh', '技术', '技术');

  const localizedEvent = (id, requestPath) => {
    const observedAtUtc = new Date().toISOString();
    return {
      eventId: id.toString(16).padStart(32, '0'),
      observedAtUtc,
      bucketUtc: new Date(Math.floor(Date.parse(observedAtUtc) / 3_600_000) * 3_600_000).toISOString(),
      path: requestPath,
      visitorDayHmac: `visitor-${id}`,
      deviceKind: 'desktop',
      trafficKind: 'human',
      botName: null,
      method: 'GET',
      requestPath,
      queryString: null,
      fullUrl: `https://blog.example.com${requestPath}`,
      referrer: null,
      referrerHost: null,
      urlSanitizationStatus: 'ok',
      referrerParseStatus: 'ok',
      statusCode: 200,
      durationMs: 10,
      responseBytes: 1000,
      ipAddress: `203.0.113.${id}`,
      ipFamily: 4,
      geo: { status: 'not_found', data: null, datasetDate: null },
      requestClient: { userAgent: `Mozilla/${id}`, acceptLanguage: 'zh-CN', clientHints: {} },
      client: {
        status: 'parsed',
        data: {
          browserName: 'Chrome', browserVersion: '1', browserNameNormalized: 'chrome',
          osName: 'Windows', osNameNormalized: 'windows',
          deviceType: 'desktop', deviceTypeNormalized: 'desktop'
        }
      }
    };
  };

  recordAccessEvent(db, localizedEvent(1, '/zh/search%3Fq%3D%E9%83%A8%E7%BD%B2'));
  recordAccessEvent(db, localizedEvent(2, '/zh/article/twin%3Futm_source%3Dfeed'));
  recordAccessEvent(db, localizedEvent(3, '/zh/tag/%E5%B7%A5%E5%85%B7%23extra'));
  recordAccessEvent(db, localizedEvent(4, '/zh/category/%E6%8A%80%E6%9C%AF%3Fsort%3Dnew'));

  const listResponse = await fetch(`${baseUrl}/api/admin/analytics/events`, {
    headers: { cookie: adminCookie }
  });
  assert.equal(listResponse.status, 200);
  const list = await listResponse.json();
  const byPath = new Map(list.items.map(item => [item.requestPath, item]));
  assert.equal(byPath.get('/zh/search%3Fq%3D%E9%83%A8%E7%BD%B2').requestPath, '/zh/search%3Fq%3D%E9%83%A8%E7%BD%B2');
  assert.deepEqual(byPath.get('/zh/search%3Fq%3D%E9%83%A8%E7%BD%B2').page, {
    kind: 'search', title: '搜索', displayPath: '/zh/search'
  });
  assert.deepEqual(byPath.get('/zh/article/twin%3Futm_source%3Dfeed').page, {
    kind: 'article', title: '中文标题', displayPath: '/zh/article/twin'
  });
  assert.deepEqual(byPath.get('/zh/tag/%E5%B7%A5%E5%85%B7%23extra').page, {
    kind: 'tag', title: '标签：工具', displayPath: '/zh/tag/工具'
  });
  assert.deepEqual(byPath.get('/zh/category/%E6%8A%80%E6%9C%AF%3Fsort%3Dnew').page, {
    kind: 'category', title: '分类：技术', displayPath: '/zh/category/技术'
  });
  for (const item of list.items) {
    assert.doesNotMatch(JSON.stringify(item.page), /[?#]|%E9%83%A8%E7%BD%B2/);
  }

  const page = await fetch(`${baseUrl}/admin/analytics`, { headers: { cookie: adminCookie } });
  const html = await page.text();
  assert.equal(page.status, 200);
  // The event-list labels come from page-presentation; assert only that
  // section so the check targets the fixed pipeline.
  const eventsIndex = html.indexOf('id="event-list"');
  const moreIndex = html.indexOf('id="analytics-more"');
  const eventListHtml = html.slice(eventsIndex, moreIndex);
  assert.match(eventListHtml, /<strong>搜索<\/strong>\s*<code class="analytics-break">\/zh\/search<\/code>/);
  assert.match(eventListHtml, /中文标题/);
  assert.match(eventListHtml, /标签：工具/);
  assert.match(eventListHtml, /分类：技术/);
  assert.doesNotMatch(eventListHtml, /%E9%83%A8%E7%BD%B2|utm_source|page%3D2|sort%3Dnew|%23extra/);
});

test('admin analytics overview ranking and item API use query/fragment-free display paths', async t => {
  const { baseUrl, adminCookie, db } = await createHarness(t);
  const localizedEvent = (id, requestPath) => {
    const observedAtUtc = new Date().toISOString();
    return {
      eventId: id.toString(16).padStart(32, '0'),
      observedAtUtc,
      bucketUtc: new Date(Math.floor(Date.parse(observedAtUtc) / 3_600_000) * 3_600_000).toISOString(),
      path: requestPath,
      visitorDayHmac: `visitor-${id}`,
      deviceKind: 'desktop',
      trafficKind: 'human',
      botName: null,
      method: 'GET',
      requestPath,
      queryString: null,
      fullUrl: `https://blog.example.com${requestPath}`,
      referrer: null,
      referrerHost: null,
      urlSanitizationStatus: 'ok',
      referrerParseStatus: 'ok',
      statusCode: 200,
      durationMs: 10,
      responseBytes: 1000,
      ipAddress: `203.0.113.${id}`,
      ipFamily: 4,
      geo: { status: 'not_found', data: null, datasetDate: null },
      requestClient: { userAgent: `Mozilla/${id}`, acceptLanguage: 'zh-CN', clientHints: {} },
      client: {
        status: 'parsed',
        data: {
          browserName: 'Chrome', browserVersion: '1', browserNameNormalized: 'chrome',
          osName: 'Windows', osNameNormalized: 'windows',
          deviceType: 'desktop', deviceTypeNormalized: 'desktop'
        }
      }
    };
  };

  recordAccessEvent(db, localizedEvent(1, '/zh/search%3Fq%3D%E9%83%A8%E7%BD%B2'));
  recordAccessEvent(db, localizedEvent(2, '/zh/article/twin%3Futm_source%3Dfeed'));
  recordAccessEvent(db, localizedEvent(3, '/zh/tag/%E5%B7%A5%E5%85%B7%23extra'));

  const overviewResponse = await fetch(`${baseUrl}/api/admin/analytics`, {
    headers: { cookie: adminCookie }
  });
  assert.equal(overviewResponse.status, 200);
  const overview = await overviewResponse.json();
  const byPage = new Map(overview.byPage.map(row => [row.path, row]));
  assert.equal(byPage.size, 3);
  assert.equal(byPage.get('/zh/search%3Fq%3D%E9%83%A8%E7%BD%B2').pageViews, 1);
  assert.equal(byPage.get('/zh/search%3Fq%3D%E9%83%A8%E7%BD%B2').displayPath, '/zh/search');
  assert.equal(byPage.get('/zh/article/twin%3Futm_source%3Dfeed').displayPath, '/zh/article/twin');
  assert.equal(byPage.get('/zh/tag/%E5%B7%A5%E5%85%B7%23extra').displayPath, '/zh/tag/工具');

  const listResponse = await fetch(`${baseUrl}/api/admin/analytics/events`, {
    headers: { cookie: adminCookie }
  });
  assert.equal(listResponse.status, 200);
  const list = await listResponse.json();
  const item = list.items.find(entry => entry.requestPath === '/zh/search%3Fq%3D%E9%83%A8%E7%BD%B2');
  assert.ok(item);
  assert.equal(item.displayPath, '/zh/search');
  assert.equal(item.requestPath, '/zh/search%3Fq%3D%E9%83%A8%E7%BD%B2');

  const page = await fetch(`${baseUrl}/admin/analytics`, { headers: { cookie: adminCookie } });
  const html = await page.text();
  assert.equal(page.status, 200);
  // 页面排行 table lives inside the analytics-more details section.
  const moreIndex = html.indexOf('id="analytics-more"');
  const systemIndex = html.indexOf('id="analytics-system-status"');
  const rankingHtml = html.slice(moreIndex, systemIndex);
  assert.match(rankingHtml, /\/zh\/search/);
  assert.match(rankingHtml, /\/zh\/article\/twin/);
  assert.match(rankingHtml, /\/zh\/tag\/工具/);
  assert.doesNotMatch(rankingHtml, /部署|utm_source|%23extra/);
});

test('admin analytics view pins all unique-IP output states and stable-hook uniqueness', async () => {
  const emptyDimension = { items: [], distinctCount: 0, truncated: false, otherPageViews: 0 };
  const baseOverview = {
    days: 7,
    todayActiveVisitors: 0,
    uniqueHumanIps: 0,
    humanPageViews: 0,
    botPageViews: 0,
    detailsAvailable: true,
    detailsComplete: true,
    pageViews: 0,
    anonymousVisitors: 0,
    detailCoverage: { pageViews: 0, humanPageViews: 0, complete: true },
    byHour: [], byDevice: [], byPage: [],
    byCountry: emptyDimension, bySubdivision: emptyDimension, byCity: emptyDimension,
    byBrowser: emptyDimension, byOs: emptyDimension, byDeviceModel: emptyDimension,
    byReferrerHost: emptyDimension, geoData: null
  };
  const render = overview => ejs.renderFile(path.resolve(__dirname, '..', 'views/admin/analytics.ejs'), {
    overview,
    events: { available: true, days: 7, nextCursor: null, items: [] },
    filters: { days: '7', search: '', traffic: 'all', ip: '', country: '', subdivision: '', city: '', browser: '', os: '', device: '', pathPrefix: '', referrerHost: '' },
    eventPreviousUrl: null,
    eventNextUrl: null,
    pageError: null,
    analyticsEnhancementEnabled: true,
    rangeOptions: [1, 7, 30],
    systemStatus: { detailsEnabled: true, geoData: null, warning: null },
    formatBeijingTime: value => value,
    user: { id: 1 }
  });

  const unavailable = await render({ ...baseOverview, uniqueHumanIps: null, detailsAvailable: false, detailsComplete: false });
  assert.equal(occurrenceCount(unavailable, '未启用访问明细'), 1);

  const incomplete = await render({
    ...baseOverview,
    uniqueHumanIps: 12,
    detailsComplete: false,
    detailCoverage: { pageViews: 0, humanPageViews: 0, complete: false }
  });
  assert.match(incomplete, /至少 12 个/);
  assert.equal(occurrenceCount(incomplete, '至少 12 个'), 1);

  const complete = await render({ ...baseOverview, uniqueHumanIps: 12 });
  assert.match(complete, />\s*12 个\s*</);
  assert.doesNotMatch(complete, /至少 12 个/);

  for (const html of [incomplete, complete]) assertEnabledWorkspaceHooksOnce(html);
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
      trafficKind: 'bot', botName: '"><img data-bot-injected src=x onerror=alert(3)>',
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
    filters: {
      days: '7', search: '"><input data-filter-injected value=x>', traffic: 'all',
      ip: '"><svg data-ip-injected onload=alert(4)>', country: '', subdivision: '', city: '',
      browser: '', os: '', device: '', pathPrefix: '"><button data-path-injected>bad</button>', referrerHost: ''
    },
    eventPreviousUrl: '/admin/analytics?days=7&cursor=previous" data-prev-injected="yes"><svg data-prev-element>#event-list',
    eventNextUrl: '/admin/analytics?days=7&cursor=next" data-next-injected="yes"><img data-next-element src=x>#event-list',
    pageError: null,
    analyticsEnhancementEnabled: true,
    rangeOptions: [1, 7, 30],
    systemStatus: {
      detailsEnabled: true,
      geoData: overview.geoData,
      warning: { severity: 'error', message: 'Geo warning fixture' }
    },
    formatBeijingTime: value => value,
    user: { id: 1 }
  });
  const eventsIndex = html.indexOf('id="event-list"');
  const moreIndex = html.indexOf('id="analytics-more"');
  assertAnalyticsTopLevelOrder(html);
  assertEnabledWorkspaceHooksOnce(html);
  assert.match(html, /今日活跃访客/);
  assert.match(html, /独立 IP/);
  assert.match(html, /真人访问量/);
  assert.match(html, /爬虫访问量/);
  assert.match(html, /name="search"/);
  assert.match(html, /name="traffic"/);
  assert.match(html, /<summary[^>]*>高级筛选（<span[^>]*>2<\/span>）<\/summary>/);
  assert.match(html, /data-analytics-remove-filter="search"[^>]*aria-label="移除搜索筛选/);
  assert.match(html, /data-analytics-remove-filter="ip"[^>]*aria-label="移除完整 IP 筛选/);
  assert.match(html, /data-analytics-remove-filter="pathPrefix"[^>]*aria-label="移除路径前缀筛选/);
  assert.match(html, /href="\/admin\/analytics\?[^"#]*search=[^"#]*traffic=all[^"#]*pathPrefix=[^"#]*#event-list"[^>]*data-analytics-remove-filter="ip"/);
  assert.match(html, /<details[^>]*id="analytics-more"/);
  assert.match(html, /href="[^"]*#event-list"/);
  assert.match(html, /文章（已删除或未知）/);
  assert.match(html, /data-traffic-kind="bot"/);
  assert.match(html, /&#34;&gt;&lt;img data-bot-injected src=x onerror=alert\(3\)&gt;/);
  assert.match(html, /value="&#34;&gt;&lt;input data-filter-injected value=x&gt;"/);
  assert.match(html, /value="&#34;&gt;&lt;svg data-ip-injected onload=alert\(4\)&gt;"/);
  assert.match(html, /value="&#34;&gt;&lt;button data-path-injected&gt;bad&lt;\/button&gt;"/);
  assert.match(html, /href="\/admin\/analytics\?days=7&amp;cursor=previous&#34; data-prev-injected=&#34;yes&#34;&gt;&lt;svg data-prev-element&gt;#event-list" data-analytics-page="previous"/);
  assert.match(html, /href="\/admin\/analytics\?days=7&amp;cursor=next&#34; data-next-injected=&#34;yes&#34;&gt;&lt;img data-next-element src=x&gt;#event-list" data-analytics-page="next"/);
  assert.doesNotMatch(html, /<img data-bot-injected|<input data-filter-injected|<svg data-ip-injected|<button data-path-injected|<svg data-prev-element|<img data-next-element/);
  assert.doesNotMatch(html, /\sdata-(?:prev|next)-injected="yes"/);
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
  assert.match(source, /replaceChildren/);
  assert.match(source, /textContent/);
  assert.match(source, /AbortController/);
  assert.match(source, /pushState/);
  assert.match(source, /replaceState/);
  assert.match(source, /popstate/);
  assert.match(source, /preventScroll/);
  assert.match(source, /data-analytics-retry/);
  assert.match(source, /attempt\.query/);
  assert.match(source, /proposal\.query/);
  assert.doesNotMatch(source, /query:\s*attempt\.params\.toString\(\)/);
});

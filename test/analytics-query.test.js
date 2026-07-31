const assert = require('node:assert/strict');
const { performance } = require('node:perf_hooks');
const test = require('node:test');
const Database = require('better-sqlite3');
const { formatAnalyticsPath } = require('../server/analytics/path-display');
const { pagePresentationForPath } = require('../server/analytics/page-presentation');
const { rebuildDetailDimensionMetrics, recordAccessEvent } = require('../server/analytics/repository');
const {
  explainEventList,
  getEventDetail,
  listEvents,
  parseEventListQuery
} = require('../server/analytics/query/analytics-query');
const {
  explainOverviewHumanIps,
  getOverview,
  initializeAnalytics,
  parseAnalyticsDays
} = require('../server/analytics/store');

const NOW = Date.parse('2026-07-17T12:00:00.000Z');

function createDb() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  initializeAnalytics(db);
  db.exec(`
    CREATE TABLE articles (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      slug TEXT UNIQUE NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('draft', 'published'))
    )
  `);
  return db;
}

function event(id, overrides = {}) {
  return {
    eventId: id.toString(16).padStart(32, '0'),
    observedAtUtc: new Date(NOW - id * 1000).toISOString(),
    bucketUtc: new Date(Math.floor((NOW - id * 1000) / 3_600_000) * 3_600_000).toISOString(),
    path: '/tag/%E5%B7%A5%E5%85%B7',
    visitorDayHmac: `visitor-${id}`,
    deviceKind: 'desktop',
    trafficKind: 'human',
    botName: null,
    method: 'GET', requestPath: '/tag/%E5%B7%A5%E5%85%B7', queryString: null,
    fullUrl: 'https://blog.example.com/tag/%E5%B7%A5%E5%85%B7',
    referrer: 'https://example.com/from', referrerHost: 'example.com',
    urlSanitizationStatus: 'ok', referrerParseStatus: 'ok',
    statusCode: 200, durationMs: 10 + id, responseBytes: 1000,
    ipAddress: `203.0.113.${id}`, ipFamily: 4,
    geo: {
      status: 'resolved', datasetDate: '2026-07-01T00:00:00.000Z',
      data: {
        continentCode: 'AS', continentName: 'Asia', countryCode: 'CN', countryName: 'China',
        subdivisionCode: 'BJ', subdivisionName: 'Beijing', cityName: 'Beijing',
        postalCode: '100000', timezone: 'Asia/Shanghai', latitude: 39.9,
        longitude: 116.4, accuracyRadiusKm: 20
      }
    },
    requestClient: { userAgent: `Mozilla/${id}`, acceptLanguage: 'zh-CN', clientHints: { 'sec-ch-ua': 'Fixture' } },
    client: {
      status: 'parsed',
      data: {
        browserName: 'Chrome', browserVersion: `12${id}`, browserNameNormalized: 'chrome',
        osName: 'Windows', osVersion: '11', osNameNormalized: 'windows',
        deviceType: 'desktop', deviceTypeNormalized: 'desktop',
        deviceVendor: 'Fixture', deviceModel: `Model ${id}`,
        engineName: 'Blink', engineVersion: `12${id}`, cpuArchitecture: 'x64'
      }
    },
    ...overrides
  };
}

test('analytics paths decode every valid UTF-8 path without changing reserved or unsafe text semantics', () => {
  assert.deepEqual(formatAnalyticsPath('/tag/%E5%B7%A5%E5%85%B7'), { displayPath: '/tag/工具', displayPathStatus: 'decoded' });
  assert.deepEqual(formatAnalyticsPath('/tag/%E7%BC%96%E7%A8%8B'), { displayPath: '/tag/编程', displayPathStatus: 'decoded' });
  assert.deepEqual(formatAnalyticsPath('/tag/%E6%95%88%E7%8E%87%E5%B7%A5%E5%85%B7'), { displayPath: '/tag/效率工具', displayPathStatus: 'decoded' });
  assert.deepEqual(formatAnalyticsPath('/x/%2F/%3F/%23'), { displayPath: '/x/%2F/%3F/%23', displayPathStatus: 'raw' });
  assert.deepEqual(formatAnalyticsPath('/bad/%E5%A'), { displayPath: '/bad/%E5%A', displayPathStatus: 'raw_invalid_encoding' });
  assert.deepEqual(formatAnalyticsPath('/x/%3Cscript%3E'), { displayPath: '/x/<script>', displayPathStatus: 'decoded' });
  assert.match(formatAnalyticsPath('/x/%E2%80%AE').displayPath, /\\u\{202E\}/);
  assert.match(formatAnalyticsPath('/bad/%E5%A‮').displayPath, /\\u\{202E\}/);
});

test('page presentation treats malformed and multi-segment article/tag paths as safe fallbacks', () => {
  const titles = new Map([['known', 'Known article']]);
  assert.deepEqual(pagePresentationForPath('/article/known', titles), {
    kind: 'article', title: 'Known article', displayPath: '/article/known'
  });
  assert.deepEqual(pagePresentationForPath('/article/known/extra', titles), {
    kind: 'article', title: '文章（已删除或未知）', displayPath: '/article/known/extra'
  });
  assert.deepEqual(pagePresentationForPath('/article/%E5%A', titles), {
    kind: 'article', title: '文章（已删除或未知）', displayPath: '/article/%E5%A'
  });
  assert.deepEqual(pagePresentationForPath('/tag/tools/extra', titles), {
    kind: 'other', title: '/tag/tools/extra', displayPath: '/tag/tools/extra'
  });
  assert.deepEqual(pagePresentationForPath('/tag/%E5%A', titles), {
    kind: 'other', title: '/tag/%E5%A', displayPath: '/tag/%E5%A'
  });
});

test('event-list filters parse traffic, literal search, and structured errors', () => {
  const options = parseEventListQuery({
    days: '7',
    search: '  部署_%\\  ',
    traffic: '',
    ip: '',
    country: '',
    subdivision: '',
    city: '',
    browser: '  Opera  ',
    os: '',
    device: '',
    pathPrefix: '',
    referrerHost: ''
  }, 30);

  assert.equal(options.filters.browser, 'opera');
  assert.equal(options.filters.search, '部署_%\\');
  assert.equal(options.filters.traffic, 'all');
  assert.equal(parseEventListQuery({ traffic: 'bot' }, 30).filters.traffic, 'bot');
  assert.deepEqual(options.filters, {
    search: '部署_%\\',
    traffic: 'all',
    ip: null,
    country: null,
    subdivision: null,
    city: null,
    browser: 'opera',
    os: null,
    device: null,
    pathPrefix: null,
    referrerHost: null
  });
  assert.throws(
    () => parseEventListQuery({ traffic: 'robot' }, 30),
    error => error.code === 'invalid_filter'
      && error.field === 'traffic'
      && error.reason === 'unsupported_value'
  );
  assert.throws(
    () => parseEventListQuery({ search: 'x'.repeat(257) }, 30),
    error => error.code === 'invalid_filter'
      && error.field === 'search'
      && error.reason === 'too_long'
  );
  assert.equal(parseEventListQuery({ search: `  ${'é'.repeat(256)}  ` }, 30).filters.search.length, 256);
  assert.throws(
    () => parseEventListQuery({ search: 'e\u0301'.repeat(257) }, 30),
    error => error.code === 'invalid_filter'
      && error.field === 'search'
      && error.reason === 'too_long'
  );
});

test('event list/detail use normalized filters, stable cursors, and exclude legacy-only rows', () => {
  const db = createDb();
  recordAccessEvent(db, event(1));
  recordAccessEvent(db, event(2, {
    path: '/tag/%E7%BC%96%E7%A8%8B', requestPath: '/tag/%E7%BC%96%E7%A8%8B',
    fullUrl: 'https://blog.example.com/tag/%E7%BC%96%E7%A8%8B',
    ipAddress: '2001:db8::2', ipFamily: 6,
    geo: { status: 'not_found', data: null, datasetDate: '2026-07-01T00:00:00.000Z' },
    client: { status: 'parsed', data: { browserName: 'Firefox', browserVersion: '128', browserNameNormalized: 'firefox', osName: 'Linux', osNameNormalized: 'linux', deviceType: 'desktop', deviceTypeNormalized: 'desktop' } }
  }));
  recordAccessEvent(db, event(3));
  db.prepare(`INSERT INTO access_metrics (bucket_utc, path, visitor_day_hmac, device_kind) VALUES (?, '/legacy', 'legacy', 'desktop')`)
    .run(new Date(NOW - 1000).toISOString());

  const firstOptions = parseEventListQuery({ days: '7', limit: '1' }, 30);
  const first = listEvents(db, NOW, firstOptions);
  assert.equal(first.items.length, 1);
  assert.ok(first.nextCursor);
  assert.equal('raw' in first.items[0], false);
  assert.equal(first.items[0].displayPath, '/tag/工具');
  const second = listEvents(db, NOW, parseEventListQuery({ days: '7', limit: '1', cursor: first.nextCursor }, 30));
  assert.notEqual(second.items[0].id, first.items[0].id);

  const filtered = listEvents(db, NOW, parseEventListQuery({ country: 'cn', city: '  BEIJING  ', browser: 'CHROME' }, 30));
  assert.equal(filtered.items.length, 2);
  assert.throws(() => parseEventListQuery({ city: 'Beijing' }, 30), /invalid_filter/);
  assert.throws(() => parseEventListQuery({ cursor: 'not-base64!' }, 30), /invalid_filter/);
  const encodedCursor = value => Buffer.from(JSON.stringify(value)).toString('base64url');
  for (const cursor of [
    { observedAtUtc: '9999-99-99T99:99:99.999Z', metricId: 1 },
    { observedAtUtc: '2026-02-29T00:00:00.000Z', metricId: 1 },
    { observedAtUtc: '2024-02-29T00:00:00.000Z', metricId: Number.MAX_SAFE_INTEGER + 1 },
    { observedAtUtc: '2024-02-29T00:00:00.000Z', metricId: null }
  ]) {
    assert.throws(() => parseEventListQuery({ cursor: encodedCursor(cursor) }, 30), /invalid_filter/);
  }

  const detail = getEventDetail(db, first.items[0].id);
  assert.equal(detail.raw.userAgent, 'Mozilla/1');
  assert.deepEqual(detail.raw.requestClientHints, { 'sec-ch-ua': 'Fixture' });
  assert.equal(getEventDetail(db, 'f'.repeat(32)), null);
  db.close();
});

test('event list filters traffic and literal search while enriching page titles in one result set', () => {
  const db = createDb();
  db.prepare('INSERT INTO articles (title, slug, status) VALUES (?, ?, ?)').run(
    'Node.js 部署指南（旧版）', 'node-deployment', 'published'
  );
  db.prepare('UPDATE articles SET title = ?, status = ? WHERE slug = ?').run(
    'Node.js 部署指南（新版）', 'draft', 'node-deployment'
  );
  db.prepare('INSERT INTO articles (title, slug, status) VALUES (?, ?, ?)').run(
    '效率工具', '效率工具', 'published'
  );

  const pageEvent = (id, requestPath, overrides = {}) => event(id, {
    path: requestPath,
    requestPath,
    fullUrl: `https://blog.example.com${requestPath}`,
    ...overrides
  });
  recordAccessEvent(db, pageEvent(1, '/article/node-deployment', {
    trafficKind: 'bot', botName: 'Googlebot', ipAddress: '198.51.100.1'
  }));
  recordAccessEvent(db, pageEvent(2, '/article/node-deployment', { ipAddress: '203.0.113.10' }));
  recordAccessEvent(db, pageEvent(3, '/'));
  recordAccessEvent(db, pageEvent(4, '/about'));
  recordAccessEvent(db, pageEvent(5, '/archive'));
  recordAccessEvent(db, pageEvent(6, '/tags'));
  recordAccessEvent(db, pageEvent(7, '/tag/%E5%B7%A5%E5%85%B7'));
  recordAccessEvent(db, pageEvent(8, '/article/%E6%95%88%E7%8E%87%E5%B7%A5%E5%85%B7'));
  recordAccessEvent(db, pageEvent(9, '/article/missing'));
  recordAccessEvent(db, pageEvent(10, '/article/node-deployment', {
    trafficKind: 'bot', botName: 'Googlebot', ipAddress: '198.51.100.2'
  }));

  const all = listEvents(db, NOW, parseEventListQuery({}, 30));
  const byPath = new Map(all.items.map(item => [item.requestPath, item]));
  assert.deepEqual(byPath.get('/').page, { kind: 'home', title: '首页', displayPath: '/' });
  assert.deepEqual(byPath.get('/about').page, { kind: 'about', title: '关于', displayPath: '/about' });
  assert.deepEqual(byPath.get('/archive').page, { kind: 'archive', title: '归档', displayPath: '/archive' });
  assert.equal(byPath.get('/tags').page.title, '标签页');
  assert.equal(byPath.get('/tag/%E5%B7%A5%E5%85%B7').page.title, '标签：工具');
  assert.equal(byPath.get('/article/missing').page.title, '文章（已删除或未知）');
  assert.equal(byPath.get('/article/%E6%95%88%E7%8E%87%E5%B7%A5%E5%85%B7').page.title, '效率工具');

  const botOnly = listEvents(db, NOW, parseEventListQuery({ traffic: 'bot' }, 30));
  assert.ok(botOnly.items.every(item => item.trafficKind === 'bot'));
  assert.ok(botOnly.items.every(item => item.botName === 'Googlebot'));
  assert.equal(listEvents(db, NOW, parseEventListQuery({ search: '113.10' }, 30)).items.length, 1);
  assert.equal(listEvents(db, NOW, parseEventListQuery({ search: '203.0.113.10' }, 30)).items.length, 1);
  const titleSearch = listEvents(db, NOW, parseEventListQuery({ search: '部署' }, 30));
  assert.equal(titleSearch.items[0].page.title, 'Node.js 部署指南（新版）');
  assert.equal(listEvents(db, NOW, parseEventListQuery({ search: 'ｎＯＤＥ．ＪＳ' }, 30)).items.length, 3);
  assert.equal(listEvents(db, NOW, parseEventListQuery({ search: '/ARTICLE/NODE' }, 30)).items.length, 3);
  db.prepare("DELETE FROM access_metrics WHERE path IN ('/tag/%E5%B7%A5%E5%85%B7', '/article/%E6%95%88%E7%8E%87%E5%B7%A5%E5%85%B7')").run();
  assert.equal(listEvents(db, NOW, parseEventListQuery({ search: '%' }, 30)).items.length, 0);
  assert.equal(listEvents(db, NOW, parseEventListQuery({ search: '_' }, 30)).items.length, 0);
  assert.equal(listEvents(db, NOW, parseEventListQuery({ search: '\\' }, 30)).items.length, 0);

  const firstBot = listEvents(db, NOW, parseEventListQuery({ traffic: 'bot', limit: '1' }, 30));
  assert.ok(firstBot.nextCursor);
  const secondBot = listEvents(db, NOW, parseEventListQuery({
    traffic: 'bot', limit: '1', cursor: firstBot.nextCursor
  }, 30));
  assert.equal(secondBot.items.length, 1);
  assert.notEqual(secondBot.items[0].id, firstBot.items[0].id);
  assert.equal(secondBot.items[0].trafficKind, 'bot');

  const firstSearch = listEvents(db, NOW, parseEventListQuery({ search: '部署', limit: '1' }, 30));
  assert.ok(firstSearch.nextCursor);
  const secondSearch = listEvents(db, NOW, parseEventListQuery({
    search: '部署', limit: '1', cursor: firstSearch.nextCursor
  }, 30));
  assert.equal(secondSearch.items.length, 1);
  assert.notEqual(secondSearch.items[0].id, firstSearch.items[0].id);
  assert.equal(secondSearch.items[0].page.title, 'Node.js 部署指南（新版）');

  const detail = getEventDetail(db, byPath.get('/article/missing').id);
  assert.equal(detail.trafficKind, 'human');
  assert.equal(detail.botName, null);
  assert.equal(detail.page.title, '文章（已删除或未知）');
  db.close();
});

test('event list title search tolerates an analytics-only database without articles', () => {
  const db = new Database(':memory:');
  initializeAnalytics(db);
  recordAccessEvent(db, event(1));
  assert.equal(listEvents(db, NOW, parseEventListQuery({ search: '不存在的标题' }, 30)).items.length, 0);
  db.close();
});

test('overview detail coverage follows the legacy hourly bucket boundary', () => {
  const db = createDb();
  const now = Date.parse('2026-07-17T12:30:00.000Z');
  recordAccessEvent(db, event(10, {
    observedAtUtc: '2026-07-16T12:45:00.000Z',
    bucketUtc: '2026-07-16T12:00:00.000Z'
  }));
  const overview = getOverview(db, now, 1, 30, null);
  assert.equal(overview.pageViews, 0);
  assert.equal(overview.detailCoverage.pageViews, 0);
  assert.equal(overview.byCountry.distinctCount, 0);
  db.close();
});

test('overview reports human metrics, bots, Beijing today, and partial detail coverage', () => {
  const db = createDb();
  recordAccessEvent(db, event(1, {
    observedAtUtc: '2026-07-17T11:59:59.000Z',
    bucketUtc: '2026-07-17T11:00:00.000Z',
    visitorDayHmac: 'today-human-1',
    ipAddress: '203.0.113.10'
  }));
  recordAccessEvent(db, event(2, {
    observedAtUtc: '2026-07-16T16:00:01.000Z',
    bucketUtc: '2026-07-16T16:00:00.000Z',
    visitorDayHmac: 'today-human-2',
    ipAddress: '203.0.113.11'
  }));
  recordAccessEvent(db, event(5, {
    observedAtUtc: '2026-07-09T12:00:00.000Z',
    bucketUtc: '2026-07-09T12:00:00.000Z',
    visitorDayHmac: 'old-human',
    ipAddress: '203.0.113.10'
  }));
  recordAccessEvent(db, event(3, {
    observedAtUtc: '2026-07-17T10:00:00.000Z',
    bucketUtc: '2026-07-17T10:00:00.000Z',
    path: '/bot-only', requestPath: '/bot-only', fullUrl: 'https://blog.example.com/bot-only',
    visitorDayHmac: 'bot-1', deviceKind: 'other', trafficKind: 'bot', botName: 'Googlebot',
    ipAddress: '198.51.100.10'
  }));
  recordAccessEvent(db, event(4, {
    observedAtUtc: '2026-07-16T20:00:00.000Z',
    bucketUtc: '2026-07-16T20:00:00.000Z',
    path: '/bot-only', requestPath: '/bot-only', fullUrl: 'https://blog.example.com/bot-only',
    visitorDayHmac: 'bot-2', deviceKind: 'other', trafficKind: 'bot', botName: 'Bingbot',
    ipAddress: '198.51.100.11'
  }));
  db.prepare(`
    INSERT INTO access_metrics (bucket_utc, path, visitor_day_hmac, device_kind, traffic_kind)
    VALUES ('2026-07-16T15:00:00.000Z', '/legacy', 'legacy-human', 'mobile', 'human')
  `).run();

  const geoStatus = { reader: { datasetDate: '2026-07-01T00:00:00.000Z' }, updater: { state: 'ok', result: 'no-op' }, stale: false };
  const overview = getOverview(db, NOW, 7, 30, geoStatus, true);
  assert.equal(overview.humanPageViews, 3);
  assert.equal(overview.pageViews, overview.humanPageViews);
  assert.equal(overview.botPageViews, 2);
  assert.equal(overview.todayActiveVisitors, 2);
  assert.equal(overview.uniqueHumanIps, 2);
  assert.equal(overview.detailsAvailable, true);
  assert.equal(overview.detailsComplete, false);
  assert.equal(overview.anonymousVisitors, 3);
  assert.equal(overview.detailCoverage.pageViews, 2);
  assert.equal(overview.detailCoverage.humanPageViews, 2);
  assert.equal(overview.detailCoverage.complete, false);
  assert.ok(overview.byPage.every(row => row.path !== '/bot-only'));
  assert.ok(overview.byDevice.every(row => row.deviceKind !== 'other'));
  assert.equal(overview.byPage.find(row => row.path.includes('%E5')).displayPath, '/tag/工具');
  assert.equal(overview.byCountry.items[0].key, 'CN');
  assert.equal(overview.byCountry.items[0].pageViews, 2);
  assert.equal(overview.byBrowser.items[0].key, 'chrome');
  assert.deepEqual(overview.geoData, geoStatus);
  for (const name of ['byCountry', 'bySubdivision', 'byCity', 'byBrowser', 'byOs', 'byDeviceModel', 'byReferrerHost']) {
    assert.ok(overview[name].items.length <= 50);
    assert.equal(overview[name].otherPageViews + overview[name].items.reduce((sum, row) => sum + row.pageViews, 0), 2);
  }

  const disabled = getOverview(db, NOW, 7, 30, null, false);
  assert.equal(disabled.uniqueHumanIps, null);
  assert.equal(disabled.detailsAvailable, false);
  assert.equal(disabled.detailsComplete, false);
  assert.equal(disabled.detailCoverage.complete, false);
  db.close();
});

test('analytics day ranges accept only decimal integers within retention', () => {
  assert.equal(parseAnalyticsDays(undefined, 30), 7);
  assert.equal(parseAnalyticsDays('30', 30), 30);
  assert.equal(parseAnalyticsDays(1, 30), 1);
  for (const value of ['7days', '1.5', '', 0, 31, 1.5, NaN, null]) {
    assert.throws(() => parseAnalyticsDays(value, 30), /invalid_analytics_days/);
  }
});

test('100k event fixture stays within list/overview query and response budgets', { timeout: 30_000 }, t => {
  const db = createDb();
  const metric = db.prepare(`
    INSERT INTO access_metrics (bucket_utc, path, visitor_day_hmac, device_kind, traffic_kind)
    VALUES (?, ?, ?, ?, ?)
  `);
  const detail = db.prepare(`
    INSERT INTO access_event_details (
      metric_id,event_id,observed_at_utc,method,request_path,full_url,url_sanitization_status,
      referrer_parse_status,status_code,duration_ms,ip_address,ip_family,country_code,country_name,
      subdivision_name,subdivision_name_normalized,city_name,city_name_normalized,geo_status,
      user_agent,accept_language,request_client_hints_json,device_type,device_model,device_model_normalized,device_type_normalized,
      os_name,os_name_normalized,browser_name,browser_version,browser_name_normalized,
      client_parse_status,traffic_kind,bot_name,context_source,referrer_host
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `);
  db.transaction(() => {
    for (let i = 0; i < 100_000; i += 1) {
      const observed = new Date(NOW - (i % (30 * 24 * 60)) * 60_000).toISOString();
      const country = i % 4 === 0 ? 'US' : 'CN';
      const city = country === 'CN' ? `city-${i % 200}` : `city-${i % 100}`;
      const browser = i % 3 === 0 ? 'firefox' : 'chrome';
      const requestPath = `/article/${i % 500}`;
      const trafficKind = i % 10 === 0 ? 'bot' : 'human';
      const bucket = new Date(Math.floor(Date.parse(observed) / 3_600_000) * 3_600_000).toISOString();
      const parent = metric.run(
        bucket,
        requestPath,
        `visitor-${i % 20000}`,
        i % 5 === 0 ? 'mobile' : 'desktop',
        trafficKind
      );
      detail.run(
        Number(parent.lastInsertRowid), i.toString(16).padStart(32, '0'), observed, 'GET', requestPath,
        `https://blog.example.com${requestPath}`, 'ok', 'ok', 200, i % 1000,
        `203.0.${Math.floor(i / 256) % 256}.${i % 256}`, 4, country, country === 'CN' ? 'China' : 'United States',
        'Subdivision', 'subdivision', city, city, 'resolved', 'Mozilla', 'zh-CN', '{}',
        i % 5 === 0 ? 'mobile' : 'desktop', `model-${i}`, `model-${i}`, i % 5 === 0 ? 'mobile' : 'desktop',
        'Windows', 'windows', browser, '1', browser, 'parsed', trafficKind,
        trafficKind === 'bot' ? 'FixtureBot' : null, 'server', `ref-${i}.example.com`
      );
    }
  })();
  rebuildDetailDimensionMetrics(db);

  const options = parseEventListQuery({ days: '30', country: 'CN', city: 'city-1', limit: '50' }, 30);
  const planCases = [
    [{ days: '30' }, /idx_event_details_observed/i],
    [{ days: '30', ip: '203.0.0.1' }, /idx_event_details_ip_observed/i],
    [{ days: '30', country: 'CN', subdivision: 'Subdivision' }, /idx_event_details_location_observed/i],
    [{ days: '30', country: 'CN', city: 'city-1' }, /idx_event_details_country_city_observed/i],
    [{ days: '30', country: 'CN', subdivision: 'Subdivision', city: 'city-1' }, /idx_event_details_location_observed/i],
    [{ days: '30', browser: 'Chrome' }, /idx_event_details_browser_observed/i],
    [{ days: '30', pathPrefix: '/article/1' }, /idx_event_details_path_observed/i],
    [{ days: '30', referrerHost: 'ref-1.example.com' }, /idx_event_details_referrer_observed/i]
  ];
  for (const [query, expectedIndex] of planCases) {
    const plan = explainEventList(db, NOW, parseEventListQuery(query, 30)).map(row => row.detail).join('\n');
    assert.match(plan, expectedIndex, `query plan for ${JSON.stringify(query)}:\n${plan}`);
  }
  for (const query of [
    { days: '30', traffic: 'bot', country: 'CN' },
    { days: '30', traffic: 'human', browser: 'Chrome' },
    { days: '30', traffic: 'bot', pathPrefix: '/article/1' }
  ]) {
    const plan = explainEventList(db, NOW, parseEventListQuery(query, 30)).map(row => row.detail).join('\n');
    assert.match(plan, /USING (?:COVERING )?INDEX idx_event_details_/i, `query plan for ${JSON.stringify(query)}:\n${plan}`);
    assert.doesNotMatch(plan, /SCAN d(?:\s|$)/i, `unindexed detail scan for ${JSON.stringify(query)}:\n${plan}`);
  }
  const ipPlan = explainOverviewHumanIps(db, NOW, 30, 30).map(row => row.detail).join('\n');
  assert.match(ipPlan, /idx_event_details_traffic_ip_observed/i, `overview IP query plan:\n${ipPlan}`);
  const listDurations = [];
  const overviewDurations = [];
  let overview;
  // Warm SQLite pages and prepared statements. Each measured overview follows
  // a real event write, which invalidates the application cache.
  getOverview(db, NOW, 30, 30, null);
  for (let i = 0; i < 20; i += 1) {
    let started = performance.now();
    listEvents(db, NOW, options);
    listDurations.push(performance.now() - started);
    recordAccessEvent(db, event(100_000 + i, {
      ipAddress: `2001:db8::${i + 1}`,
      ipFamily: 6
    }));
    started = performance.now();
    overview = getOverview(db, NOW, 30, 30, null);
    JSON.stringify(overview);
    overviewDurations.push(performance.now() - started);
  }
  const p95 = values => values.sort((a, b) => a - b)[Math.ceil(values.length * 0.95) - 1];
  const listP95 = p95(listDurations);
  const overviewP95 = p95(overviewDurations);
  const responseBytes = Buffer.byteLength(JSON.stringify(overview));
  assert.ok(listP95 <= 250, `list p95=${listP95}ms`);
  assert.ok(overviewP95 <= 500, `overview p95=${overviewP95}ms`);
  assert.ok(responseBytes <= 256 * 1024);
  t.diagnostic(`100k list p95=${listP95.toFixed(2)}ms, cold overview+serialize p95=${overviewP95.toFixed(2)}ms, response=${responseBytes} bytes`);
  for (const name of ['byCountry', 'bySubdivision', 'byCity', 'byBrowser', 'byOs', 'byDeviceModel', 'byReferrerHost']) {
    assert.ok(overview[name].items.length <= 50);
    assert.equal(
      overview[name].otherPageViews + overview[name].items.reduce((sum, row) => sum + row.pageViews, 0),
      overview.detailCoverage.pageViews
    );
  }
  assert.equal(overview.byDeviceModel.distinctCount, 90_020);
  assert.equal(overview.byReferrerHost.distinctCount, 90_001);
  db.close();
});

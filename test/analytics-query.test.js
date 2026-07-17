const assert = require('node:assert/strict');
const { performance } = require('node:perf_hooks');
const test = require('node:test');
const Database = require('better-sqlite3');
const { formatAnalyticsPath } = require('../server/analytics/path-display');
const { rebuildDetailDimensionMetrics, recordAccessEvent } = require('../server/analytics/repository');
const {
  explainEventList,
  getEventDetail,
  listEvents,
  parseEventListQuery
} = require('../server/analytics/query/analytics-query');
const { getOverview, initializeAnalytics } = require('../server/analytics/store');

const NOW = Date.parse('2026-07-17T12:00:00.000Z');

function createDb() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  initializeAnalytics(db);
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

test('overview keeps legacy fields and adds bounded dimensions, Geo status, and readable paths', () => {
  const db = createDb();
  recordAccessEvent(db, event(1));
  recordAccessEvent(db, event(2));
  db.prepare(`INSERT INTO access_metrics (bucket_utc, path, visitor_day_hmac, device_kind) VALUES (?, '/legacy', 'legacy', 'mobile')`)
    .run(new Date(NOW - 1000).toISOString());
  const geoStatus = { reader: { datasetDate: '2026-07-01T00:00:00.000Z' }, updater: { state: 'ok', result: 'no-op' }, stale: false };
  const overview = getOverview(db, NOW, 7, 30, geoStatus);
  assert.equal(overview.pageViews, 3);
  assert.equal(overview.detailCoverage.pageViews, 2);
  assert.equal(overview.byPage.find(row => row.path.includes('%E5')).displayPath, '/tag/工具');
  assert.equal(overview.byCountry.items[0].key, 'CN');
  assert.equal(overview.byCountry.items[0].pageViews, 2);
  assert.equal(overview.byBrowser.items[0].key, 'chrome');
  assert.deepEqual(overview.geoData, geoStatus);
  for (const name of ['byCountry', 'bySubdivision', 'byCity', 'byBrowser', 'byOs', 'byDeviceModel', 'byReferrerHost']) {
    assert.ok(overview[name].items.length <= 50);
    assert.equal(overview[name].otherPageViews + overview[name].items.reduce((sum, row) => sum + row.pageViews, 0), 2);
  }
  db.close();
});

test('100k event fixture stays within list/overview query and response budgets', { timeout: 30_000 }, t => {
  const db = createDb();
  const metric = db.prepare(`INSERT INTO access_metrics (bucket_utc, path, visitor_day_hmac, device_kind) VALUES (?, ?, ?, ?)`);
  const detail = db.prepare(`
    INSERT INTO access_event_details (
      metric_id,event_id,observed_at_utc,method,request_path,full_url,url_sanitization_status,
      referrer_parse_status,status_code,duration_ms,ip_address,ip_family,country_code,country_name,
      subdivision_name,subdivision_name_normalized,city_name,city_name_normalized,geo_status,
      user_agent,accept_language,request_client_hints_json,device_type,device_model,device_model_normalized,device_type_normalized,
      os_name,os_name_normalized,browser_name,browser_version,browser_name_normalized,
      client_parse_status,context_source,referrer_host
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `);
  db.transaction(() => {
    for (let i = 0; i < 100_000; i += 1) {
      const observed = new Date(NOW - (i % (30 * 24 * 60)) * 60_000).toISOString();
      const country = i % 4 === 0 ? 'US' : 'CN';
      const city = country === 'CN' ? `city-${i % 200}` : `city-${i % 100}`;
      const browser = i % 3 === 0 ? 'firefox' : 'chrome';
      const requestPath = `/article/${i % 500}`;
      const bucket = new Date(Math.floor(Date.parse(observed) / 3_600_000) * 3_600_000).toISOString();
      const parent = metric.run(bucket, requestPath, `visitor-${i % 20000}`, i % 5 === 0 ? 'mobile' : 'desktop');
      detail.run(
        Number(parent.lastInsertRowid), i.toString(16).padStart(32, '0'), observed, 'GET', requestPath,
        `https://blog.example.com${requestPath}`, 'ok', 'ok', 200, i % 1000,
        `203.0.${Math.floor(i / 256) % 256}.${i % 256}`, 4, country, country === 'CN' ? 'China' : 'United States',
        'Subdivision', 'subdivision', city, city, 'resolved', 'Mozilla', 'zh-CN', '{}',
        i % 5 === 0 ? 'mobile' : 'desktop', `model-${i}`, `model-${i}`, i % 5 === 0 ? 'mobile' : 'desktop',
        'Windows', 'windows', browser, '1', browser, 'parsed', 'server', `ref-${i}.example.com`
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
  assert.equal(overview.byDeviceModel.distinctCount, 100_020);
  assert.equal(overview.byReferrerHost.distinctCount, 100_001);
  db.close();
});

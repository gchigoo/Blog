const assert = require('node:assert/strict');
const test = require('node:test');
const Database = require('better-sqlite3');
const { validateClientContext } = require('../server/analytics/context-validator');
const {
  cleanupAnalytics,
  recordAccessEvent,
  updateEventContext
} = require('../server/analytics/repository');
const { initializeAnalytics } = require('../server/analytics/store');

function createDb() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  initializeAnalytics(db);
  return db;
}

function event(overrides = {}) {
  return {
    eventId: '0123456789abcdef0123456789abcdef',
    observedAtUtc: '2026-07-17T00:00:00.123Z',
    bucketUtc: '2026-07-17T00:00:00.000Z',
    path: '/tag/%E5%B7%A5%E5%85%B7',
    visitorDayHmac: 'a'.repeat(64),
    deviceKind: 'desktop',
    method: 'GET',
    requestPath: '/tag/%E5%B7%A5%E5%85%B7',
    queryString: null,
    fullUrl: 'https://blog.example.com/tag/%E5%B7%A5%E5%85%B7',
    referrer: null,
    referrerHost: null,
    urlSanitizationStatus: 'ok',
    referrerParseStatus: 'missing',
    statusCode: 200,
    durationMs: 15,
    responseBytes: null,
    ipAddress: '203.0.113.10',
    ipFamily: 4,
    geo: { status: 'not_found', data: null, datasetDate: '2026-07-01T00:00:00.000Z' },
    requestClient: { userAgent: 'Mozilla/5.0', acceptLanguage: 'zh-CN', clientHints: {} },
    client: { status: 'unknown', data: null },
    ...overrides
  };
}

test('analytics schema migrates legacy metrics and records metric/detail atomically', () => {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE access_metrics (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      bucket_utc TEXT NOT NULL,
      path TEXT NOT NULL,
      visitor_day_hmac TEXT NOT NULL,
      device_kind TEXT NOT NULL
    );
    INSERT INTO access_metrics (bucket_utc, path, visitor_day_hmac, device_kind)
    VALUES ('2026-07-01T00:00:00.000Z', '/legacy', 'legacy', 'desktop');
  `);
  initializeAnalytics(db);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM access_event_details').get().count, 0);

  const result = recordAccessEvent(db, event());
  assert.equal(result.eventId, '0123456789abcdef0123456789abcdef');
  const detail = db.prepare('SELECT * FROM access_event_details WHERE event_id = ?').get(result.eventId);
  assert.equal(detail.request_path, '/tag/%E5%B7%A5%E5%85%B7');
  assert.equal(detail.ip_address, '203.0.113.10');
  assert.equal(detail.geo_status, 'not_found');
  assert.equal(detail.user_agent, 'Mozilla/5.0');
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM access_metrics').get().count, 2);
  assert.throws(() => recordAccessEvent(db, event()), /UNIQUE/);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM access_metrics').get().count, 2);
  db.close();
});

test('context update is atomic and returns stored/idempotent/conflict/not_found', () => {
  const db = createDb();
  recordAccessEvent(db, event());
  const first = validateClientContext({ context: {
    viewport: { width: 1280, height: 720 },
    screen: { width: 1920, height: 1080 },
    language: 'zh-CN',
    timezone: 'Asia/Shanghai',
    hardwareConcurrency: 12,
    deviceMemory: 16,
    maxTouchPoints: 1,
    network: { effectiveType: '4g', downlink: 10, rtt: 50, saveData: false }
  } });
  const different = validateClientContext({ context: { viewport: { width: 800, height: 600 } } });

  assert.equal(updateEventContext(db, event().eventId, first, '2026-07-17T00:00:01.000Z'), 'stored');
  assert.equal(updateEventContext(db, event().eventId, first, '2026-07-17T00:00:02.000Z'), 'idempotent');
  assert.equal(updateEventContext(db, event().eventId, different, '2026-07-17T00:00:03.000Z'), 'conflict');
  assert.equal(updateEventContext(db, 'f'.repeat(32), first, '2026-07-17T00:00:04.000Z'), 'not_found');

  const row = db.prepare('SELECT * FROM access_event_details WHERE event_id = ?').get(event().eventId);
  assert.equal(row.context_hash, first.hash);
  assert.equal(row.viewport_width, 1280);
  assert.equal(row.screen_width, 1920);
  assert.equal(row.client_language, 'zh-CN');
  assert.equal(row.context_source, 'combined');
  assert.equal(row.context_collected_at, '2026-07-17T00:00:01.000Z');
  db.close();
});

test('retention deletes exact detail rows and only complete expired legacy hours', () => {
  const db = createDb();
  const now = Date.parse('2026-07-17T12:30:00.000Z');
  const exactCutoff = new Date(now - 30 * 24 * 60 * 60 * 1000).toISOString();
  recordAccessEvent(db, event({
    eventId: '1'.repeat(32),
    observedAtUtc: new Date(Date.parse(exactCutoff) - 1).toISOString(),
    bucketUtc: '2026-06-17T12:00:00.000Z'
  }));
  recordAccessEvent(db, event({
    eventId: '2'.repeat(32),
    observedAtUtc: exactCutoff,
    bucketUtc: '2026-06-17T12:00:00.000Z'
  }));
  const insertLegacy = db.prepare(`
    INSERT INTO access_metrics (bucket_utc, path, visitor_day_hmac, device_kind)
    VALUES (?, ?, ?, 'desktop')
  `);
  insertLegacy.run('2026-06-17T11:00:00.000Z', '/legacy-expired', 'legacy-1');
  insertLegacy.run('2026-06-17T12:00:00.000Z', '/legacy-boundary', 'legacy-2');

  assert.equal(cleanupAnalytics(db, now, 30), 2);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM access_event_details WHERE event_id = ?").get('1'.repeat(32)).count, 0);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM access_event_details WHERE event_id = ?").get('2'.repeat(32)).count, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM access_metrics').get().count, 2);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM access_detail_dimension_metrics').get().count, 0);
  db.close();
});

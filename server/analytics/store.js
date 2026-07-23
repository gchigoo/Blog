const crypto = require('crypto');
const { cleanupAnalytics, initializeEventDetails } = require('./repository');
const { formatAnalyticsPath } = require('./path-display');
const { getOverviewDimensions } = require('./query/analytics-query');
const { getCachedOverview, markOverviewDirty, setCachedOverview } = require('./overview-cache');

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const RETENTION_DAYS = 30;

function hourBucket(now = Date.now()) {
  return new Date(Math.floor(now / HOUR_MS) * HOUR_MS).toISOString();
}

function visitorDayHmac(clientIp, secret, now = Date.now()) {
  if (!secret) throw new Error('ANALYTICS_HMAC_SECRET is required');

  const day = new Date(now).toISOString().slice(0, 10);
  return crypto.createHmac('sha256', secret).update(`${day}:${clientIp}`).digest('hex');
}

function initializeAnalytics(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS access_metrics (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      bucket_utc TEXT NOT NULL,
      path TEXT NOT NULL,
      visitor_day_hmac TEXT NOT NULL,
      device_kind TEXT NOT NULL CHECK (device_kind IN ('desktop', 'mobile', 'tablet', 'other'))
    );
    CREATE INDEX IF NOT EXISTS idx_access_metrics_bucket ON access_metrics(bucket_utc);
    CREATE INDEX IF NOT EXISTS idx_access_metrics_path_bucket ON access_metrics(path, bucket_utc);
  `);
  initializeEventDetails(db);
}

function recordMetric(db, metric) {
  db.prepare(`
    INSERT INTO access_metrics (bucket_utc, path, visitor_day_hmac, device_kind)
    VALUES (?, ?, ?, ?)
  `).run(metric.bucketUtc, metric.path, metric.visitorDayHmac, metric.deviceKind);
  markOverviewDirty(db);
}

function cleanupMetrics(db, now = Date.now(), retentionDays = RETENTION_DAYS) {
  return cleanupAnalytics(db, now, retentionDays);
}

function getOverview(db, now = Date.now(), days = 7, retentionDays = RETENTION_DAYS, geoData = null) {
  const rangeDays = Math.min(Math.max(Number.parseInt(String(days), 10) || 7, 1), retentionDays);
  const cacheKey = `${Math.floor(now / 15_000)}:${rangeDays}:${retentionDays}`;
  const cached = getCachedOverview(db, cacheKey);
  if (cached) return { ...cached, geoData };
  const since = new Date(now - rangeDays * DAY_MS).toISOString();
  const total = db.prepare(`
    SELECT COUNT(*) AS page_views,
      COUNT(DISTINCT visitor_day_hmac) AS anonymous_visitors
    FROM access_metrics WHERE bucket_utc >= ?
  `).get(since);

  const byPage = db.prepare(`
    SELECT path, COUNT(*) AS pageViews,
      COUNT(DISTINCT visitor_day_hmac) AS anonymousVisitors
    FROM access_metrics WHERE bucket_utc >= ?
    GROUP BY path ORDER BY pageViews DESC, path ASC
  `).all(since).map(row => ({ ...row, ...formatAnalyticsPath(row.path) }));
  const overview = {
    days: rangeDays,
    pageViews: total.page_views,
    anonymousVisitors: total.anonymous_visitors,
    byHour: db.prepare(`
      SELECT bucket_utc AS bucketUtc, COUNT(*) AS pageViews,
        COUNT(DISTINCT visitor_day_hmac) AS anonymousVisitors
      FROM access_metrics WHERE bucket_utc >= ?
      GROUP BY bucket_utc ORDER BY bucket_utc ASC
    `).all(since),
    byPage,
    byDevice: db.prepare(`
      SELECT device_kind AS deviceKind, COUNT(*) AS pageViews
      FROM access_metrics WHERE bucket_utc >= ?
      GROUP BY device_kind ORDER BY pageViews DESC, device_kind ASC
    `).all(since),
    ...getOverviewDimensions(db, since)
  };
  setCachedOverview(db, cacheKey, overview);
  return { ...overview, geoData };
}

module.exports = {
  RETENTION_DAYS,
  cleanupMetrics,
  getOverview,
  hourBucket,
  initializeAnalytics,
  recordMetric,
  visitorDayHmac
};

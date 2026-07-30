const crypto = require('crypto');
const { cleanupAnalytics, initializeEventDetails } = require('./repository');
const { formatAnalyticsPath } = require('./path-display');
const { getOverviewDimensions, parseAnalyticsDays } = require('./query/analytics-query');
const { getCachedOverview, markOverviewDirty, setCachedOverview } = require('./overview-cache');
const { migrateAnalyticsTrafficSchema } = require('./traffic-schema');

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const RETENTION_DAYS = 30;
const beijingDateFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit'
});

function beijingDateKey(now) {
  return beijingDateFormatter.format(new Date(now));
}

function hourBucket(now = Date.now()) {
  return new Date(Math.floor(now / HOUR_MS) * HOUR_MS).toISOString();
}

function visitorDayHmac(clientIp, secret, now = Date.now()) {
  if (!secret) throw new Error('ANALYTICS_HMAC_SECRET is required');

  const day = beijingDateKey(now);
  return crypto.createHmac('sha256', secret).update(`${day}:${clientIp}`).digest('hex');
}

function initializeAnalytics(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS access_metrics (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      bucket_utc TEXT NOT NULL,
      path TEXT NOT NULL,
      visitor_day_hmac TEXT NOT NULL,
      device_kind TEXT NOT NULL CHECK (device_kind IN ('desktop', 'mobile', 'tablet', 'other')),
      traffic_kind TEXT NOT NULL DEFAULT 'human' CHECK (traffic_kind IN ('human', 'bot'))
    );
    CREATE INDEX IF NOT EXISTS idx_access_metrics_bucket ON access_metrics(bucket_utc);
    CREATE INDEX IF NOT EXISTS idx_access_metrics_path_bucket ON access_metrics(path, bucket_utc);
  `);
  migrateAnalyticsTrafficSchema(db);
  initializeEventDetails(db);
  migrateAnalyticsTrafficSchema(db);
}

function recordMetric(db, metric) {
  db.prepare(`
    INSERT INTO access_metrics (bucket_utc, path, visitor_day_hmac, device_kind, traffic_kind)
    VALUES (?, ?, ?, ?, ?)
  `).run(metric.bucketUtc, metric.path, metric.visitorDayHmac, metric.deviceKind, metric.trafficKind);
  markOverviewDirty(db);
}

function cleanupMetrics(db, now = Date.now(), retentionDays = RETENTION_DAYS) {
  return cleanupAnalytics(db, now, retentionDays);
}

function selectedRange(now, days, retentionDays) {
  const rangeDays = parseAnalyticsDays(days, retentionDays);
  const exactSinceTime = now - rangeDays * DAY_MS;
  const metricSinceTime = Math.ceil(exactSinceTime / HOUR_MS) * HOUR_MS;
  return {
    rangeDays,
    since: new Date(metricSinceTime).toISOString()
  };
}

function beijingTodayStart(now) {
  return new Date(Math.floor((now + 8 * HOUR_MS) / DAY_MS) * DAY_MS - 8 * HOUR_MS).toISOString();
}

function buildOverviewHumanIpsQuery(since, explain = false) {
  return {
    sql: `${explain ? 'EXPLAIN QUERY PLAN ' : ''}SELECT COUNT(DISTINCT d.ip_address) AS uniqueHumanIps
      FROM access_event_details d INDEXED BY idx_event_details_traffic_ip_observed
      JOIN access_metrics m ON m.id = d.metric_id
      WHERE d.traffic_kind = 'human' AND d.observed_at_utc >= ?
        AND m.traffic_kind = 'human' AND m.bucket_utc >= ?`,
    params: [since, since]
  };
}

function explainOverviewHumanIps(db, now = Date.now(), days = 7, retentionDays = RETENTION_DAYS) {
  const { since } = selectedRange(now, days, retentionDays);
  const query = buildOverviewHumanIpsQuery(since, true);
  return db.prepare(query.sql).all(...query.params);
}

function getOverview(db, now = Date.now(), days = 7, retentionDays = RETENTION_DAYS, geoData = null, detailsEnabled = true) {
  const { rangeDays, since } = selectedRange(now, days, retentionDays);
  const cacheKey = `${Math.floor(now / 15_000)}:${rangeDays}:${retentionDays}:${Boolean(detailsEnabled)}`;
  const cached = getCachedOverview(db, cacheKey);
  if (cached) return { ...cached, geoData };
  const total = db.prepare(`
    SELECT COUNT(*) AS humanPageViews,
      COUNT(DISTINCT visitor_day_hmac) AS anonymousVisitors
    FROM access_metrics
    WHERE traffic_kind = 'human' AND bucket_utc >= ?
  `).get(since);
  const bots = db.prepare(`
    SELECT COUNT(*) AS botPageViews
    FROM access_metrics
    WHERE traffic_kind = 'bot' AND bucket_utc >= ?
  `).get(since);
  const today = db.prepare(`
    SELECT COUNT(DISTINCT visitor_day_hmac) AS anonymousVisitors
    FROM access_metrics
    WHERE traffic_kind = 'human' AND bucket_utc >= ?
  `).get(beijingTodayStart(now));
  const detail = detailsEnabled
    ? db.prepare(`
      SELECT COUNT(*) AS humanDetailPageViews
      FROM access_event_details d
      JOIN access_metrics m ON m.id = d.metric_id
      WHERE d.traffic_kind = 'human' AND m.bucket_utc >= ?
    `).get(since)
    : { humanDetailPageViews: 0 };
  if (detailsEnabled) {
    const ipQuery = buildOverviewHumanIpsQuery(since);
    detail.uniqueHumanIps = db.prepare(ipQuery.sql).get(...ipQuery.params).uniqueHumanIps;
  }

  const byPage = db.prepare(`
    SELECT path, COUNT(*) AS pageViews,
      COUNT(DISTINCT visitor_day_hmac) AS anonymousVisitors
    FROM access_metrics
    WHERE traffic_kind = 'human' AND bucket_utc >= ?
    GROUP BY path ORDER BY pageViews DESC, path ASC
  `).all(since).map(row => ({ ...row, ...formatAnalyticsPath(row.path) }));
  const detailsComplete = Boolean(detailsEnabled)
    && detail.humanDetailPageViews === total.humanPageViews;
  const overview = {
    days: rangeDays,
    todayActiveVisitors: today.anonymousVisitors,
    uniqueHumanIps: detailsEnabled ? detail.uniqueHumanIps : null,
    humanPageViews: total.humanPageViews,
    botPageViews: bots.botPageViews,
    detailsAvailable: Boolean(detailsEnabled),
    detailsComplete,
    pageViews: total.humanPageViews,
    anonymousVisitors: total.anonymousVisitors,
    detailCoverage: {
      pageViews: detail.humanDetailPageViews,
      humanPageViews: detail.humanDetailPageViews,
      complete: detailsComplete
    },
    byHour: db.prepare(`
      SELECT bucket_utc AS bucketUtc, COUNT(*) AS pageViews,
        COUNT(DISTINCT visitor_day_hmac) AS anonymousVisitors
      FROM access_metrics
      WHERE traffic_kind = 'human' AND bucket_utc >= ?
      GROUP BY bucket_utc ORDER BY bucket_utc ASC
    `).all(since),
    byPage,
    byDevice: db.prepare(`
      SELECT device_kind AS deviceKind, COUNT(*) AS pageViews
      FROM access_metrics
      WHERE traffic_kind = 'human' AND bucket_utc >= ?
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
  explainOverviewHumanIps,
  getOverview,
  hourBucket,
  initializeAnalytics,
  parseAnalyticsDays,
  recordMetric,
  visitorDayHmac
};

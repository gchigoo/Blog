const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const { markOverviewDirty } = require('./overview-cache');

const DETAIL_COLUMNS = [
  'metric_id', 'event_id', 'observed_at_utc', 'method', 'request_path', 'query_string',
  'full_url', 'referrer', 'referrer_host', 'url_sanitization_status', 'referrer_parse_status',
  'status_code', 'duration_ms', 'response_bytes', 'ip_address', 'ip_family',
  'continent_code', 'continent_name', 'country_code', 'country_name',
  'subdivision_code', 'subdivision_name', 'subdivision_name_normalized',
  'city_name', 'city_name_normalized', 'postal_code', 'geo_timezone', 'latitude', 'longitude',
  'accuracy_radius_km', 'geo_dataset_date', 'geo_status', 'user_agent', 'accept_language',
  'request_client_hints_json', 'device_type', 'device_vendor', 'device_model', 'device_model_normalized',
  'device_type_normalized', 'os_name', 'os_version', 'os_name_normalized',
  'browser_name', 'browser_version', 'browser_name_normalized', 'engine_name', 'engine_version',
  'cpu_architecture', 'client_parse_status', 'context_source'
];

function normalize(value) {
  return typeof value === 'string' && value.trim()
    ? value.trim().normalize('NFKC').toLowerCase()
    : null;
}

function textOr(value, fallback) {
  return typeof value === 'string' && value ? value : fallback;
}

function dimensionRows(event) {
  const geo = event.geo?.data || {};
  const client = event.client?.data || {};
  const countryCode = textOr(geo.countryCode, 'unknown');
  const countryName = textOr(geo.countryName, 'Unknown');
  return [
    ['byCountry', countryCode, countryName],
    [
      'bySubdivision',
      `${countryCode}:${normalize(geo.subdivisionName) || 'unknown'}`,
      `${countryName} / ${textOr(geo.subdivisionName, 'Unknown')}`
    ],
    [
      'byCity',
      `${countryCode}:${normalize(geo.cityName) || 'unknown'}`,
      `${countryName} / ${textOr(geo.cityName, 'Unknown')}`
    ],
    ['byBrowser', client.browserNameNormalized || normalize(client.browserName) || 'unknown', textOr(client.browserName, 'Unknown')],
    ['byOs', client.osNameNormalized || normalize(client.osName) || 'unknown', textOr(client.osName, 'Unknown')],
    ['byDeviceModel', normalize(client.deviceModel) || 'unknown', textOr(client.deviceModel, 'Unknown')],
    ['byReferrerHost', textOr(event.referrerHost, 'unknown'), textOr(event.referrerHost, 'Unknown')]
  ];
}

function initializeEventDetails(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS access_event_details (
      metric_id INTEGER PRIMARY KEY REFERENCES access_metrics(id) ON DELETE CASCADE,
      event_id TEXT UNIQUE NOT NULL CHECK (length(event_id) = 32),
      observed_at_utc TEXT NOT NULL,
      method TEXT NOT NULL,
      request_path TEXT NOT NULL,
      query_string TEXT,
      full_url TEXT NOT NULL,
      referrer TEXT,
      referrer_host TEXT,
      url_sanitization_status TEXT NOT NULL,
      referrer_parse_status TEXT NOT NULL,
      status_code INTEGER NOT NULL,
      duration_ms INTEGER NOT NULL,
      response_bytes INTEGER,
      ip_address TEXT NOT NULL,
      ip_family INTEGER NOT NULL CHECK (ip_family IN (4, 6)),
      continent_code TEXT,
      continent_name TEXT,
      country_code TEXT,
      country_name TEXT,
      subdivision_code TEXT,
      subdivision_name TEXT,
      subdivision_name_normalized TEXT,
      city_name TEXT,
      city_name_normalized TEXT,
      postal_code TEXT,
      geo_timezone TEXT,
      latitude REAL,
      longitude REAL,
      accuracy_radius_km INTEGER,
      geo_dataset_date TEXT,
      geo_status TEXT NOT NULL CHECK (geo_status IN ('resolved', 'not_found', 'private', 'lookup_error')),
      user_agent TEXT NOT NULL,
      accept_language TEXT NOT NULL,
      request_client_hints_json TEXT NOT NULL,
      device_type TEXT,
      device_vendor TEXT,
      device_model TEXT,
      device_model_normalized TEXT,
      device_type_normalized TEXT,
      os_name TEXT,
      os_version TEXT,
      os_name_normalized TEXT,
      browser_name TEXT,
      browser_version TEXT,
      browser_name_normalized TEXT,
      engine_name TEXT,
      engine_version TEXT,
      cpu_architecture TEXT,
      client_parse_status TEXT NOT NULL CHECK (client_parse_status IN ('parsed', 'unknown', 'error')),
      client_context_json TEXT,
      context_hash TEXT,
      context_collected_at TEXT,
      context_source TEXT NOT NULL CHECK (context_source IN ('server', 'client-fetch', 'combined')),
      screen_width INTEGER,
      screen_height INTEGER,
      screen_avail_width INTEGER,
      screen_avail_height INTEGER,
      viewport_width INTEGER,
      viewport_height INTEGER,
      device_pixel_ratio REAL,
      color_depth INTEGER,
      pixel_depth INTEGER,
      client_language TEXT,
      client_languages_json TEXT,
      client_timezone TEXT,
      hardware_concurrency INTEGER,
      device_memory_gb REAL,
      max_touch_points INTEGER,
      connection_effective_type TEXT,
      connection_downlink_mbps REAL,
      connection_rtt_ms REAL,
      connection_save_data INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_event_details_observed
      ON access_event_details(observed_at_utc DESC, metric_id DESC);
    CREATE INDEX IF NOT EXISTS idx_event_details_ip_observed
      ON access_event_details(ip_address, observed_at_utc DESC, metric_id DESC);
    CREATE INDEX IF NOT EXISTS idx_event_details_location_observed
      ON access_event_details(country_code, subdivision_name_normalized, city_name_normalized, observed_at_utc DESC, metric_id DESC);
    CREATE INDEX IF NOT EXISTS idx_event_details_country_city_observed
      ON access_event_details(country_code, city_name_normalized, observed_at_utc DESC, metric_id DESC);
    CREATE INDEX IF NOT EXISTS idx_event_details_browser_observed
      ON access_event_details(browser_name_normalized, observed_at_utc DESC, metric_id DESC);
    CREATE INDEX IF NOT EXISTS idx_event_details_path_observed
      ON access_event_details(request_path, observed_at_utc DESC, metric_id DESC);
    CREATE INDEX IF NOT EXISTS idx_event_details_referrer_observed
      ON access_event_details(referrer_host, observed_at_utc DESC, metric_id DESC);
    CREATE INDEX IF NOT EXISTS idx_event_details_device_observed
      ON access_event_details(device_type_normalized, observed_at_utc DESC, metric_id DESC);
    CREATE INDEX IF NOT EXISTS idx_event_details_os_observed
      ON access_event_details(os_name_normalized, observed_at_utc DESC, metric_id DESC);
    CREATE TABLE IF NOT EXISTS access_detail_dimension_metrics (
      dimension TEXT NOT NULL CHECK (dimension IN (
        'byCountry', 'bySubdivision', 'byCity', 'byBrowser',
        'byOs', 'byDeviceModel', 'byReferrerHost'
      )),
      dimension_key TEXT NOT NULL,
      bucket_utc TEXT NOT NULL,
      dimension_label TEXT NOT NULL,
      page_views INTEGER NOT NULL CHECK (page_views > 0),
      PRIMARY KEY (dimension, dimension_key, bucket_utc)
    ) WITHOUT ROWID;
    CREATE INDEX IF NOT EXISTS idx_detail_dimensions_bucket
      ON access_detail_dimension_metrics(bucket_utc);
  `);
  const detailColumns = new Set(
    db.prepare('PRAGMA table_info(access_event_details)').all().map(column => column.name)
  );
  if (!detailColumns.has('device_model_normalized')) {
    db.exec('ALTER TABLE access_event_details ADD COLUMN device_model_normalized TEXT');
    const updateModel = db.prepare(`
      UPDATE access_event_details SET device_model_normalized = ? WHERE metric_id = ?
    `);
    const backfill = db.transaction(() => {
      for (const row of db.prepare('SELECT metric_id, device_model FROM access_event_details').iterate()) {
        updateModel.run(normalize(row.device_model), row.metric_id);
      }
    });
    backfill.immediate();
  }
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_event_details_model_observed
      ON access_event_details(device_model_normalized, observed_at_utc DESC, metric_id DESC)
  `);
  const detailCount = db.prepare('SELECT COUNT(*) AS count FROM access_event_details').get().count;
  const aggregateCount = db.prepare('SELECT COUNT(*) AS count FROM access_detail_dimension_metrics').get().count;
  if (detailCount > 0 && aggregateCount === 0) rebuildDetailDimensionMetrics(db);
}

function rebuildDetailDimensionMetrics(db) {
  const definitions = [
    [
      'byCountry',
      "COALESCE(NULLIF(d.country_code, ''), 'unknown')",
      "COALESCE(NULLIF(d.country_name, ''), 'Unknown')"
    ],
    [
      'bySubdivision',
      "COALESCE(NULLIF(d.country_code, ''), 'unknown') || ':' || COALESCE(NULLIF(d.subdivision_name_normalized, ''), 'unknown')",
      "COALESCE(NULLIF(d.country_name, ''), 'Unknown') || ' / ' || COALESCE(NULLIF(d.subdivision_name, ''), 'Unknown')"
    ],
    [
      'byCity',
      "COALESCE(NULLIF(d.country_code, ''), 'unknown') || ':' || COALESCE(NULLIF(d.city_name_normalized, ''), 'unknown')",
      "COALESCE(NULLIF(d.country_name, ''), 'Unknown') || ' / ' || COALESCE(NULLIF(d.city_name, ''), 'Unknown')"
    ],
    ['byBrowser', "COALESCE(NULLIF(d.browser_name_normalized, ''), 'unknown')", "COALESCE(NULLIF(d.browser_name, ''), 'Unknown')"],
    ['byOs', "COALESCE(NULLIF(d.os_name_normalized, ''), 'unknown')", "COALESCE(NULLIF(d.os_name, ''), 'Unknown')"],
    ['byDeviceModel', "COALESCE(NULLIF(d.device_model_normalized, ''), 'unknown')", "COALESCE(NULLIF(d.device_model, ''), 'Unknown')"],
    ['byReferrerHost', "COALESCE(NULLIF(d.referrer_host, ''), 'unknown')", "COALESCE(NULLIF(d.referrer_host, ''), 'Unknown')"]
  ];
  const rebuild = db.transaction(() => {
    db.prepare('DELETE FROM access_detail_dimension_metrics').run();
    for (const [dimension, keyExpression, labelExpression] of definitions) {
      db.prepare(`
        INSERT INTO access_detail_dimension_metrics (
          dimension, dimension_key, bucket_utc, dimension_label, page_views
        )
        SELECT ?, ${keyExpression}, m.bucket_utc, MIN(${labelExpression}), COUNT(*)
        FROM access_event_details d
        JOIN access_metrics m ON m.id = d.metric_id
        GROUP BY m.bucket_utc, ${keyExpression}
      `).run(dimension);
    }
  });
  rebuild.immediate();
}

function detailValues(metricId, event) {
  const geo = event.geo?.data || {};
  const client = event.client?.data || {};
  return [
    metricId, event.eventId, event.observedAtUtc, event.method, event.requestPath,
    event.queryString, event.fullUrl, event.referrer, event.referrerHost,
    event.urlSanitizationStatus, event.referrerParseStatus, event.statusCode,
    event.durationMs, event.responseBytes, event.ipAddress, event.ipFamily,
    geo.continentCode || null, geo.continentName || null, geo.countryCode || null,
    geo.countryName || null, geo.subdivisionCode || null, geo.subdivisionName || null,
    normalize(geo.subdivisionName), geo.cityName || null, normalize(geo.cityName),
    geo.postalCode || null, geo.timezone || null, geo.latitude ?? null, geo.longitude ?? null,
    geo.accuracyRadiusKm ?? null, event.geo?.datasetDate || null, event.geo?.status || 'lookup_error',
    event.requestClient.userAgent, event.requestClient.acceptLanguage,
    JSON.stringify(event.requestClient.clientHints || {}), client.deviceType || null,
    client.deviceVendor || null, client.deviceModel || null, normalize(client.deviceModel),
    client.deviceTypeNormalized || normalize(client.deviceType),
    client.osName || null, client.osVersion || null, client.osNameNormalized || normalize(client.osName),
    client.browserName || null, client.browserVersion || null,
    client.browserNameNormalized || normalize(client.browserName), client.engineName || null,
    client.engineVersion || null, client.cpuArchitecture || null, event.client?.status || 'error', 'server'
  ];
}

function recordAccessEvent(db, event) {
  const transaction = db.transaction(() => {
    const metric = db.prepare(`
      INSERT INTO access_metrics (bucket_utc, path, visitor_day_hmac, device_kind)
      VALUES (?, ?, ?, ?)
    `).run(event.bucketUtc, event.path, event.visitorDayHmac, event.deviceKind);
    const metricId = Number(metric.lastInsertRowid);
    db.prepare(`
      INSERT INTO access_event_details (${DETAIL_COLUMNS.join(', ')})
      VALUES (${DETAIL_COLUMNS.map(() => '?').join(', ')})
    `).run(...detailValues(metricId, event));
    const upsertDimension = db.prepare(`
      INSERT INTO access_detail_dimension_metrics (
        dimension, dimension_key, bucket_utc, dimension_label, page_views
      ) VALUES (?, ?, ?, ?, 1)
      ON CONFLICT (dimension, dimension_key, bucket_utc) DO UPDATE SET
        dimension_label = MIN(dimension_label, excluded.dimension_label),
        page_views = page_views + 1
    `);
    for (const [dimension, key, label] of dimensionRows(event)) {
      upsertDimension.run(dimension, key, event.bucketUtc, label);
    }
    return { metricId, eventId: event.eventId };
  });
  const result = transaction();
  markOverviewDirty(db);
  return result;
}

function contextColumns(validated, collectedAt) {
  const value = validated.value;
  return {
    clientContextJson: validated.canonical,
    contextHash: validated.hash,
    contextCollectedAt: collectedAt,
    screenWidth: value.screen?.width ?? null,
    screenHeight: value.screen?.height ?? null,
    screenAvailWidth: value.screen?.availWidth ?? null,
    screenAvailHeight: value.screen?.availHeight ?? null,
    viewportWidth: value.viewport?.width ?? null,
    viewportHeight: value.viewport?.height ?? null,
    devicePixelRatio: value.devicePixelRatio ?? null,
    colorDepth: value.screen?.colorDepth ?? null,
    pixelDepth: value.screen?.pixelDepth ?? null,
    clientLanguage: value.language || value.languages?.[0] || null,
    clientLanguagesJson: value.languages ? JSON.stringify(value.languages) : null,
    clientTimezone: value.timezone || null,
    hardwareConcurrency: value.hardwareConcurrency ?? null,
    deviceMemoryGb: value.deviceMemory ?? null,
    maxTouchPoints: value.maxTouchPoints ?? null,
    connectionEffectiveType: value.network?.effectiveType || null,
    connectionDownlinkMbps: value.network?.downlink ?? null,
    connectionRttMs: value.network?.rtt ?? null,
    connectionSaveData: value.network?.saveData === undefined ? null : Number(value.network.saveData)
  };
}

function updateEventContext(db, eventId, validated, collectedAt) {
  const transaction = db.transaction(() => {
    const row = db.prepare(`
      SELECT context_hash AS contextHash
      FROM access_event_details WHERE event_id = ?
    `).get(eventId);
    if (!row) return 'not_found';
    if (row.contextHash !== null) return row.contextHash === validated.hash ? 'idempotent' : 'conflict';

    const context = contextColumns(validated, collectedAt);
    const result = db.prepare(`
      UPDATE access_event_details SET
        client_context_json = ?, context_hash = ?, context_collected_at = ?, context_source = 'combined',
        screen_width = ?, screen_height = ?, screen_avail_width = ?, screen_avail_height = ?,
        viewport_width = ?, viewport_height = ?, device_pixel_ratio = ?, color_depth = ?, pixel_depth = ?,
        client_language = ?, client_languages_json = ?, client_timezone = ?, hardware_concurrency = ?,
        device_memory_gb = ?, max_touch_points = ?, connection_effective_type = ?,
        connection_downlink_mbps = ?, connection_rtt_ms = ?, connection_save_data = ?
      WHERE event_id = ? AND context_collected_at IS NULL
    `).run(
      context.clientContextJson, context.contextHash, context.contextCollectedAt,
      context.screenWidth, context.screenHeight, context.screenAvailWidth, context.screenAvailHeight,
      context.viewportWidth, context.viewportHeight, context.devicePixelRatio, context.colorDepth,
      context.pixelDepth, context.clientLanguage, context.clientLanguagesJson, context.clientTimezone,
      context.hardwareConcurrency, context.deviceMemoryGb, context.maxTouchPoints,
      context.connectionEffectiveType, context.connectionDownlinkMbps, context.connectionRttMs,
      context.connectionSaveData, eventId
    );
    if (result.changes === 1) return 'stored';
    const concurrent = db.prepare('SELECT context_hash AS contextHash FROM access_event_details WHERE event_id = ?').get(eventId);
    return concurrent?.contextHash === validated.hash ? 'idempotent' : 'conflict';
  });
  return transaction.immediate();
}

function cleanupAnalytics(db, now = Date.now(), retentionDays = 30) {
  const exactCutoff = new Date(now - retentionDays * DAY_MS).toISOString();
  const legacyCutoff = new Date(Math.floor(Date.parse(exactCutoff) / HOUR_MS) * HOUR_MS).toISOString();
  const detailBucketCutoff = new Date(Math.ceil(Date.parse(exactCutoff) / HOUR_MS) * HOUR_MS).toISOString();
  const transaction = db.transaction(() => {
    const changes = db.prepare(`
      DELETE FROM access_metrics
      WHERE (
        EXISTS (
          SELECT 1 FROM access_event_details detail
          WHERE detail.metric_id = access_metrics.id AND detail.observed_at_utc < ?
        )
      ) OR (
        NOT EXISTS (
          SELECT 1 FROM access_event_details detail WHERE detail.metric_id = access_metrics.id
        ) AND access_metrics.bucket_utc < ?
      )
    `).run(exactCutoff, legacyCutoff).changes;
    db.prepare('DELETE FROM access_detail_dimension_metrics WHERE bucket_utc < ?').run(detailBucketCutoff);
    return changes;
  });
  const changes = transaction.immediate();
  if (changes) markOverviewDirty(db);
  return changes;
}

module.exports = {
  cleanupAnalytics,
  initializeEventDetails,
  rebuildDetailDimensionMetrics,
  recordAccessEvent,
  updateEventContext
};

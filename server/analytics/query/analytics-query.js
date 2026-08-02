const net = require('node:net');
const { domainToASCII } = require('node:url');
const { formatPresentationPath } = require('../path-display');
const { presentEventPages } = require('../page-presentation');
const { normalizeTrustedIp } = require('../request-security');

const DAY_MS = 24 * 60 * 60 * 1000;
const LIST_FIELDS = `
  d.metric_id, d.event_id, d.observed_at_utc, d.request_path, d.full_url, d.referrer,
  d.status_code, d.duration_ms, d.response_bytes, d.ip_address,
  d.continent_code, d.continent_name, d.country_code, d.country_name,
  d.subdivision_code, d.subdivision_name, d.city_name, d.postal_code, d.geo_timezone,
  d.latitude, d.longitude, d.accuracy_radius_km,
  d.device_type, d.device_vendor, d.device_model, d.os_name, d.os_version,
  d.browser_name, d.browser_version, d.engine_name, d.engine_version,
  d.cpu_architecture, d.traffic_kind, d.bot_name, d.context_source, d.context_collected_at,
  d.geo_dataset_date, d.geo_status, d.client_parse_status
`;

function invalidFilter(field, reason = 'invalid_value') {
  throw Object.assign(new Error('invalid_filter'), { code: 'invalid_filter', field, reason });
}

function optionalString(value, maxLength, field) {
  if (value === undefined) return null;
  if (typeof value !== 'string') invalidFilter(field, 'invalid_type');
  const trimmed = value.trim();
  if (!trimmed) return null;
  if ([...trimmed].length > maxLength) invalidFilter(field, 'too_long');
  return trimmed;
}

function integer(value, defaultValue, min, max, field) {
  if (value === undefined) return defaultValue;
  if (typeof value !== 'string' || !/^\d+$/.test(value)) invalidFilter(field);
  const parsed = Number(value);
  if (parsed < min || parsed > max) invalidFilter(field, 'out_of_range');
  return parsed;
}

function parseAnalyticsDays(value, retentionDays = 30) {
  const parsed = value === undefined
    ? Math.min(7, retentionDays)
    : typeof value === 'number'
      ? value
      : typeof value === 'string' && /^\d+$/.test(value)
        ? Number(value)
        : NaN;
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > retentionDays) {
    throw Object.assign(new Error('invalid_analytics_days'), { code: 'invalid_analytics_days' });
  }
  return parsed;
}

function normalized(value, field, maxLength = 128) {
  const parsed = optionalString(value, maxLength, field);
  return parsed ? parsed.normalize('NFKC').toLowerCase() : null;
}

function decodeCursor(value) {
  if (value === undefined) return null;
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/.test(value)) invalidFilter('cursor');
  try {
    const decoded = Buffer.from(value, 'base64url');
    if (decoded.toString('base64url') !== value) invalidFilter('cursor');
    const cursor = JSON.parse(decoded.toString('utf8'));
    if (!cursor || Object.keys(cursor).join(',') !== 'observedAtUtc,metricId'
      || typeof cursor.observedAtUtc !== 'string'
      || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(cursor.observedAtUtc)
      || !Number.isFinite(Date.parse(cursor.observedAtUtc))
      || new Date(cursor.observedAtUtc).toISOString() !== cursor.observedAtUtc
      || !Number.isSafeInteger(cursor.metricId) || cursor.metricId <= 0) invalidFilter('cursor');
    return cursor;
  } catch (error) {
    if (error?.code === 'invalid_filter') throw error;
    invalidFilter('cursor');
  }
}

function normalizeHost(value) {
  const host = optionalString(value, 255, 'referrerHost');
  if (!host) return null;
  if (/[/@?#]/.test(host)) invalidFilter('referrerHost');
  const ascii = domainToASCII(host.toLowerCase());
  if (!ascii || ascii.length > 255) invalidFilter('referrerHost');
  return ascii;
}

function parseEventListQuery(query = {}, retentionDays = 30) {
  let days;
  try {
    days = parseAnalyticsDays(query.days, retentionDays);
  } catch {
    invalidFilter('days');
  }
  const limit = integer(query.limit, 50, 1, 100, 'limit');
  const traffic = normalized(query.traffic, 'traffic', 16) || 'all';
  if (!['all', 'human', 'bot'].includes(traffic)) invalidFilter('traffic', 'unsupported_value');
  let search = null;
  if (query.search !== undefined) {
    if (typeof query.search !== 'string') invalidFilter('search', 'invalid_type');
    search = query.search.normalize('NFKC').trim() || null;
    if (search !== null && [...search].length > 256) invalidFilter('search', 'too_long');
  }
  let ip = null;
  if (query.ip !== undefined) {
    const rawIp = optionalString(query.ip, 64, 'ip');
    if (rawIp) {
      ip = normalizeTrustedIp(rawIp);
      if (!ip || !net.isIP(ip)) invalidFilter('ip');
    }
  }
  let country = null;
  if (query.country !== undefined) {
    const rawCountry = optionalString(query.country, 2, 'country');
    if (rawCountry) {
      country = rawCountry.toUpperCase();
      if (!/^[A-Z]{2}$/.test(country)) invalidFilter('country');
    }
  }
  const subdivision = normalized(query.subdivision, 'subdivision');
  const city = normalized(query.city, 'city');
  if ((subdivision || city) && !country) invalidFilter(subdivision ? 'subdivision' : 'city', 'country_required');
  const device = normalized(query.device, 'device');
  if (device && !['desktop', 'mobile', 'tablet', 'other'].includes(device)) invalidFilter('device', 'unsupported_value');

  return Object.freeze({
    days,
    limit,
    cursor: decodeCursor(query.cursor),
    filters: {
      search,
      traffic,
      ip,
      country,
      subdivision,
      city,
      browser: normalized(query.browser, 'browser'),
      os: normalized(query.os, 'os'),
      device,
      pathPrefix: optionalString(query.pathPrefix, 2048, 'pathPrefix'),
      referrerHost: query.referrerHost === undefined ? null : normalizeHost(query.referrerHost)
    }
  });
}

function escapeLike(value) {
  return value.replaceAll('\\', '\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_');
}

function hasArticlesTable(db) {
  return Boolean(db.prepare(`
    SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'articles'
  `).get());
}

/**
 * Expand every article matching the free-text title search into its
 * locale-prefixed path candidates, plus the historical unprefixed Chinese
 * article path candidates for zh rows only. Raw and percent-encoded slug
 * variants are both included so stored URLs in either form match.
 */
function articlePathsForSearch(db, search) {
  if (!search || !hasArticlesTable(db)) return [];
  const articleColumns = new Set(
    db.prepare('PRAGMA table_info(articles)').all().map(column => column.name)
  );
  const localeSelect = articleColumns.has('locale')
    ? 'locale, slug'
    : "'zh' AS locale, slug";
  const pattern = `%${escapeLike(search)}%`;
  const paths = new Set();
  for (const { locale, slug } of db.prepare(`
    SELECT ${localeSelect} FROM articles
    WHERE title LIKE ? ESCAPE '\\' COLLATE NOCASE
    ORDER BY locale, slug
  `).all(pattern)) {
    paths.add(`/${locale}/article/${slug}`);
    paths.add(`/${locale}/article/${encodeURIComponent(slug)}`);
    if (locale === 'zh') {
      paths.add(`/article/${slug}`);
      paths.add(`/article/${encodeURIComponent(slug)}`);
    }
  }
  return [...paths];
}

function buildEventListQuery(now, options, articlePaths = [], explain = false) {
  const where = ['d.observed_at_utc >= ?'];
  const params = [new Date(now - options.days * DAY_MS).toISOString()];
  const { filters } = options;
  const predicates = [
    ['ip', 'd.ip_address = ?'],
    ['country', 'd.country_code = ?'],
    ['subdivision', 'd.subdivision_name_normalized = ?'],
    ['city', 'd.city_name_normalized = ?'],
    ['browser', 'd.browser_name_normalized = ?'],
    ['os', 'd.os_name_normalized = ?'],
    ['device', 'd.device_type_normalized = ?'],
    ['referrerHost', 'd.referrer_host = ?']
  ];
  for (const [name, sql] of predicates) {
    if (filters[name] !== null) {
      where.push(sql);
      params.push(filters[name]);
    }
  }
  if (filters.traffic !== 'all') {
    where.push('d.traffic_kind = ?');
    params.push(filters.traffic);
  }
  if (filters.search !== null) {
    const pattern = `%${escapeLike(filters.search)}%`;
    const searchPredicates = [
      "d.ip_address LIKE ? ESCAPE '\\' COLLATE NOCASE",
      "d.request_path LIKE ? ESCAPE '\\' COLLATE NOCASE"
    ];
    params.push(pattern, pattern);
    if (articlePaths.length > 0) {
      searchPredicates.push(`d.request_path IN (${articlePaths.map(() => '?').join(', ')})`);
      params.push(...articlePaths);
    }
    where.push(`(${searchPredicates.join(' OR ')})`);
  }
  if (filters.pathPrefix !== null) {
    where.push('d.request_path >= ? AND d.request_path < ?');
    params.push(filters.pathPrefix, `${filters.pathPrefix}\uFFFF`);
  }
  if (options.cursor) {
    where.push('(d.observed_at_utc < ? OR (d.observed_at_utc = ? AND d.metric_id < ?))');
    params.push(options.cursor.observedAtUtc, options.cursor.observedAtUtc, options.cursor.metricId);
  }
  params.push(options.limit + 1);
  return {
    sql: `${explain ? 'EXPLAIN QUERY PLAN ' : ''}SELECT ${LIST_FIELDS}
      FROM access_event_details d
      WHERE ${where.join(' AND ')}
      ORDER BY d.observed_at_utc DESC, d.metric_id DESC
      LIMIT ?`,
    params
  };
}

function sources(row) {
  return row.context_source === 'combined' || row.context_source === 'client-fetch'
    ? ['server', 'client-fetch']
    : ['server'];
}

function mapListRow(row, page) {
  const display = formatPresentationPath(row.request_path);
  return {
    id: row.event_id,
    observedAtUtc: row.observed_at_utc,
    requestPath: row.request_path,
    ...display,
    trafficKind: row.traffic_kind,
    botName: row.bot_name,
    page,
    fullUrl: row.full_url,
    referrer: row.referrer,
    statusCode: row.status_code,
    durationMs: row.duration_ms,
    responseBytes: row.response_bytes,
    ipAddress: row.ip_address,
    location: {
      continent: { code: row.continent_code, name: row.continent_name },
      country: { code: row.country_code, name: row.country_name },
      subdivision: { code: row.subdivision_code, name: row.subdivision_name },
      city: row.city_name,
      postalCode: row.postal_code,
      timezone: row.geo_timezone,
      coordinates: row.latitude === null || row.longitude === null
        ? null : { latitude: row.latitude, longitude: row.longitude },
      accuracyRadiusKm: row.accuracy_radius_km
    },
    client: {
      deviceType: row.device_type,
      vendor: row.device_vendor,
      model: row.device_model,
      os: { name: row.os_name, version: row.os_version },
      browser: { name: row.browser_name, version: row.browser_version },
      engine: { name: row.engine_name, version: row.engine_version },
      cpuArchitecture: row.cpu_architecture,
      contextAvailable: row.context_collected_at !== null,
      sources: sources(row)
    }
  };
}

function encodeCursor(row) {
  return Buffer.from(JSON.stringify({
    observedAtUtc: row.observed_at_utc,
    metricId: row.metric_id
  })).toString('base64url');
}

function listEvents(db, now, options) {
  const articlePaths = articlePathsForSearch(db, options.filters.search);
  const query = buildEventListQuery(now, options, articlePaths);
  const rows = db.prepare(query.sql).all(...query.params);
  const hasMore = rows.length > options.limit;
  const selected = rows.slice(0, options.limit);
  const pages = presentEventPages(db, selected);
  return {
    days: options.days,
    items: selected.map(row => mapListRow(row, pages.get(row.metric_id))),
    nextCursor: hasMore ? encodeCursor(selected.at(-1)) : null
  };
}

function explainEventList(db, now, options) {
  const articlePaths = articlePathsForSearch(db, options.filters.search);
  const query = buildEventListQuery(now, options, articlePaths, true);
  return db.prepare(query.sql).all(...query.params);
}

function parseJson(value) {
  if (!value) return null;
  try { return JSON.parse(value); } catch { return null; }
}

function getEventDetail(db, eventId) {
  if (!/^[0-9a-f]{32}$/.test(eventId)) return null;
  const row = db.prepare('SELECT * FROM access_event_details WHERE event_id = ?').get(eventId);
  if (!row) return null;
  const page = presentEventPages(db, [row]).get(row.metric_id);
  const base = mapListRow(row, page);
  return {
    ...base,
    raw: {
      userAgent: row.user_agent,
      requestClientHints: parseJson(row.request_client_hints_json),
      browserClientContext: parseJson(row.client_context_json)
    },
    screen: {
      width: row.screen_width, height: row.screen_height,
      availWidth: row.screen_avail_width, availHeight: row.screen_avail_height,
      devicePixelRatio: row.device_pixel_ratio, colorDepth: row.color_depth, pixelDepth: row.pixel_depth
    },
    viewport: { width: row.viewport_width, height: row.viewport_height },
    hardware: {
      concurrency: row.hardware_concurrency,
      deviceMemoryGb: row.device_memory_gb,
      cpuArchitecture: row.cpu_architecture
    },
    touch: { maxTouchPoints: row.max_touch_points },
    network: {
      effectiveType: row.connection_effective_type,
      downlinkMbps: row.connection_downlink_mbps,
      rttMs: row.connection_rtt_ms,
      saveData: row.connection_save_data === null ? null : Boolean(row.connection_save_data)
    },
    browserContext: {
      language: row.client_language,
      languages: parseJson(row.client_languages_json),
      timezone: row.client_timezone
    },
    collection: {
      sources: sources(row),
      contextCollectedAt: row.context_collected_at,
      geoDatasetDate: row.geo_dataset_date,
      geoStatus: row.geo_status,
      clientParseStatus: row.client_parse_status
    }
  };
}

function queryAggregatedDimension(db, since, totalPageViews, dimension) {
  const rows = db.prepare(`
    SELECT dimension_key AS key, MIN(dimension_label) AS label, SUM(page_views) AS pageViews
    FROM access_detail_dimension_metrics
    WHERE dimension = ? AND bucket_utc >= ?
    GROUP BY dimension_key
    ORDER BY pageViews DESC, key ASC
    LIMIT 51
  `).all(dimension, since);
  const items = rows.slice(0, 50);
  const distinctCount = rows.length <= 50
    ? rows.length
    : db.prepare(`
      SELECT COUNT(*) AS count FROM (
        SELECT 1 FROM access_detail_dimension_metrics
        WHERE dimension = ? AND bucket_utc >= ?
        GROUP BY dimension_key
      )
    `).get(dimension, since).count;
  return {
    items,
    distinctCount,
    truncated: distinctCount > 50,
    otherPageViews: totalPageViews - items.reduce((sum, item) => sum + item.pageViews, 0)
  };
}

function getOverviewDimensions(db, since) {
  const totalPageViews = db.prepare(`
    SELECT COALESCE(SUM(page_views), 0) AS count
    FROM access_detail_dimension_metrics
    WHERE dimension = 'byCountry' AND bucket_utc >= ?
  `).get(since).count;
  const dimensionNames = [
    'byCountry', 'bySubdivision', 'byCity', 'byBrowser',
    'byOs', 'byDeviceModel', 'byReferrerHost'
  ];
  return Object.fromEntries(dimensionNames.map(name => [
    name,
    queryAggregatedDimension(db, since, totalPageViews, name)
  ]));
}

module.exports = {
  explainEventList,
  getEventDetail,
  getOverviewDimensions,
  listEvents,
  parseAnalyticsDays,
  parseEventListQuery
};

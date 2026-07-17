const path = require('node:path');

const DEFAULT_RETENTION_DAYS = 30;
const MIN_SECRET_BYTES = 32;

function parseBoolean(value, name, defaultValue) {
  if (value === undefined) return defaultValue;
  if (value === 'true') return true;
  if (value === 'false') return false;
  throw new Error(`${name} must be true or false`);
}

function parseHmacSecret(value) {
  if (!value) throw new Error('ANALYTICS_HMAC_SECRET is required');
  if (!/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new Error('ANALYTICS_HMAC_SECRET must be canonical unpadded base64url');
  }

  const decoded = Buffer.from(value, 'base64url');
  if (decoded.toString('base64url') !== value) {
    throw new Error('ANALYTICS_HMAC_SECRET must be canonical unpadded base64url');
  }
  if (decoded.length < MIN_SECRET_BYTES) {
    throw new Error('ANALYTICS_HMAC_SECRET must decode to at least 32 bytes');
  }
  return decoded;
}

function parseRetentionDays(value) {
  if (value === undefined) return DEFAULT_RETENTION_DAYS;
  if (!/^\d+$/.test(value)) {
    throw new Error('ANALYTICS_RETENTION_DAYS must be an integer between 1 and 365');
  }
  const parsed = Number(value);
  if (parsed < 1 || parsed > 365) {
    throw new Error('ANALYTICS_RETENTION_DAYS must be between 1 and 365');
  }
  return parsed;
}

function parsePublicOrigin(value, nodeEnv) {
  if (!value) throw new Error('ANALYTICS_PUBLIC_ORIGIN is required when analytics details are enabled');
  let url;
  try {
    url = new URL(value.trim());
  } catch {
    throw new Error('ANALYTICS_PUBLIC_ORIGIN must be an absolute HTTP(S) origin');
  }
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new Error('ANALYTICS_PUBLIC_ORIGIN must be an absolute HTTP(S) origin');
  }
  if (url.username || url.password) {
    throw new Error('ANALYTICS_PUBLIC_ORIGIN must not contain credentials');
  }
  if (url.pathname !== '/' || url.search || url.hash) {
    throw new Error('ANALYTICS_PUBLIC_ORIGIN must not contain a path, query, or fragment');
  }
  if (nodeEnv === 'production' && url.protocol !== 'https:') {
    throw new Error('ANALYTICS_PUBLIC_ORIGIN must use HTTPS in production');
  }
  return url.origin;
}

function siblingStatusPath(databasePath) {
  if (databasePath.startsWith('/')) {
    return path.posix.join(path.posix.dirname(databasePath), 'update-status.json');
  }
  return path.join(path.dirname(databasePath), 'update-status.json');
}

function parseAnalyticsConfig(env = process.env) {
  const detailsEnabled = parseBoolean(
    env.ANALYTICS_DETAILS_ENABLED,
    'ANALYTICS_DETAILS_ENABLED',
    false
  );
  const hmacSecret = parseHmacSecret(env.ANALYTICS_HMAC_SECRET);
  const retentionDays = parseRetentionDays(env.ANALYTICS_RETENTION_DAYS);

  if (!detailsEnabled) {
    return Object.freeze({
      detailsEnabled,
      hmacSecret,
      retentionDays,
      geoIpCityDbPath: null,
      geoIpUpdateStatusPath: null,
      publicOrigin: null
    });
  }

  const geoIpCityDbPath = env.ANALYTICS_GEOIP_CITY_DB_PATH?.trim();
  if (!geoIpCityDbPath) {
    throw new Error('ANALYTICS_GEOIP_CITY_DB_PATH is required when analytics details are enabled');
  }
  const publicOrigin = parsePublicOrigin(env.ANALYTICS_PUBLIC_ORIGIN, env.NODE_ENV);
  const geoIpUpdateStatusPath = env.ANALYTICS_GEOIP_UPDATE_STATUS_PATH?.trim()
    || siblingStatusPath(geoIpCityDbPath);

  return Object.freeze({
    detailsEnabled,
    hmacSecret,
    retentionDays,
    geoIpCityDbPath,
    geoIpUpdateStatusPath,
    publicOrigin
  });
}

module.exports = { parseAnalyticsConfig };

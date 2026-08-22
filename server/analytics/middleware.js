const net = require('node:net');
const { classifyClient, classificationSignals } = require('./client-classifier');
const { recordAccessEvent } = require('./repository');
const { captureRequestClient, normalizeTrustedIp, sanitizePublicRequestUrl, sanitizeReferrer } = require('./request-security');
const { hourBucket, recordMetric, visitorDayHmac } = require('./store');

const EXCLUDED_PREFIXES = ['/auth', '/admin', '/api', '/images', '/audio'];
const EXCLUDED_EXTENSIONS = /\.(?:css|js|webp|ico|png|jpe?g|gif|svg|xml|txt)$/i;

function deviceKind(userAgent = '') {
  if (/ipad|tablet|kindle|silk\//i.test(userAgent)) return 'tablet';
  if (/mobi|android|iphone|ipod/i.test(userAgent)) return 'mobile';
  if (/mozilla|chrome|safari|firefox|edg\//i.test(userAgent)) return 'desktop';
  return 'other';
}

function isTrackableRequest(req) {
  // HEAD is used by scanners and uptime probes; it is not a page view.
  if (req.method !== 'GET') return false;
  if (EXCLUDED_PREFIXES.some(prefix => req.path === prefix || req.path.startsWith(`${prefix}/`))) return false;
  if (EXCLUDED_EXTENSIONS.test(req.path)) return false;
  return true;
}

function isInternalAnalyticsIp(value, internalIps) {
  const normalized = normalizeTrustedIp(value);
  if (!normalized) return false;
  if (normalized === '::1' || normalized.startsWith('127.')) return true;
  return internalIps.has(normalized);
}

function createAnalyticsMiddleware({
  db,
  secret,
  now = () => Date.now(),
  detailsEnabled = false,
  publicOrigin = null,
  geoResolver = null,
  clientParser = null,
  tokenSigner = null,
  internalIps = [],
  logger = console
}) {
  const internalIpSet = new Set(internalIps);
  return (req, res, next) => {
    if (!isTrackableRequest(req)) return next();

    const startedAt = now();
    const capturedPath = req.path.split('?')[0];
    const capturedIp = normalizeTrustedIp(req);
    if (isInternalAnalyticsIp(capturedIp, internalIpSet)) return next();
    const capturedClient = captureRequestClient(req);
    const classification = classifyClient(capturedClient.userAgent, classificationSignals(req));
    const capturedDevice = deviceKind(capturedClient.userAgent);
    const capturedOriginalUrl = req.originalUrl || req.path;
    const capturedReferrer = req.get('referer') || req.get('referrer') || null;
    let eventId = null;

    if (detailsEnabled) {
      eventId = tokenSigner.createEventId();
      res.locals = res.locals || {};
      res.locals.analyticsEventId = eventId;
      if (classification.trafficKind === 'human') {
        res.locals.analyticsEventToken = tokenSigner.sign(eventId, startedAt);
      }
      if (typeof res.render === 'function') {
        const render = res.render;
        res.render = function renderTrackedPage(...args) {
          if (res.statusCode >= 200 && res.statusCode < 400) {
            res.set('Cache-Control', 'private, no-store');
          } else {
            delete res.locals.analyticsEventId;
            delete res.locals.analyticsEventToken;
          }
          return render.apply(this, args);
        };
      }
    }

    res.on('finish', () => {
      // Only completed 2xx HTML responses are persisted. Redirects (3xx),
      // client errors, and server errors never become metrics, so mounting
      // order relative to redirect-producing routers cannot cause
      // double-counting of hops.
      if (res.statusCode < 200 || res.statusCode >= 300) return;
      const contentType = String(res.getHeader?.('content-type') || '');
      if (!/^text\/html(?:;|$)/i.test(contentType)) return;

      try {
        const finishedAt = now();
        const base = {
          bucketUtc: hourBucket(startedAt),
          path: capturedPath,
          visitorDayHmac: visitorDayHmac(capturedIp || 'invalid', secret, startedAt),
          deviceKind: capturedDevice,
          trafficKind: classification.trafficKind
        };
        if (!detailsEnabled) {
          recordMetric(db, base);
          return;
        }

        const url = sanitizePublicRequestUrl(capturedOriginalUrl, publicOrigin);
        const parsedReferrer = sanitizeReferrer(capturedReferrer);
        const referrer = isInternalAnalyticsIp(parsedReferrer.host, internalIpSet)
          ? { value: null, host: null, status: 'internal' }
          : parsedReferrer;
        const geo = geoResolver.resolve(capturedIp);
        geo.datasetDate = geoResolver.getStatus().reader?.datasetDate || null;
        const responseLength = res.getHeader?.('content-length');
        const responseBytes = /^\d+$/.test(String(responseLength ?? ''))
          ? Number(responseLength)
          : null;
        recordAccessEvent(db, {
          ...base,
          eventId,
          botName: classification.botName,
          observedAtUtc: new Date(startedAt).toISOString(),
          method: req.method,
          requestPath: url.requestPath,
          queryString: url.queryString,
          fullUrl: url.fullUrl,
          referrer: referrer.value,
          referrerHost: referrer.host,
          urlSanitizationStatus: url.status,
          referrerParseStatus: referrer.status,
          statusCode: res.statusCode,
          durationMs: Math.max(0, Math.round(finishedAt - startedAt)),
          responseBytes,
          ipAddress: capturedIp,
          ipFamily: net.isIP(capturedIp),
          geo,
          requestClient: capturedClient,
          client: clientParser.parse(capturedClient.userAgent)
        });
      } catch {
        logger.error('[analytics] event write failed');
      }
    });

    next();
  };
}

module.exports = { createAnalyticsMiddleware, deviceKind, isInternalAnalyticsIp, isTrackableRequest };

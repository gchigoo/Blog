const net = require('node:net');
const { recordAccessEvent } = require('./repository');
const { captureRequestClient, normalizeTrustedIp, sanitizePublicRequestUrl, sanitizeReferrer } = require('./request-security');
const { hourBucket, recordMetric, visitorDayHmac } = require('./store');

const EXCLUDED_PREFIXES = ['/auth', '/admin', '/api', '/images'];
const EXCLUDED_EXTENSIONS = /\.(?:css|js|webp|ico|png|jpe?g|gif|svg|xml|txt)$/i;
const BOT_PATTERN = /bot|crawler|spider|slurp|bingpreview|facebookexternalhit|telegrambot/i;

function deviceKind(userAgent = '') {
  if (/ipad|tablet|kindle|silk\//i.test(userAgent)) return 'tablet';
  if (/mobi|android|iphone|ipod/i.test(userAgent)) return 'mobile';
  if (/mozilla|chrome|safari|firefox|edg\//i.test(userAgent)) return 'desktop';
  return 'other';
}

function isTrackableRequest(req) {
  if (!['GET', 'HEAD'].includes(req.method)) return false;
  if (EXCLUDED_PREFIXES.some(prefix => req.path === prefix || req.path.startsWith(`${prefix}/`))) return false;
  if (EXCLUDED_EXTENSIONS.test(req.path)) return false;
  return !BOT_PATTERN.test(req.get('user-agent') || '');
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
  logger = console
}) {
  return (req, res, next) => {
    if (!isTrackableRequest(req)) return next();

    const startedAt = now();
    const capturedPath = req.path.split('?')[0];
    const capturedIp = normalizeTrustedIp(req);
    const capturedClient = captureRequestClient(req);
    const capturedDevice = deviceKind(capturedClient.userAgent);
    const capturedOriginalUrl = req.originalUrl || req.path;
    const capturedReferrer = req.get('referer') || req.get('referrer') || null;
    let eventId = null;

    if (detailsEnabled) {
      eventId = tokenSigner.createEventId();
      res.locals = res.locals || {};
      res.locals.analyticsEventId = eventId;
      res.locals.analyticsEventToken = tokenSigner.sign(eventId, startedAt);
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
      if (res.statusCode < 200 || res.statusCode >= 400) return;
      const contentType = String(res.getHeader?.('content-type') || '');
      if (!/^text\/html(?:;|$)/i.test(contentType)) return;

      try {
        const finishedAt = now();
        const base = {
          bucketUtc: hourBucket(startedAt),
          path: capturedPath,
          visitorDayHmac: visitorDayHmac(capturedIp || 'invalid', secret, startedAt),
          deviceKind: capturedDevice
        };
        if (!detailsEnabled) {
          recordMetric(db, base);
          return;
        }

        const url = sanitizePublicRequestUrl(capturedOriginalUrl, publicOrigin);
        const referrer = sanitizeReferrer(capturedReferrer);
        const geo = geoResolver.resolve(capturedIp);
        geo.datasetDate = geoResolver.getStatus().reader?.datasetDate || null;
        const responseLength = res.getHeader?.('content-length');
        const responseBytes = /^\d+$/.test(String(responseLength ?? ''))
          ? Number(responseLength)
          : null;
        recordAccessEvent(db, {
          ...base,
          eventId,
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

module.exports = { createAnalyticsMiddleware, deviceKind, isTrackableRequest };

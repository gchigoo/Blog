const { cleanupMetrics, hourBucket, recordMetric, visitorDayHmac } = require('./store');

const EXCLUDED_PREFIXES = ['/admin', '/api', '/images'];
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

function createAnalyticsMiddleware({ db, secret, now = () => Date.now() }) {
  let lastCleanupDay = '';

  return (req, res, next) => {
    if (!isTrackableRequest(req)) return next();

    const capturedPath = req.path.split('?')[0];
    const capturedIp = req.ip;
    const capturedDevice = deviceKind(req.get('user-agent') || '');

    res.on('finish', () => {
      if (res.statusCode < 200 || res.statusCode >= 400) return;

      try {
        const timestamp = now();
        const currentDay = new Date(timestamp).toISOString().slice(0, 10);
        if (currentDay !== lastCleanupDay) {
          cleanupMetrics(db, timestamp);
          lastCleanupDay = currentDay;
        }

        recordMetric(db, {
          bucketUtc: hourBucket(timestamp),
          path: capturedPath,
          visitorDayHmac: visitorDayHmac(capturedIp, secret, timestamp),
          deviceKind: capturedDevice
        });
      } catch (error) {
        console.error('匿名访问统计写入失败:', error.message);
      }
    });

    next();
  };
}

module.exports = { createAnalyticsMiddleware, deviceKind, isTrackableRequest };

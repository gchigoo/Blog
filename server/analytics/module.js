const express = require('express');
const { createAnalyticsMiddleware } = require('./middleware');
const { cleanupMetrics, initializeAnalytics } = require('./store');

const CLEANUP_INTERVAL_MS = 6 * 60 * 60 * 1000;

function disabledGeoResolver() {
  return Object.freeze({
    async start() {},
    stop() {},
    resolve() { return { status: 'not_found', data: null }; },
    getStatus() {
      return {
        reader: null,
        updater: { state: 'missing', result: 'unknown' },
        stale: false
      };
    }
  });
}

function createAnalyticsModule({
  db,
  config,
  clock = { now: () => Date.now() },
  logger = console,
  geoResolver,
  clientParser,
  tokenSigner,
  rateLimiter
}) {
  if (!db || !config) throw new Error('analytics module requires db and config');
  initializeAnalytics(db);

  const resolver = geoResolver || (config.detailsEnabled
    ? require('./adapters/geo-resolver').createGeoResolver({
      databasePath: config.geoIpCityDbPath,
      statusPath: config.geoIpUpdateStatusPath,
      clock,
      logger
    })
    : disabledGeoResolver());
  const parser = clientParser || require('./adapters/client-parser').createClientParser();
  const signer = tokenSigner || require('./event-token').createEventTokenSigner({ secret: config.hmacSecret });
  const rateLimiters = rateLimiter || require('./rate-limiter').createAnalyticsRateLimiters({
    now: () => Number(clock.now())
  });
  const publicContextRouter = config.detailsEnabled
    ? require('./public-context').createPublicContextRouter({
      db,
      config,
      clock,
      tokenSigner: signer,
      rateLimiters
    })
    : express.Router();
  const adminApiRouter = require('./admin-api').createAdminApiRouter({
    db,
    config,
    clock,
    geoResolver: resolver,
    logger
  });
  const adminPageRouter = require('./admin-page').createAdminPageRouter({
    db,
    config,
    clock,
    geoResolver: resolver,
    logger
  });
  let cleanupTimer = null;
  let started = false;

  const lifecycle = Object.freeze({
    async start() {
      if (started) return;
      if (config.detailsEnabled) await resolver.start();
      if (config.detailsEnabled) rateLimiters.start();
      try {
        cleanupMetrics(db, clock.now(), config.retentionDays);
      } catch {
        logger.error('[analytics] retention cleanup failed');
      }
      cleanupTimer = setInterval(() => {
        try {
          cleanupMetrics(db, clock.now(), config.retentionDays);
        } catch {
          logger.error('[analytics] retention cleanup failed');
        }
      }, CLEANUP_INTERVAL_MS);
      cleanupTimer.unref?.();
      started = true;
    },
    stop() {
      if (cleanupTimer) clearInterval(cleanupTimer);
      cleanupTimer = null;
      if (started && config.detailsEnabled) resolver.stop();
      if (config.detailsEnabled) rateLimiters.stop();
      started = false;
    }
  });

  return Object.freeze({
    collectorMiddleware: createAnalyticsMiddleware({
      db,
      secret: config.hmacSecret,
      now: clock.now,
      retentionDays: config.retentionDays,
      detailsEnabled: config.detailsEnabled,
      publicOrigin: config.publicOrigin,
      geoResolver: resolver,
      clientParser: parser,
      tokenSigner: signer,
      internalIps: config.internalIps,
      logger
    }),
    publicContextRouter,
    adminApiRouter,
    adminPageRouter,
    lifecycle,
    geoStatus: () => resolver.getStatus()
  });
}

module.exports = { createAnalyticsModule };

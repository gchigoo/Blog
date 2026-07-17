const express = require('express');
const { authenticateToken } = require('../middleware/auth');
const { getOverview } = require('./store');
const { getEventDetail, listEvents, parseEventListQuery } = require('./query/analytics-query');

function createAdminApiRouter({ db, config, clock, geoResolver, logger = console }) {
  const router = express.Router();
  router.use((req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
  });
  router.use(authenticateToken);

  router.get('/', (req, res) => {
    try {
      return res.json(getOverview(
        db,
        clock.now(),
        req.query.days,
        config.retentionDays,
        config.detailsEnabled ? geoResolver.getStatus() : null
      ));
    } catch {
      logger.error('[analytics] overview query failed');
      return res.status(500).json({ error: 'analytics_query_failed' });
    }
  });

  router.get('/events', (req, res) => {
    try {
      const options = parseEventListQuery(req.query, config.retentionDays);
      return res.json(listEvents(db, clock.now(), options));
    } catch (error) {
      if (error?.code === 'invalid_filter') return res.status(400).json({ error: 'invalid_filter' });
      logger.error('[analytics] event list query failed');
      return res.status(500).json({ error: 'analytics_query_failed' });
    }
  });

  router.get('/events/:eventId', (req, res) => {
    try {
      const detail = getEventDetail(db, req.params.eventId);
      if (!detail) return res.status(404).json({ error: 'event_not_found' });
      return res.json(detail);
    } catch {
      logger.error('[analytics] event detail query failed');
      return res.status(500).json({ error: 'analytics_query_failed' });
    }
  });

  return router;
}

module.exports = { createAdminApiRouter };

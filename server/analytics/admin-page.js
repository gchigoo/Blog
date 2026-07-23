const express = require('express');
const { authenticatePage } = require('../middleware/auth');
const { getOverview } = require('./store');
const { listEvents, parseEventListQuery } = require('./query/analytics-query');

const FILTER_NAMES = [
  'ip', 'country', 'subdivision', 'city', 'browser', 'os',
  'device', 'pathPrefix', 'referrerHost'
];

function filterViewModel(query, days) {
  const filters = { days: String(days) };
  for (const name of FILTER_NAMES) {
    filters[name] = typeof query[name] === 'string' ? query[name] : '';
  }
  return filters;
}

function nextPageUrl(filters, cursor) {
  if (!cursor) return null;
  const params = new URLSearchParams();
  for (const [name, value] of Object.entries(filters)) {
    if (value) params.set(name, value);
  }
  params.set('cursor', cursor);
  return `/admin/analytics?${params.toString()}`;
}

function formatBeijingTime(value) {
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23'
  }).format(new Date(value));
}

function createAdminPageRouter({ db, config, clock, geoResolver, logger = console }) {
  const router = express.Router();
  router.use('/admin/analytics', (req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
  });
  router.get('/admin/analytics', authenticatePage, (req, res) => {
    let options;
    let pageError = null;
    try {
      options = parseEventListQuery(req.query, config.retentionDays);
    } catch {
      options = parseEventListQuery({ days: '7' }, config.retentionDays);
      pageError = '筛选条件无效，请检查输入后重试。';
      res.status(400);
    }

    try {
      const filters = filterViewModel(req.query, options.days);
      const events = pageError
        ? { days: options.days, items: [], nextCursor: null }
        : listEvents(db, clock.now(), options);
      const overview = getOverview(
        db,
        clock.now(),
        options.days,
        config.retentionDays,
        config.detailsEnabled ? geoResolver.getStatus() : null
      );
      return res.render('admin/analytics', {
        overview,
        events,
        filters,
        eventNextUrl: nextPageUrl(filters, events.nextCursor),
        formatBeijingTime,
        pageError,
        user: req.user
      });
    } catch {
      logger.error('[analytics] admin page query failed');
      return res.status(500).send('服务器错误');
    }
  });
  return router;
}

module.exports = { createAdminPageRouter };

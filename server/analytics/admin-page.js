const express = require('express');
const { authenticatePage } = require('../middleware/auth');
const { getOverview } = require('./store');
const { listEvents, parseEventListQuery } = require('./query/analytics-query');

const FILTER_NAMES = [
  'search', 'traffic', 'ip', 'country', 'subdivision', 'city', 'browser', 'os',
  'device', 'pathPrefix', 'referrerHost'
];

function filterViewModel(query, days) {
  const filters = { days: String(days) };
  for (const name of FILTER_NAMES) {
    filters[name] = typeof query[name] === 'string' ? query[name] : '';
  }
  if (!filters.traffic) filters.traffic = 'all';
  return filters;
}

function nextPageUrl(filters, cursor, limit) {
  if (!cursor) return null;
  const params = new URLSearchParams();
  for (const [name, value] of Object.entries(filters)) {
    if (value) params.set(name, value);
  }
  if (limit !== 50) params.set('limit', String(limit));
  params.set('cursor', cursor);
  return `/admin/analytics?${params.toString()}#event-list`;
}

function formatBeijingTime(value) {
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23'
  }).format(new Date(value));
}

function rangeOptions(retentionDays) {
  const options = [1, 7, 30].filter(days => days <= retentionDays);
  if (!options.includes(retentionDays)) options.push(retentionDays);
  return options;
}

function systemStatus(detailsEnabled, geoData) {
  let warning = null;
  if (detailsEnabled && geoData?.stale) {
    warning = { severity: 'error', message: 'GeoLite2 City 数据集已超过 14 天，请检查每周更新任务。' };
  } else if (detailsEnabled && !geoData?.reader) {
    warning = { severity: 'error', message: 'GeoLite2 City 数据集不可用，地区查询暂时无法提供。' };
  } else if (detailsEnabled && (geoData?.updater?.state !== 'ok' || geoData?.updater?.result === 'failed')) {
    warning = { severity: 'info', message: 'GeoLite2 City 更新状态异常；当前 reader 如仍有效，会继续提供地区查询。' };
  }
  return { detailsEnabled: Boolean(detailsEnabled), geoData, warning };
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
      options = parseEventListQuery({}, config.retentionDays);
      pageError = '筛选条件无效，请检查输入后重试。';
      res.status(400);
    }

    try {
      const filters = filterViewModel(req.query, options.days);
      const events = !config.detailsEnabled
        ? { available: false, days: options.days, items: [], nextCursor: null }
        : pageError
          ? { available: true, days: options.days, items: [], nextCursor: null }
          : { available: true, ...listEvents(db, clock.now(), options) };
      const geoData = config.detailsEnabled ? geoResolver.getStatus() : null;
      const overview = getOverview(
        db,
        clock.now(),
        options.days,
        config.retentionDays,
        geoData,
        config.detailsEnabled
      );
      return res.render('admin/analytics', {
        overview,
        events,
        filters,
        eventPreviousUrl: null,
        eventNextUrl: nextPageUrl(filters, events.nextCursor, options.limit),
        formatBeijingTime,
        pageError,
        rangeOptions: rangeOptions(config.retentionDays),
        systemStatus: systemStatus(config.detailsEnabled, geoData),
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

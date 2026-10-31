const express = require('express');
const { authenticatePage } = require('../middleware/auth');
const { getOverview } = require('./store');
const { listEvents, parseEventListQuery } = require('./query/analytics-query');
const { ASN_CREDIT } = require('./adapters/asn-resolver');
const { requestedNetwork } = require('../security/admin-api');

const DAY_MS = 24 * 60 * 60 * 1000;
const BAN_MESSAGES = {
  unbanned: { severity: 'info', text: '已解除封禁。' },
  missing: { severity: 'info', text: '该地址没有封禁记录。' },
  invalid: { severity: 'error', text: '地址格式无效。' }
};
const TRAFFIC_FILTER_LABELS = {
  confirmed: '仅真人',
  unconfirmed: '仅未确认',
  human: '仅浏览器类',
  bot: '仅爬虫'
};

const FILTER_NAMES = [
  'search', 'traffic', 'ip', 'country', 'subdivision', 'city', 'browser', 'os',
  'device', 'pathPrefix', 'referrerHost'
];
const ADVANCED_FILTERS = [
  ['ip', '完整 IP'],
  ['country', '国家代码'],
  ['subdivision', '一级行政区'],
  ['city', '城市'],
  ['browser', '浏览器'],
  ['os', '操作系统'],
  ['device', '设备类别'],
  ['pathPrefix', '路径前缀'],
  ['referrerHost', '来源域']
];
const FILTER_REMOVAL_DEPENDENCIES = {
  country: ['country', 'subdivision', 'city']
};
const SUPPORTED_QUERY_NAMES = new Set([...FILTER_NAMES, 'days', 'limit', 'cursor']);

function removedFilterNames(name) {
  return new Set(FILTER_REMOVAL_DEPENDENCIES[name] || (name ? [name] : []));
}

function filterViewModel(query, days) {
  const filters = { days: String(days) };
  for (const name of FILTER_NAMES) {
    filters[name] = typeof query[name] === 'string' ? query[name] : '';
  }
  if (!filters.traffic) filters.traffic = 'all';
  return filters;
}

function filterUrl(filters, limit, removedName = null, cursor = null, sourceQuery = null) {
  const params = new URLSearchParams();
  const removedNames = removedFilterNames(removedName);
  if (sourceQuery) {
    for (const [name, value] of Object.entries(sourceQuery)) {
      if (SUPPORTED_QUERY_NAMES.has(name)) continue;
      for (const entry of Array.isArray(value) ? value : [value]) {
        if (typeof entry === 'string') params.append(name, entry);
      }
    }
  }
  for (const [name, value] of Object.entries(filters)) {
    if (!removedNames.has(name) && value) params.set(name, value);
  }
  if (limit !== 50) params.set('limit', String(limit));
  if (cursor) params.set('cursor', cursor);
  return `/admin/analytics?${params.toString()}#event-list`;
}

function appliedFilters(filters, limit, sourceQuery = null) {
  const items = [];
  if (filters.search) items.push({ name: 'search', label: '搜索', value: filters.search });
  if (filters.traffic && filters.traffic !== 'all') {
    items.push({
      name: 'traffic',
      label: '访问类型',
      value: TRAFFIC_FILTER_LABELS[filters.traffic] || filters.traffic
    });
  }
  for (const [name, label] of ADVANCED_FILTERS) {
    if (filters[name]) items.push({ name, label, value: filters[name] });
  }
  return items.map(item => ({
    ...item,
    removeNames: [...removedFilterNames(item.name)],
    removeUrl: filterUrl(filters, limit, item.name, null, sourceQuery)
  }));
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

function banSection(ipBans, now, days, message) {
  if (!ipBans?.enabled) return null;
  return {
    ...ipBans.summary(new Date(now - days * DAY_MS).toISOString()),
    items: ipBans.list(20).bans,
    message: BAN_MESSAGES[message] || null
  };
}

// The admin cookie is SameSite=Strict; the browser's own fetch metadata is checked as well.
function sameOrigin(req, publicOrigin) {
  const site = req.get('sec-fetch-site');
  if (site) return site === 'same-origin';
  const origin = req.get('origin');
  return !origin || origin === publicOrigin || origin === `${req.protocol}://${req.get('host')}`;
}

function createAdminPageRouter({
  db,
  config,
  clock,
  geoResolver,
  asnResolver = null,
  ipBans = null,
  logger = console
}) {
  const router = express.Router();
  router.use('/admin/analytics', (req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
  });
  router.post(
    '/admin/analytics/ip-bans/unban',
    authenticatePage,
    express.urlencoded({ extended: false, limit: '2kb' }),
    (req, res) => {
      if (!ipBans?.enabled) return res.status(404).send('未启用探测封禁');
      if (!sameOrigin(req, config.publicOrigin)) return res.status(403).send('Forbidden');
      const network = requestedNetwork(req.body?.network);
      const result = !network ? 'invalid' : ipBans.unban(network) ? 'unbanned' : 'missing';
      const days = /^\d{1,3}$/.test(String(req.body?.days ?? '')) ? `days=${req.body.days}&` : '';
      return res.redirect(303, `/admin/analytics?${days}ipBan=${result}#ip-bans`);
    }
  );
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
      const filterItems = appliedFilters(filters, options.limit, req.query);
      return res.render('admin/analytics', {
        overview,
        events,
        filters,
        appliedFilters: filterItems,
        advancedFilterCount: ADVANCED_FILTERS.filter(([name]) => filters[name]).length,
        eventPreviousUrl: null,
        eventNextUrl: filterUrl(filters, options.limit, null, events.nextCursor),
        formatBeijingTime,
        pageError,
        analyticsEnhancementEnabled: !pageError && config.detailsEnabled,
        rangeOptions: rangeOptions(config.retentionDays),
        systemStatus: systemStatus(config.detailsEnabled, geoData),
        asnStatus: config.detailsEnabled && asnResolver ? asnResolver.getStatus() : null,
        asnCredit: ASN_CREDIT,
        ipBans: banSection(ipBans, clock.now(), options.days, req.query.ipBan),
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

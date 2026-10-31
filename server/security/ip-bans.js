const dns = require('node:dns').promises;
const net = require('node:net');
const { normalizeTrustedIp } = require('../analytics/request-security');

// Same ranges nginx trusts for CF-Connecting-IP (deploy/nginx/cloudflare-real-ip.conf). Requests
// from these addresses come from Cloudflare itself (Workers) on behalf of anyone.
const CLOUDFLARE_RANGES = [
  '173.245.48.0/20', '103.21.244.0/22', '103.22.200.0/22', '103.31.4.0/22',
  '141.101.64.0/18', '108.162.192.0/18', '190.93.240.0/20', '188.114.96.0/20',
  '197.234.240.0/22', '198.41.128.0/17', '162.158.0.0/15', '104.16.0.0/13',
  '104.24.0.0/14', '172.64.0.0/13', '131.0.72.0/22',
  '2400:cb00::/32', '2606:4700::/32', '2803:f800::/32', '2405:b500::/32',
  '2405:8100::/32', '2a06:98c0::/29', '2c0f:f248::/32'
];
const INTERNAL_RANGES = [
  '127.0.0.0/8', '10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16', '169.254.0.0/16',
  '100.64.0.0/10', '::1/128', 'fc00::/7', 'fe80::/10'
];

function blockList(ranges) {
  const list = new net.BlockList();
  for (const range of ranges) {
    const [address, prefix] = range.split('/');
    list.addSubnet(address, Number(prefix), net.isIPv6(address) ? 'ipv6' : 'ipv4');
  }
  return list;
}

const cloudflare = blockList(CLOUDFLARE_RANGES);
const internal = blockList(INTERNAL_RANGES);

function inList(list, ip) {
  return list.check(ip, net.isIPv6(ip) ? 'ipv6' : 'ipv4');
}

// Whole path segments that no page here has: secrets and VCS metadata, server-side scripts, and the
// admin paths of software this blog does not run.
const PROBE_SEGMENT = /^(\.env([._-].*)?|\.git|\.git-credentials|\.svn|\.hg|\.aws|\.ssh|\.docker|\.kube|\.htaccess|\.htpasswd|\.ds_store|\.npmrc|\.bash_history|.+\.(php\d?|phtml|aspx?|jsp|cgi)|wp-admin|wp-content|wp-includes|wp-json|phpmyadmin|cgi-bin|actuator|boaform|hnap1)$/i;

function isProbePath(requestPath) {
  let decoded = requestPath;
  try {
    decoded = decodeURIComponent(requestPath);
  } catch {
    // Malformed escapes are matched as sent.
  }
  return decoded.split('/').some(segment => PROBE_SEGMENT.test(segment));
}

function expandIpv6(ip) {
  let address = ip;
  if (address.includes('.')) {
    const index = address.lastIndexOf(':');
    const octets = address.slice(index + 1).split('.').map(Number);
    address = `${address.slice(0, index)}:${((octets[0] << 8) | octets[1]).toString(16)}:${((octets[2] << 8) | octets[3]).toString(16)}`;
  }
  const [head, tail] = address.split('::');
  const left = head ? head.split(':') : [];
  const right = tail ? tail.split(':') : [];
  const fill = tail === undefined ? [] : Array(8 - left.length - right.length).fill('0');
  return [...left, ...fill, ...right];
}

/** What a ban covers: the address for IPv4, the /64 for IPv6 (one host can use its whole prefix). */
function banNetwork(value) {
  const ip = normalizeTrustedIp(value);
  if (!ip) return null;
  if (net.isIPv4(ip)) return ip;
  const prefix = [...expandIpv6(ip).slice(0, 4), '0', '0', '0', '0'].join(':');
  return `${new net.SocketAddress({ address: prefix, family: 'ipv6' }).address}/64`;
}

// Crawlers whose operators document reverse-DNS verification. googleusercontent.com is left out:
// any Google Cloud VM resolves there.
const CRAWLERS = [
  { pattern: /Googlebot|Google-InspectionTool|GoogleOther|AdsBot-Google|Mediapartners-Google|Storebot-Google|APIs-Google/i, domains: ['googlebot.com', 'google.com'] },
  { pattern: /bingbot|BingPreview|msnbot|adidxbot/i, domains: ['search.msn.com'] },
  { pattern: /Applebot/i, domains: ['applebot.apple.com'] },
  { pattern: /YandexBot|YandexImages|YandexMobileBot/i, domains: ['yandex.ru', 'yandex.net', 'yandex.com'] },
  { pattern: /Baiduspider/i, domains: ['baidu.com', 'baidu.jp'] }
];
const DNS_TIMEOUT_MS = 3000;

function withTimeout(promise) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('dns_timeout')), DNS_TIMEOUT_MS);
      timer.unref?.();
    })
  ]).finally(() => clearTimeout(timer));
}

/**
 * @typedef {{
 *   reverse(ip: string): Promise<string[]>,
 *   lookup(host: string, options: { all: true }): Promise<Array<{ address: string }>>
 * }} Resolver
 */

/**
 * A crawler UA counts only when the IP's reverse name is the operator's and resolves back to it.
 *
 * @param {string} ip
 * @param {string | null} userAgent
 * @param {Resolver} [resolver]
 */
async function isVerifiedCrawler(ip, userAgent, resolver = dns) {
  const crawler = CRAWLERS.find(entry => entry.pattern.test(userAgent || ''));
  if (!crawler) return false;
  try {
    const names = await withTimeout(resolver.reverse(ip));
    for (const name of names) {
      const host = name.toLowerCase().replace(/\.$/, '');
      if (!crawler.domains.some(domain => host.endsWith(`.${domain}`))) continue;
      const addresses = await withTimeout(resolver.lookup(host, { all: true }));
      if (addresses.some(entry => normalizeTrustedIp(entry.address) === ip)) return true;
    }
  } catch {
    // Unresolvable names are not verified.
  }
  return false;
}

function initializeIpBans(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS ip_bans (
      network TEXT PRIMARY KEY,
      ip TEXT NOT NULL,
      method TEXT NOT NULL,
      path TEXT NOT NULL,
      status INTEGER NOT NULL,
      user_agent TEXT,
      country TEXT,
      hits INTEGER NOT NULL DEFAULT 0,
      last_hit_at TEXT,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_ip_bans_created ON ip_bans(created_at DESC);
  `);
}

function listIpBans(db, limit = 200) {
  const total = db.prepare('SELECT COUNT(*) AS total FROM ip_bans').get().total;
  const bans = db.prepare(`
    SELECT network, ip, method, path, status, user_agent AS userAgent, country, hits,
           last_hit_at AS lastHitAt, created_at AS createdAt
      FROM ip_bans ORDER BY created_at DESC, network LIMIT ?
  `).all(limit);
  return { total, bans };
}

/** Counts for the analytics page: all bans, bans made since `since`, and requests they refused. */
function summarizeIpBans(db, since) {
  return db.prepare(`
    SELECT COUNT(*) AS total,
           COUNT(CASE WHEN created_at >= ? THEN 1 END) AS recent,
           COALESCE(SUM(hits), 0) AS blockedRequests
      FROM ip_bans
  `).get(since);
}

function removeIpBan(db, network) {
  return db.prepare('DELETE FROM ip_bans WHERE network = ?').run(network).changes > 0;
}

const FLUSH_MS = 10_000;
const RELOAD_MS = 60_000;
const MAX_HIT_KEYS = 10_000;

function bounded(value, max) {
  const trimmed = typeof value === 'string' ? value.trim() : '';
  return trimmed ? trimmed.slice(0, max) : null;
}

/**
 * Bans for good a client that asks for a probe path and gets a 4xx; a page that exists never bans
 * anyone. Banned clients get 403 for everything. The list is kept in memory and in `ip_bans`.
 *
 * @param {{
 *   db: any,
 *   enabled?: boolean,
 *   internalIps?: readonly string[],
 *   isOwner?: (req: any) => boolean,
 *   resolver?: Resolver,
 *   now?: () => number,
 *   logger?: { log(message: string): void, error(message: string): void }
 * }} options
 */
function createIpBanGuard({
  db,
  enabled = true,
  internalIps = [],
  isOwner = () => false,
  resolver = dns,
  now = () => Date.now(),
  logger = console
}) {
  initializeIpBans(db);
  const allowed = new Set(internalIps);
  const selectNetworks = db.prepare('SELECT network FROM ip_bans');
  const insertBan = db.prepare(`
    INSERT OR IGNORE INTO ip_bans (network, ip, method, path, status, user_agent, country, created_at)
    VALUES (@network, @ip, @method, @path, @status, @userAgent, @country, @createdAt)
  `);
  const addHits = db.prepare(`
    UPDATE ip_bans SET hits = hits + @count, last_hit_at = max(coalesce(last_hit_at, ''), @at)
     WHERE network = @network
  `);
  const flushHits = db.transaction(rows => {
    for (const row of rows) addHits.run(row);
  });
  let banned = new Set();
  let hits = new Map();
  const pending = new Set();
  let timers = [];

  function reload() {
    try {
      banned = new Set(selectNetworks.all().map(row => row.network));
    } catch {
      logger.error('[ip-bans] reload failed');
    }
  }

  function flush() {
    if (!hits.size) return;
    const rows = [...hits].map(([network, hit]) => ({ network, ...hit }));
    hits = new Map();
    try {
      flushHits(rows);
    } catch {
      logger.error('[ip-bans] blocked request counts dropped');
    }
  }

  function countHit(network) {
    const at = new Date(now()).toISOString();
    const hit = hits.get(network);
    if (hit) {
      hit.count += 1;
      hit.at = at;
    } else if (hits.size < MAX_HIT_KEYS) {
      hits.set(network, { count: 1, at });
    }
  }

  async function ban(network, ip, request) {
    if (await isVerifiedCrawler(ip, request.userAgent, resolver)) return;
    if (banned.has(network)) return;
    banned.add(network);
    try {
      insertBan.run({
        network,
        ip,
        method: request.method.slice(0, 10),
        path: request.path.slice(0, 512) || '/',
        status: request.status,
        userAgent: request.userAgent,
        country: request.country,
        createdAt: new Date(now()).toISOString()
      });
      // No address in the log: IPs are only shown to the signed-in admin.
      logger.log(`[ip-bans] banned a client probing ${JSON.stringify(request.path.slice(0, 200))}`);
    } catch {
      logger.error('[ip-bans] ban not saved; enforced until restart');
    }
  }

  function observe(req, res, ip, network, method, requestPath) {
    if (res.statusCode < 400 || res.statusCode >= 500 || !isProbePath(requestPath)) return;
    if (!network || banned.has(network) || allowed.has(ip)) return;
    if (inList(internal, ip) || inList(cloudflare, ip) || isOwner(req)) return;
    const request = {
      method,
      path: requestPath,
      status: res.statusCode,
      userAgent: bounded(req.get('user-agent'), 512),
      country: /^[A-Z][A-Z0-9]$/.test(req.get('cf-ipcountry') || '') ? req.get('cf-ipcountry') : null
    };
    const task = ban(network, ip, request)
      .catch(() => logger.error('[ip-bans] probe seen but client not banned'))
      .finally(() => pending.delete(task));
    pending.add(task);
  }

  function middleware(req, res, next) {
    const ip = normalizeTrustedIp(req);
    const network = ip ? banNetwork(ip) : null;
    if (network && banned.has(network)) {
      countHit(network);
      res.set('Cache-Control', 'private, no-store');
      return res.status(403).type('text/plain').send('Forbidden');
    }
    // Routers rewrite the path on the way down; keep the one the client asked for.
    const { method, path: requestPath } = req;
    res.once('finish', () => observe(req, res, ip, network, method, requestPath));
    return next();
  }

  return Object.freeze({
    enabled,
    middleware: enabled ? middleware : (req, res, next) => next(),
    list: limit => listIpBans(db, limit),
    summary: since => summarizeIpBans(db, since),
    unban(network) {
      const removed = removeIpBan(db, network);
      banned.delete(network);
      hits.delete(network);
      return removed;
    },
    start() {
      if (!enabled || timers.length) return;
      reload();
      timers = [setInterval(flush, FLUSH_MS), setInterval(reload, RELOAD_MS)];
      for (const timer of timers) timer.unref?.();
    },
    async stop() {
      for (const timer of timers) clearInterval(timer);
      timers = [];
      await Promise.allSettled([...pending]);
      flush();
    },
    /** Resolves once every ban decision already started has been made. */
    async settled() {
      await Promise.allSettled([...pending]);
    },
    flush,
    reload
  });
}

module.exports = {
  banNetwork,
  createIpBanGuard,
  initializeIpBans,
  isProbePath,
  isVerifiedCrawler,
  listIpBans,
  removeIpBan,
  summarizeIpBans
};

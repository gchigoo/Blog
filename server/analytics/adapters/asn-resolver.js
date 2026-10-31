const fs = require('node:fs/promises');
const path = require('node:path');
const zlib = require('node:zlib');

const FILE = 'dbip-asn-lite.mmdb';
const MAX_DOWNLOAD_BYTES = 32 * 1024 * 1024;
const MAX_FILE_BYTES = 64 * 1024 * 1024;
const REFRESH_AFTER_MS = 32 * 24 * 60 * 60 * 1000;
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;

// DB-IP "IP to ASN Lite" (CC BY 4.0): pages that show its results must credit DB-IP.
const ASN_CREDIT = Object.freeze({ href: 'https://db-ip.com', label: 'IP Geolocation by DB-IP' });

// Cloud, hosting, CDN and VPS networks. A person browsing from one is usually behind a VPN or
// proxy; most unconfirmed browser-like traffic from one is a script.
const HOSTING_ASNS = new Set([
  7224, 8987, 14618, 16509, 38895, 15169, 19527, 396982, 8075, 8068, 14061, 63949, 20473, 24940,
  213230, 16276, 51167, 45102, 37963, 132203, 45090, 55990, 136907, 31898, 12876, 13335, 54113,
  9009, 60068, 212238, 36352, 46606, 25820, 35916, 53667, 21859, 40065, 32934
]);
const HOSTING_NAMES = /\b(amazon|aws|azure|digitalocean|linode|akamai|vultr|choopa|hetzner|ovh|contabo|alibaba|aliyun|tencent|huawei cloud|oracle|scaleway|cloudflare|fastly|m247|datacamp|cdn77|colocrossing|leaseweb|hostinger|ionos|godaddy|dreamhost|hosting|hosted|servers?|data ?cent(er|re)s?|datacenter|cloud|vps|colo|zenlayer|psychz|quadranet|racknerd|buyvm|frantech|kamatera|upcloud|g-?core|stark industries|aeza|it7|dmit)\b/i;

function networkKind(asn, organization) {
  if (!Number.isInteger(asn)) return null;
  return HOSTING_ASNS.has(asn) || (organization && HOSTING_NAMES.test(organization)) ? 'hosting' : 'isp';
}

function monthUrl(date) {
  const month = `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
  return `https://download.db-ip.com/free/dbip-asn-lite-${month}.mmdb.gz`;
}

// The geoip2 reader keeps its metadata on the wrapped mmdb reader.
function buildDate(reader) {
  const built = (reader.metadata || reader.mmdbReader?.metadata)?.buildEpoch;
  return built instanceof Date ? built.toISOString() : null;
}

async function defaultOpenBuffer(buffer) {
  const { Reader } = await import('@maxmind/geoip2-node');
  return Reader.openBuffer(buffer);
}

function disabledAsnResolver() {
  return Object.freeze({
    async start() {},
    stop() {},
    lookup() { return null; },
    getStatus() { return { enabled: false, datasetDate: null, lastRefresh: null }; }
  });
}

/**
 * The autonomous system and network kind of an IP, from a monthly DB-IP file kept in `directory`.
 * Lookups answer null until a file is loaded; the download runs in the background.
 */
function createAsnResolver({
  directory,
  clock = { now: () => Date.now() },
  logger = console,
  fetchImpl = (url, options) => fetch(url, options),
  openBuffer = defaultOpenBuffer,
  scheduler = { setInterval, clearInterval }
}) {
  if (!directory) return disabledAsnResolver();
  const file = path.join(directory, FILE);
  let reader = null;
  let datasetDate = null;
  let lastRefresh = null;
  let refreshing = null;
  let timer = null;

  async function open(buffer) {
    const candidate = await openBuffer(buffer);
    // A truncated or wrong file fails here instead of answering lookups with nonsense.
    if (candidate.asn('8.8.8.8').autonomousSystemNumber !== 15169) throw new Error('asn_db_invalid');
    return { candidate, built: buildDate(candidate) };
  }

  async function use(buffer) {
    const opened = await open(buffer);
    reader = opened.candidate;
    datasetDate = opened.built;
  }

  async function load() {
    try {
      await use(await fs.readFile(file));
    } catch {
      // Missing or unreadable; the refresh downloads a new one.
    }
  }

  async function refresh() {
    const now = new Date(clock.now());
    const age = await fs.stat(file).then(info => now.getTime() - info.mtimeMs, () => Infinity);
    if (age < REFRESH_AFTER_MS) {
      if (!reader) await load();
      return 'fresh';
    }
    const previous = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
    for (const url of [monthUrl(now), monthUrl(previous)]) {
      try {
        const response = await fetchImpl(url, { signal: AbortSignal.timeout(60_000) });
        if (!response.ok) continue;
        const body = Buffer.from(await response.arrayBuffer());
        if (body.byteLength > MAX_DOWNLOAD_BYTES) continue;
        const buffer = zlib.gunzipSync(body, { maxOutputLength: MAX_FILE_BYTES });
        await open(buffer);
        await fs.mkdir(directory, { recursive: true });
        await fs.writeFile(`${file}.tmp`, buffer, { mode: 0o644 });
        await fs.rename(`${file}.tmp`, file);
        await use(buffer);
        return 'updated';
      } catch {
        // Try the previous month; DB-IP publishes early in the month.
      }
    }
    if (!reader) await load();
    logger.error('[analytics] ASN database download failed');
    return 'failed';
  }

  function refreshIfStale() {
    refreshing ??= refresh()
      .then(result => {
        lastRefresh = { at: new Date(clock.now()).toISOString(), result };
        return result;
      })
      .finally(() => { refreshing = null; });
    return refreshing;
  }

  return Object.freeze({
    async start() {
      await load();
      refreshIfStale().catch(() => {});
      timer = scheduler.setInterval(() => refreshIfStale().catch(() => {}), CHECK_INTERVAL_MS);
      timer?.unref?.();
    },
    stop() {
      if (timer) scheduler.clearInterval(timer);
      timer = null;
    },
    refreshIfStale,
    lookup(ip) {
      if (!ip || !reader) return null;
      try {
        const found = reader.asn(ip);
        const asn = found.autonomousSystemNumber;
        if (!Number.isInteger(asn)) return null;
        const organization = found.autonomousSystemOrganization?.slice(0, 200) || null;
        return { asn, organization, kind: networkKind(asn, organization) };
      } catch {
        return null;
      }
    },
    getStatus() {
      return { enabled: true, datasetDate, lastRefresh: lastRefresh && { ...lastRefresh } };
    }
  });
}

module.exports = { ASN_CREDIT, createAsnResolver, disabledAsnResolver, networkKind };

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const zlib = require('node:zlib');
const Database = require('better-sqlite3');
const { createAsnResolver, networkKind } = require('../server/analytics/adapters/asn-resolver');
const { createAnalyticsMiddleware } = require('../server/analytics/middleware');
const { initializeAnalytics } = require('../server/analytics/store');

const NOW = Date.parse('2026-10-31T08:00:00.000Z');
const quietLogger = { log() {}, error() {} };
const noTimers = { setInterval: () => null, clearInterval() {} };

// A stand-in for the mmdb reader: the "database" is a JSON map of IP to network.
function fakeOpenBuffer(buffer) {
  const networks = JSON.parse(buffer.toString('utf8'));
  return {
    metadata: { buildEpoch: new Date('2026-10-01T00:00:00.000Z') },
    asn(ip) {
      const found = networks[ip];
      if (!found) throw Object.assign(new Error('not found'), { name: 'AddressNotFoundError' });
      return { autonomousSystemNumber: found.asn, autonomousSystemOrganization: found.org };
    }
  };
}

const VALID = {
  '8.8.8.8': { asn: 15169, org: 'Google LLC' },
  '203.0.113.5': { asn: 4134, org: 'Chinanet' },
  '198.51.100.9': { asn: 64512, org: 'Example Cloud Hosting Ltd' }
};

function gzipped(networks) {
  return zlib.gzipSync(Buffer.from(JSON.stringify(networks)));
}

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'blog-asn-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function fakeFetch(responses) {
  const urls = [];
  const fetchImpl = async url => {
    urls.push(url);
    const body = responses[url];
    if (!body) return { ok: false, status: 404, arrayBuffer: async () => new ArrayBuffer(0) };
    return { ok: true, status: 200, arrayBuffer: async () => body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength) };
  };
  return { fetchImpl, urls };
}

function resolver(directory, fetchImpl) {
  return createAsnResolver({
    directory,
    clock: { now: () => NOW },
    logger: quietLogger,
    fetchImpl,
    openBuffer: fakeOpenBuffer,
    scheduler: noTimers
  });
}

const OCTOBER = 'https://download.db-ip.com/free/dbip-asn-lite-2026-10.mmdb.gz';
const SEPTEMBER = 'https://download.db-ip.com/free/dbip-asn-lite-2026-09.mmdb.gz';

test('network kind marks cloud and hosting networks by number or name', () => {
  assert.equal(networkKind(14061, 'DigitalOcean, LLC'), 'hosting');
  assert.equal(networkKind(64512, 'Example Cloud Hosting Ltd'), 'hosting');
  assert.equal(networkKind(36352, 'HostPapa'), 'hosting');
  assert.equal(networkKind(4134, 'Chinanet'), 'isp');
  assert.equal(networkKind(4134, null), 'isp');
  assert.equal(networkKind(null, 'Hetzner'), null);
});

test('without a directory the resolver knows nothing and downloads nothing', async () => {
  const { fetchImpl, urls } = fakeFetch({});
  const disabled = resolver(null, fetchImpl);
  await disabled.start();
  assert.equal(disabled.lookup('203.0.113.5'), null);
  assert.deepEqual(disabled.getStatus(), { enabled: false, datasetDate: null, lastRefresh: null });
  disabled.stop();
  assert.deepEqual(urls, []);
});

test('a missing database is downloaded, checked, saved and used', async t => {
  const dir = tempDir(t);
  const { fetchImpl, urls } = fakeFetch({ [OCTOBER]: gzipped(VALID) });
  const asn = resolver(dir, fetchImpl);
  await asn.start();
  assert.equal(await asn.refreshIfStale(), 'updated');
  assert.deepEqual(urls, [OCTOBER]);
  assert.ok(fs.existsSync(path.join(dir, 'dbip-asn-lite.mmdb')));
  assert.deepEqual(asn.lookup('203.0.113.5'), { asn: 4134, organization: 'Chinanet', kind: 'isp' });
  assert.deepEqual(asn.lookup('198.51.100.9'), { asn: 64512, organization: 'Example Cloud Hosting Ltd', kind: 'hosting' });
  assert.equal(asn.lookup('10.0.0.1'), null);
  assert.equal(asn.lookup(null), null);
  assert.deepEqual(asn.getStatus(), {
    enabled: true,
    datasetDate: '2026-10-01T00:00:00.000Z',
    lastRefresh: { at: '2026-10-31T08:00:00.000Z', result: 'updated' }
  });
  asn.stop();

  // A restart within the month uses the saved file and downloads nothing.
  const again = fakeFetch({});
  const restarted = resolver(dir, again.fetchImpl);
  await restarted.start();
  assert.equal(await restarted.refreshIfStale(), 'fresh');
  assert.deepEqual(again.urls, []);
  assert.equal(restarted.lookup('203.0.113.5').asn, 4134);
  restarted.stop();
});

test('before this month is published, last month is downloaded', async t => {
  const dir = tempDir(t);
  const { fetchImpl, urls } = fakeFetch({ [SEPTEMBER]: gzipped(VALID) });
  const asn = resolver(dir, fetchImpl);
  await asn.start();
  assert.equal(await asn.refreshIfStale(), 'updated');
  assert.deepEqual(urls, [OCTOBER, SEPTEMBER]);
  assert.equal(asn.lookup('203.0.113.5').asn, 4134);
  asn.stop();
});

test('a file that does not answer the known lookup is never saved or used', async t => {
  const dir = tempDir(t);
  const wrong = { '8.8.8.8': { asn: 1, org: 'Wrong' }, '203.0.113.5': { asn: 4134, org: 'Chinanet' } };
  const { fetchImpl } = fakeFetch({ [OCTOBER]: gzipped(wrong), [SEPTEMBER]: Buffer.from('not gzip') });
  const asn = resolver(dir, fetchImpl);
  await asn.start();
  assert.equal(await asn.refreshIfStale(), 'failed');
  assert.equal(fs.existsSync(path.join(dir, 'dbip-asn-lite.mmdb')), false);
  assert.equal(asn.lookup('203.0.113.5'), null);
  assert.equal(asn.getStatus().lastRefresh.result, 'failed');
  asn.stop();
});

test('the collector stores the network of each detailed visit', () => {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  initializeAnalytics(db);
  const middleware = createAnalyticsMiddleware({
    db,
    secret: 'test-secret',
    now: () => NOW,
    detailsEnabled: true,
    publicOrigin: 'https://blog.example.com',
    geoResolver: { resolve: () => ({ status: 'not_found', data: null }), getStatus: () => ({ reader: null }) },
    asnResolver: {
      lookup: ip => ip === '198.51.100.9' ? { asn: 64512, organization: 'Example Cloud Hosting Ltd', kind: 'hosting' } : null
    },
    clientParser: { parse: () => ({ status: 'parsed', data: {} }) },
    tokenSigner: { createEventId: () => 'a'.repeat(32), sign: () => 'token' },
    logger: quietLogger
  });
  const visit = ip => {
    const listeners = {};
    const res = {
      statusCode: 200,
      locals: {},
      getHeader: name => (name === 'content-type' ? 'text/html; charset=utf-8' : undefined),
      on: (event, listener) => { listeners[event] = listener; }
    };
    const req = {
      method: 'GET',
      path: '/about',
      originalUrl: '/about',
      ip,
      socket: { remoteAddress: ip },
      headers: { 'user-agent': 'Mozilla/5.0', accept: 'text/html' },
      get(name) { return this.headers[name.toLowerCase()]; }
    };
    middleware(req, res, () => {});
    listeners.finish();
  };
  visit('198.51.100.9');
  const row = db.prepare('SELECT asn, as_org AS org, network_kind AS kind FROM access_event_details').get();
  assert.deepEqual({ ...row }, { asn: 64512, org: 'Example Cloud Hosting Ltd', kind: 'hosting' });
});

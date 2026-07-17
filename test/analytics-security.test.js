const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  captureRequestClient,
  normalizeTrustedIp,
  sanitizePublicRequestUrl,
  sanitizeReferrer
} = require('../server/analytics/request-security');
const { createClientParser } = require('../server/analytics/adapters/client-parser');
const { createGeoResolver } = require('../server/analytics/adapters/geo-resolver');
const { createEventTokenSigner } = require('../server/analytics/event-token');
const { validateClientContext } = require('../server/analytics/context-validator');
const { BoundedFixedWindowLimiter, BoundedTokenBucketLimiter } = require('../server/analytics/rate-limiter');

const VALID_SECRET = Buffer.alloc(32, 7);
const FIXED_TOKEN = 'v1.eyJ2IjoxLCJhdWQiOiJhbmFseXRpY3MtY2xpZW50LWNvbnRleHQiLCJldmVudElkIjoiMDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWYiLCJpYXQiOjE3ODQyNDY0MDAsImV4cCI6MTc4NDI0NzAwMH0.EIrqIKi5bIrN4DsbEYqYBIhdAAwSG8-OmvVPRvgYZSs';

function geoReader(version) {
  return {
    metadata: {
      databaseType: 'GeoLite2-City',
      buildEpoch: new Date((1784246400 + version * 86400) * 1000)
    },
    city() {
      return { country: { isoCode: `V${version}`, names: { en: `Version ${version}` } } };
    }
  };
}

test('request capture trusts req.ip and redacts credentials without unsafe fallback', () => {
  assert.equal(normalizeTrustedIp({ ip: '::ffff:203.0.113.7', headers: { 'x-forwarded-for': '198.51.100.9' } }), '203.0.113.7');

  const request = sanitizePublicRequestUrl(
    '/article/example?code=SECRET&ok=hello&STATE=STATE',
    'https://blog.example.com'
  );
  assert.equal(request.requestPath, '/article/example');
  assert.doesNotMatch(request.queryString, /SECRET|=STATE(?:&|$)/);
  assert.match(request.queryString, /code=%5BREDACTED%5D/);
  assert.equal(request.fullUrl, `https://blog.example.com/article/example?${request.queryString}`);

  const invalid = sanitizePublicRequestUrl('/tag/%E5%B7%A5%E5%85%B7?q=%E5%A', 'https://blog.example.com');
  assert.deepEqual(invalid, {
    requestPath: '/tag/%E5%B7%A5%E5%85%B7',
    queryString: null,
    fullUrl: 'https://blog.example.com/tag/%E5%B7%A5%E5%85%B7',
    status: 'invalid_query_redacted'
  });

  const referrer = sanitizeReferrer('https://user:pass@example.com/from?token=SECRET&x=1');
  assert.equal(referrer.host, 'example.com');
  assert.doesNotMatch(referrer.value, /user|pass|SECRET/);
  assert.equal(sanitizeReferrer('javascript:alert(1)').value, null);

  const captured = captureRequestClient({
    get(name) {
      return {
        'user-agent': 'Mozilla/5.0',
        'accept-language': 'zh-CN',
        'sec-ch-ua': '"Chromium";v="126"',
        cookie: 'private-cookie',
        authorization: 'Bearer private-token'
      }[name.toLowerCase()];
    }
  });
  assert.equal(captured.userAgent, 'Mozilla/5.0');
  assert.equal(captured.acceptLanguage, 'zh-CN');
  assert.deepEqual(Object.keys(captured.clientHints), ['sec-ch-ua']);
  assert.doesNotMatch(JSON.stringify(captured), /private-cookie|private-token/);
});

test('Bowser adapter returns parsed, unknown, and error tagged results', () => {
  const parser = createClientParser();
  const parsed = parser.parse('Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/112.0.0.0 Mobile Safari/537.36');
  assert.equal(parsed.status, 'parsed');
  assert.equal(parsed.data.browserName, 'Chrome');
  assert.equal(parsed.data.browserVersion, '112.0.0.0');
  assert.equal(parsed.data.osName, 'Android');
  assert.equal(parsed.data.deviceType, 'mobile');
  assert.equal(parsed.data.deviceVendor, null);
  assert.equal(parsed.data.deviceModel, null);
  assert.equal(parser.parse('').status, 'unknown');

  const mapped = createClientParser({
    parse() {
      return {
        browser: { name: 'Fixture', version: '1' },
        os: {}, engine: {},
        platform: { type: 'tablet', vendor: 'Fixture Vendor', model: 'Fixture Model', architecture: 'arm64' }
      };
    }
  }).parse('fixture');
  assert.equal(mapped.data.deviceVendor, 'Fixture Vendor');
  assert.equal(mapped.data.deviceModel, 'Fixture Model');
  assert.equal(mapped.data.cpuArchitecture, 'arm64');

  const failing = createClientParser({ parse() { throw new Error('UA SECRET'); } });
  assert.deepEqual(failing.parse('secret-user-agent'), {
    status: 'error', data: null, errorCategory: 'parse_failed'
  });
});

test('event tokens use the fixed v1 HKDF/HMAC contract and stable expiry errors', () => {
  const signer = createEventTokenSigner({ secret: VALID_SECRET });
  const eventId = '0123456789abcdef0123456789abcdef';
  const token = signer.sign(eventId, 1784246400 * 1000);
  assert.equal(token, FIXED_TOKEN);
  assert.deepEqual(signer.verify(token, 1784246500 * 1000), {
    status: 'valid',
    claims: { v: 1, aud: 'analytics-client-context', eventId, iat: 1784246400, exp: 1784247000 }
  });
  assert.equal(signer.verify(`${token.slice(0, -1)}x`, 1784246500 * 1000).status, 'invalid');
  assert.equal(signer.verify(token, 1784247000 * 1000).status, 'expired');
});

test('client context validation is canonical, bounded, and rejects unknown or dangerous keys', () => {
  const first = validateClientContext({ context: {
    languages: ['zh-CN', 'en-US'],
    timezone: 'Asia/Shanghai',
    screen: { width: 1920, height: 1080, availWidth: 1920, availHeight: 1040, colorDepth: 24, pixelDepth: 24 },
    viewport: { width: 1280, height: 720 },
    devicePixelRatio: 1.5,
    hardwareConcurrency: 12,
    deviceMemory: 16,
    maxTouchPoints: 0,
    network: { effectiveType: '4g', downlink: 10.5, rtt: 50, saveData: false }
  } });
  const second = validateClientContext({ context: {
    network: { saveData: false, rtt: 50, downlink: 10.5, effectiveType: '4g' },
    maxTouchPoints: 0,
    deviceMemory: 16,
    hardwareConcurrency: 12,
    devicePixelRatio: 1.5,
    viewport: { height: 720, width: 1280 },
    screen: { pixelDepth: 24, colorDepth: 24, availHeight: 1040, availWidth: 1920, height: 1080, width: 1920 },
    timezone: 'Asia/Shanghai',
    languages: ['zh-CN', 'en-US']
  } });
  assert.equal(first.hash, second.hash);
  assert.equal(first.canonical, second.canonical);

  for (const body of [
    { context: { unknown: true } },
    { context: { screen: { width: Infinity } } },
    { context: { viewport: { width: -1, height: 1 } } },
    JSON.parse('{"context":{"constructor":"x"}}')
  ]) {
    assert.throws(() => validateClientContext(body), /invalid_context/);
  }
});

test('bounded rate limiters expire entries and fail closed at capacity', () => {
  let now = 1_000;
  const bucket = new BoundedTokenBucketLimiter({
    capacity: 2,
    refillTokens: 1,
    refillIntervalMs: 1_000,
    idleTtlMs: 2_000,
    maxEntries: 1,
    now: () => now
  });
  assert.equal(bucket.consume('ip-1').allowed, true);
  assert.equal(bucket.consume('ip-1').allowed, true);
  assert.equal(bucket.consume('ip-1').allowed, false);
  assert.equal(bucket.consume('ip-2').allowed, false);
  now += 2_001;
  assert.equal(bucket.consume('ip-2').allowed, true);

  const fixed = new BoundedFixedWindowLimiter({ limit: 2, windowMs: 10_000, maxEntries: 2, now: () => now });
  assert.equal(fixed.consume('event').allowed, true);
  assert.equal(fixed.consume('event').allowed, true);
  assert.equal(fixed.consume('event').allowed, false);
  now += 10_001;
  assert.equal(fixed.consume('event').allowed, true);
});

test('GeoResolver validates City metadata, returns tagged results, and keeps the old reader on reload failure', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'analytics-geo-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const databasePath = path.join(root, 'GeoLite2-City.mmdb');
  const statusPath = path.join(root, 'update-status.json');
  await fs.writeFile(databasePath, 'valid-v1');
  await fs.writeFile(statusPath, JSON.stringify({
    lastAttemptAt: '2026-07-17T00:00:00.000Z',
    lastSuccessAt: '2026-07-17T00:00:00.000Z',
    result: 'bootstrap',
    errorCategory: null,
    datasetEpoch: 1784246400
  }));

  let poll = null;
  let reloadErrors = 0;
  const scheduler = {
    setInterval(callback) { poll = callback; return { unref() {} }; },
    clearInterval() {}
  };
  const resolver = createGeoResolver({
    databasePath,
    statusPath,
    clock: { now: () => Date.parse('2026-07-17T00:00:00.000Z') },
    scheduler,
    logger: { error() { reloadErrors += 1; }, info() {} },
    openBuffer(buffer) {
      if (buffer.toString() === 'broken-v2') throw new Error('invalid database');
      return {
        metadata: { databaseType: 'GeoLite2-City', buildEpoch: new Date(1784246400 * 1000) },
        city() {
          return {
            continent: { code: 'AS', names: { en: 'Asia' } },
            country: { isoCode: 'CN', names: { en: 'China' } },
            subdivisions: [{ isoCode: 'BJ', names: { en: 'Beijing' } }],
            city: { names: { en: 'Beijing' } },
            postal: { code: '100000' },
            location: { timeZone: 'Asia/Shanghai', latitude: 39.9, longitude: 116.4, accuracyRadius: 20 }
          };
        }
      };
    }
  });

  await resolver.start();
  const resolved = resolver.resolve('203.0.113.10');
  assert.equal(resolved.status, 'resolved');
  assert.equal(resolved.data.countryCode, 'CN');
  assert.equal(resolved.data.cityName, 'Beijing');
  assert.equal(resolver.resolve('127.0.0.1').status, 'private');
  assert.equal(resolver.getStatus().updater.result, 'bootstrap');

  await fs.writeFile(statusPath, JSON.stringify({
    lastAttemptAt: '2026-07-17T00:00:00.000Z', lastSuccessAt: null,
    result: 'failed', errorCategory: 'not_allowlisted', datasetEpoch: 1784246400
  }));
  await poll();
  assert.equal(resolver.getStatus().updater.state, 'corrupt');

  await fs.writeFile(databasePath, 'broken-v2');
  await poll();
  assert.equal(resolver.resolve('203.0.113.10').status, 'resolved');
  assert.equal(resolver.getStatus().reader.reloadStatus, 'failed');
  await poll();
  assert.equal(reloadErrors, 1);
  resolver.stop();
});

test('GeoResolver binds MMDB bytes and fingerprint to the same file handle across atomic replacement', async () => {
  const databasePath = '/fixture/GeoLite2-City.mmdb';
  const statusPath = '/fixture/update-status.json';
  const statusRaw = JSON.stringify({
    lastAttemptAt: '2026-07-17T00:00:00.000Z',
    lastSuccessAt: '2026-07-17T00:00:00.000Z',
    result: 'updated', errorCategory: null, datasetEpoch: 1784246400
  });
  let pathVersion = 1;
  let poll;
  const statFor = version => ({ dev: 7, ino: version, size: version, mtimeMs: version });
  const fileSystem = {
    async open(target) {
      assert.equal(target, databasePath);
      const handleVersion = pathVersion;
      return {
        async stat() { return statFor(handleVersion); },
        async readFile() {
          // Simulate atomic replacement while the already-open v2 handle is read.
          if (handleVersion === 2) pathVersion = 3;
          return Buffer.from(`v${handleVersion}`);
        },
        async close() {}
      };
    },
    async stat(target) {
      assert.equal(target, databasePath);
      return statFor(pathVersion);
    },
    async lstat(target) {
      assert.equal(target, statusPath);
      return { size: Buffer.byteLength(statusRaw), isFile: () => true, isSymbolicLink: () => false };
    },
    async readFile(target) {
      assert.equal(target, statusPath, 'database reads must use the opened file handle');
      return statusRaw;
    }
  };
  const resolver = createGeoResolver({
    databasePath, statusPath, fileSystem,
    scheduler: { setInterval(callback) { poll = callback; return {}; }, clearInterval() {} },
    clock: { now: () => Date.parse('2026-07-17T00:00:00.000Z') },
    logger: { error() {} },
    openBuffer(buffer) { return geoReader(Number(buffer.toString().slice(1))); }
  });

  await resolver.start();
  assert.equal(resolver.resolve('8.8.8.8').data.countryName, 'Version 1');
  pathVersion = 2;
  await poll();
  assert.equal(resolver.resolve('8.8.8.8').data.countryName, 'Version 2');
  assert.match(resolver.getStatus().reader.fingerprint, /^7:2:/);
  await poll();
  assert.equal(resolver.resolve('8.8.8.8').data.countryName, 'Version 3');
  assert.match(resolver.getStatus().reader.fingerprint, /^7:3:/);
  resolver.stop();
});

test('GeoResolver stop prevents an in-flight poll from restoring an active reader', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'analytics-geo-stop-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const databasePath = path.join(root, 'GeoLite2-City.mmdb');
  const statusPath = path.join(root, 'update-status.json');
  await fs.writeFile(databasePath, 'v1');
  await fs.writeFile(statusPath, JSON.stringify({
    lastAttemptAt: null, lastSuccessAt: null, result: 'no-op', errorCategory: null, datasetEpoch: 1784246400
  }));
  let poll;
  let releaseCandidate;
  let candidateStarted;
  const candidateReady = new Promise(resolve => { candidateStarted = resolve; });
  const resolver = createGeoResolver({
    databasePath, statusPath,
    scheduler: { setInterval(callback) { poll = callback; return {}; }, clearInterval() {} },
    logger: { error() {} },
    openBuffer(buffer) {
      if (buffer.toString() === 'v2-is-delayed') {
        candidateStarted();
        return new Promise(resolve => { releaseCandidate = () => resolve(geoReader(2)); });
      }
      return geoReader(1);
    }
  });

  await resolver.start();
  await fs.writeFile(databasePath, 'v2-is-delayed');
  const pendingPoll = poll();
  await candidateReady;
  resolver.stop();
  releaseCandidate();
  await pendingPoll;
  assert.equal(resolver.getStatus().reader, null);
  assert.deepEqual(resolver.resolve('8.8.8.8'), {
    status: 'lookup_error', data: null, errorCategory: 'reader_unavailable'
  });
});

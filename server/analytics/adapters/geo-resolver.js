const fs = require('node:fs/promises');
const net = require('node:net');

const POLL_INTERVAL_MS = 60_000;
const FAILURE_RETRY_MS = 5 * 60_000;
const STALE_AFTER_MS = 14 * 24 * 60 * 60 * 1000;
const STATUS_MAX_BYTES = 4096;
const STATUS_RESULTS = new Set(['bootstrap', 'updated', 'no-op', 'failed']);
const STATUS_ERROR_CATEGORIES = new Set([
  'unexpected_error', 'config_unreadable', 'verifier_unreadable', 'config_invalid',
  'config_permissions', 'wrapper_invalid', 'wrapper_permissions', 'invalid_arguments',
  'previous_missing', 'previous_verification_failed', 'download_failed',
  'candidate_missing_or_ambiguous', 'candidate_verification_failed', 'live_invalid',
  'live_verification_failed', 'prepare_previous_failed', 'promote_live_failed',
  'bootstrap_after_promote_failed'
]);

function privateIp(ip) {
  if (net.isIP(ip) === 4) {
    const [a, b] = ip.split('.').map(Number);
    return a === 0 || a === 10 || a === 127
      || (a === 100 && b >= 64 && b <= 127)
      || (a === 169 && b === 254)
      || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && b === 168)
      || (a === 198 && (b === 18 || b === 19));
  }
  if (net.isIP(ip) === 6) {
    const value = ip.toLowerCase();
    return value === '::' || value === '::1' || value.startsWith('fc') || value.startsWith('fd')
      || /^fe[89ab]/.test(value);
  }
  return false;
}

function fingerprint(stat) {
  return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}`;
}

function readerMetadata(reader) {
  return reader.metadata || reader.mmdbReader?.metadata || null;
}

function validateReader(reader) {
  const metadata = readerMetadata(reader);
  if (!metadata || !String(metadata.databaseType).includes('City')) {
    throw new Error('not_city_database');
  }
  const buildDate = metadata.buildEpoch instanceof Date
    ? metadata.buildEpoch
    : new Date(Number(metadata.buildEpoch) * 1000);
  if (!Number.isFinite(buildDate.getTime()) || buildDate.getTime() <= 0) {
    throw new Error('invalid_build_epoch');
  }
  reader.city('1.1.1.1');
  return Math.floor(buildDate.getTime() / 1000);
}

function strictTimestamp(value) {
  if (value === null) return null;
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value)) {
    throw new Error('invalid_status_timestamp');
  }
  if (!Number.isFinite(Date.parse(value))) throw new Error('invalid_status_timestamp');
  return value;
}

function parseStatus(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid_status');
  const allowed = new Set(['lastAttemptAt', 'lastSuccessAt', 'result', 'errorCategory', 'datasetEpoch']);
  if (Object.keys(value).some(key => !allowed.has(key))) throw new Error('invalid_status');
  if (!STATUS_RESULTS.has(value.result)) throw new Error('invalid_status_result');
  if (value.result === 'failed') {
    if (!STATUS_ERROR_CATEGORIES.has(value.errorCategory)) throw new Error('invalid_status_error');
  } else if (value.errorCategory !== null) throw new Error('invalid_status_error');
  if (value.datasetEpoch !== null
    && (!Number.isInteger(value.datasetEpoch) || value.datasetEpoch <= 0 || value.datasetEpoch > 4102444800)) {
    throw new Error('invalid_status_epoch');
  }
  return {
    state: 'ok',
    lastAttemptAt: strictTimestamp(value.lastAttemptAt),
    lastSuccessAt: strictTimestamp(value.lastSuccessAt),
    result: value.result,
    errorCategory: value.errorCategory,
    datasetEpoch: value.datasetEpoch
  };
}

function statusFallback(state) {
  return {
    state,
    lastAttemptAt: null,
    lastSuccessAt: null,
    result: 'unknown',
    errorCategory: null,
    datasetEpoch: null
  };
}

function mapCity(response) {
  const subdivision = response.subdivisions?.[0] || null;
  return {
    continentCode: response.continent?.code || null,
    continentName: response.continent?.names?.en || null,
    countryCode: response.country?.isoCode || null,
    countryName: response.country?.names?.en || null,
    subdivisionCode: subdivision?.isoCode || null,
    subdivisionName: subdivision?.names?.en || null,
    cityName: response.city?.names?.en || null,
    postalCode: response.postal?.code || null,
    timezone: response.location?.timeZone || null,
    latitude: response.location?.latitude ?? null,
    longitude: response.location?.longitude ?? null,
    accuracyRadiusKm: response.location?.accuracyRadius ?? null
  };
}

function createGeoResolver({
  databasePath,
  statusPath,
  clock = { now: () => Date.now() },
  logger = console,
  scheduler = { setInterval, clearInterval },
  fileSystem = fs,
  openBuffer
}) {
  let current = null;
  let updater = statusFallback('missing');
  let timer = null;
  let inFlight = null;
  let started = false;
  let generation = 0;
  let failedFingerprint = null;
  let failedAt = 0;

  async function readerFromBuffer(buffer) {
    if (openBuffer) return openBuffer(buffer);
    const { Reader } = await import('@maxmind/geoip2-node');
    return Reader.openBuffer(buffer);
  }

  async function loadCandidate() {
    const handle = await fileSystem.open(databasePath, 'r');
    try {
      // Metadata and bytes must come from the same inode. A path-level stat/read
      // pair can straddle the updater's atomic rename and mislabel an old reader.
      const [stat, buffer] = await Promise.all([handle.stat(), handle.readFile()]);
      const reader = await readerFromBuffer(buffer);
      const datasetEpoch = validateReader(reader);
      return {
        reader,
        fingerprint: fingerprint(stat),
        datasetEpoch,
        datasetDate: new Date(datasetEpoch * 1000).toISOString(),
        lastReloadAt: new Date(clock.now()).toISOString(),
        reloadStatus: 'ok'
      };
    } finally {
      await handle.close();
    }
  }

  async function readUpdaterStatus() {
    try {
      const stat = await fileSystem.lstat(statusPath);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > STATUS_MAX_BYTES) {
        return statusFallback('corrupt');
      }
      const raw = await fileSystem.readFile(statusPath, 'utf8');
      if (Buffer.byteLength(raw) > STATUS_MAX_BYTES) throw new Error('status_too_large');
      return parseStatus(JSON.parse(raw));
    } catch (error) {
      if (error?.code === 'ENOENT') return statusFallback('missing');
      else if (error instanceof SyntaxError || /^invalid_status|^status_too_large/.test(error?.message || '')) {
        return statusFallback('corrupt');
      }
      return statusFallback('unreadable');
    }
  }

  async function poll() {
    if (!started) return;
    if (inFlight) return inFlight;
    const pollGeneration = generation;
    const operation = (async () => {
      const nextUpdater = await readUpdaterStatus();
      if (!started || generation !== pollGeneration) return;
      updater = nextUpdater;
      let nextFingerprint;
      try {
        nextFingerprint = fingerprint(await fileSystem.stat(databasePath));
      } catch {
        if (!started || generation !== pollGeneration) return;
        if (current) current = { ...current, reloadStatus: 'failed' };
        return;
      }
      if (!started || generation !== pollGeneration) return;
      if (current?.fingerprint === nextFingerprint) return;
      if (failedFingerprint === nextFingerprint && clock.now() - failedAt < FAILURE_RETRY_MS) return;
      try {
        const candidate = await loadCandidate();
        if (!started || generation !== pollGeneration) return;
        current = candidate;
        failedFingerprint = null;
        failedAt = 0;
      } catch {
        if (!started || generation !== pollGeneration) return;
        failedFingerprint = nextFingerprint;
        failedAt = clock.now();
        if (current) current = { ...current, reloadStatus: 'failed' };
        logger.error(`[analytics] GeoIP reload failed (${nextFingerprint})`);
      }
    })();
    inFlight = operation;
    try {
      await operation;
    } finally {
      if (inFlight === operation) inFlight = null;
    }
  }

  return Object.freeze({
    async start() {
      if (started) return;
      const startGeneration = ++generation;
      started = true;
      try {
        const candidate = await loadCandidate();
        const nextUpdater = await readUpdaterStatus();
        if (!started || generation !== startGeneration) return;
        current = candidate;
        updater = nextUpdater;
        timer = scheduler.setInterval(() => poll().catch(() => {}), POLL_INTERVAL_MS);
        timer?.unref?.();
      } catch (error) {
        if (generation === startGeneration) started = false;
        throw error;
      }
    },
    stop() {
      started = false;
      generation += 1;
      if (timer) scheduler.clearInterval(timer);
      timer = null;
      current = null;
      inFlight = null;
    },
    resolve(ip) {
      if (!net.isIP(ip)) return { status: 'lookup_error', data: null, errorCategory: 'invalid_ip' };
      if (privateIp(ip)) return { status: 'private', data: null };
      const snapshot = current;
      if (!snapshot) return { status: 'lookup_error', data: null, errorCategory: 'reader_unavailable' };
      try {
        return { status: 'resolved', data: mapCity(snapshot.reader.city(ip)) };
      } catch (error) {
        if (error?.name === 'AddressNotFoundError') return { status: 'not_found', data: null };
        return { status: 'lookup_error', data: null, errorCategory: 'lookup_failed' };
      }
    },
    getStatus() {
      const reader = current ? {
        datasetEpoch: current.datasetEpoch,
        datasetDate: current.datasetDate,
        fingerprint: current.fingerprint,
        lastReloadAt: current.lastReloadAt,
        reloadStatus: current.reloadStatus
      } : null;
      return {
        reader,
        updater: { ...updater },
        stale: Boolean(reader && clock.now() - reader.datasetEpoch * 1000 > STALE_AFTER_MS)
      };
    }
  });
}

module.exports = { createGeoResolver };

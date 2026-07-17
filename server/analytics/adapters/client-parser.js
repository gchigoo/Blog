const Bowser = require('bowser');

function normalized(value) {
  return typeof value === 'string' && value.trim()
    ? value.trim().normalize('NFKC').toLowerCase()
    : null;
}

function createClientParser(bowser = Bowser) {
  return Object.freeze({
    parse(userAgent) {
      if (typeof userAgent !== 'string' || !userAgent.trim()) {
        return { status: 'unknown', data: null };
      }
      try {
        const result = bowser.parse(userAgent);
        const data = {
          browserName: result.browser?.name || null,
          browserVersion: result.browser?.version || null,
          browserNameNormalized: normalized(result.browser?.name),
          osName: result.os?.name || null,
          osVersion: result.os?.version || null,
          osNameNormalized: normalized(result.os?.name),
          engineName: result.engine?.name || null,
          engineVersion: result.engine?.version || null,
          deviceType: result.platform?.type || null,
          deviceVendor: result.platform?.vendor || null,
          deviceModel: result.platform?.model || null,
          deviceTypeNormalized: normalized(result.platform?.type),
          cpuArchitecture: result.platform?.architecture || null
        };
        const known = data.browserName || data.osName || data.deviceType || data.engineName;
        return known ? { status: 'parsed', data } : { status: 'unknown', data };
      } catch {
        return { status: 'error', data: null, errorCategory: 'parse_failed' };
      }
    }
  });
}

module.exports = { createClientParser };

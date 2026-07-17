const crypto = require('node:crypto');

const DANGEROUS_KEYS = new Set(['__proto__', 'prototype', 'constructor']);
const CONTEXT_KEYS = new Set([
  'userAgentData', 'screen', 'viewport', 'devicePixelRatio', 'language', 'languages',
  'timezone', 'hardwareConcurrency', 'deviceMemory', 'maxTouchPoints', 'network'
]);

function invalid() {
  throw new Error('invalid_context');
}

function plainObject(value, allowedKeys) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid();
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) invalid();
  for (const key of Object.keys(value)) {
    if (DANGEROUS_KEYS.has(key) || !allowedKeys.has(key)) invalid();
  }
  return value;
}

function stringValue(value, maxLength) {
  if (typeof value !== 'string' || [...value].length > maxLength) invalid();
  return value.normalize('NFC');
}

function numberValue(value, min, max, integer = false) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) invalid();
  if (integer && !Number.isInteger(value)) invalid();
  return value;
}

function booleanValue(value) {
  if (typeof value !== 'boolean') invalid();
  return value;
}

function stringArray(value, maxItems, maxLength) {
  if (!Array.isArray(value) || value.length > maxItems) invalid();
  return value.map(item => stringValue(item, maxLength));
}

function brandArray(value) {
  if (!Array.isArray(value) || value.length > 20) invalid();
  return value.map(item => {
    const brand = plainObject(item, new Set(['brand', 'version']));
    if (Object.keys(brand).length !== 2) invalid();
    return { brand: stringValue(brand.brand, 128), version: stringValue(brand.version, 64) };
  });
}

function parseUserAgentData(value) {
  const input = plainObject(value, new Set(['brands', 'mobile', 'platform', 'highEntropy']));
  const output = {};
  if ('brands' in input) output.brands = brandArray(input.brands);
  if ('mobile' in input) output.mobile = booleanValue(input.mobile);
  if ('platform' in input) output.platform = stringValue(input.platform, 128);
  if ('highEntropy' in input) {
    const high = plainObject(input.highEntropy, new Set([
      'architecture', 'bitness', 'formFactors', 'fullVersionList', 'model',
      'platformVersion', 'uaFullVersion', 'wow64'
    ]));
    output.highEntropy = {};
    for (const key of ['architecture', 'bitness', 'model', 'platformVersion', 'uaFullVersion']) {
      if (key in high) output.highEntropy[key] = stringValue(high[key], 256);
    }
    if ('formFactors' in high) output.highEntropy.formFactors = stringArray(high.formFactors, 20, 128);
    if ('fullVersionList' in high) output.highEntropy.fullVersionList = brandArray(high.fullVersionList);
    if ('wow64' in high) output.highEntropy.wow64 = booleanValue(high.wow64);
  }
  return output;
}

function parseDimensions(value, screen) {
  const keys = screen
    ? ['width', 'height', 'availWidth', 'availHeight', 'colorDepth', 'pixelDepth']
    : ['width', 'height'];
  const input = plainObject(value, new Set(keys));
  const output = {};
  for (const key of keys) {
    if (key in input) output[key] = numberValue(input[key], 0, 100000, true);
  }
  if (!Object.keys(output).length) invalid();
  return output;
}

function parseNetwork(value) {
  const input = plainObject(value, new Set(['effectiveType', 'downlink', 'rtt', 'saveData']));
  const output = {};
  if ('effectiveType' in input) output.effectiveType = stringValue(input.effectiveType, 32);
  if ('downlink' in input) output.downlink = numberValue(input.downlink, 0, 100000);
  if ('rtt' in input) output.rtt = numberValue(input.rtt, 0, 100000);
  if ('saveData' in input) output.saveData = booleanValue(input.saveData);
  return output;
}

function sortRecursively(value) {
  if (Array.isArray(value)) return value.map(sortRecursively);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value).sort().map(key => [key, sortRecursively(value[key])])
    );
  }
  return value;
}

function validateClientContext(body) {
  const root = plainObject(body, new Set(['context']));
  if (Object.keys(root).length !== 1) invalid();
  const input = plainObject(root.context, CONTEXT_KEYS);
  if (!Object.keys(input).length) invalid();
  const value = {};

  if ('userAgentData' in input) value.userAgentData = parseUserAgentData(input.userAgentData);
  if ('screen' in input) value.screen = parseDimensions(input.screen, true);
  if ('viewport' in input) value.viewport = parseDimensions(input.viewport, false);
  if ('devicePixelRatio' in input) value.devicePixelRatio = numberValue(input.devicePixelRatio, 0, 100);
  if ('language' in input) value.language = stringValue(input.language, 128);
  if ('languages' in input) value.languages = stringArray(input.languages, 20, 128);
  if ('timezone' in input) value.timezone = stringValue(input.timezone, 128);
  if ('hardwareConcurrency' in input) value.hardwareConcurrency = numberValue(input.hardwareConcurrency, 0, 1024, true);
  if ('deviceMemory' in input) value.deviceMemory = numberValue(input.deviceMemory, 0, 65536);
  if ('maxTouchPoints' in input) value.maxTouchPoints = numberValue(input.maxTouchPoints, 0, 1024, true);
  if ('network' in input) value.network = parseNetwork(input.network);

  const canonical = JSON.stringify(sortRecursively(value));
  if (Buffer.byteLength(canonical) > 16384) invalid();
  return {
    value,
    canonical,
    hash: crypto.createHash('sha256').update(canonical).digest('hex')
  };
}

module.exports = { validateClientContext };

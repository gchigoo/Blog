const net = require('node:net');

const CREDENTIAL_KEYS = new Set([
  'code', 'state', 'token', 'access_token', 'id_token', 'refresh_token',
  'password', 'secret', 'api_key', 'apikey', 'authorization', 'credential'
]);
const CLIENT_HINT_HEADERS = [
  'sec-ch-ua', 'sec-ch-ua-mobile', 'sec-ch-ua-platform',
  'sec-ch-ua-platform-version', 'sec-ch-ua-full-version',
  'sec-ch-ua-full-version-list', 'sec-ch-ua-arch', 'sec-ch-ua-bitness',
  'sec-ch-ua-model', 'sec-ch-ua-wow64', 'sec-ch-ua-form-factors'
];

function truncate(value, maxLength) {
  if (typeof value !== 'string') return { value: '', truncated: false };
  if (value.length <= maxLength) return { value, truncated: false };
  return { value: value.slice(0, maxLength), truncated: true };
}

function normalizeTrustedIp(requestOrIp) {
  const raw = typeof requestOrIp === 'string' ? requestOrIp : requestOrIp?.ip;
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  const normalized = trimmed.toLowerCase().startsWith('::ffff:')
    ? trimmed.slice(7)
    : trimmed;
  return net.isIP(normalized) ? normalized : null;
}

function decodeQueryComponent(value) {
  return decodeURIComponent(value.replace(/\+/g, ' '));
}

function redactQuery(rawQuery) {
  if (!rawQuery) return { queryString: '', redacted: false };
  const parts = [];
  let redacted = false;

  for (const pair of rawQuery.split('&')) {
    const separator = pair.indexOf('=');
    const rawKey = separator === -1 ? pair : pair.slice(0, separator);
    const rawValue = separator === -1 ? null : pair.slice(separator + 1);
    const decodedKey = decodeQueryComponent(rawKey);
    if (rawValue !== null) decodeQueryComponent(rawValue);

    if (CREDENTIAL_KEYS.has(decodedKey.toLowerCase())) {
      parts.push(`${rawKey}=${encodeURIComponent('[REDACTED]')}`);
      redacted = true;
    } else {
      parts.push(pair);
    }
  }
  return { queryString: parts.join('&'), redacted };
}

function sanitizePublicRequestUrl(originalUrl, publicOrigin) {
  const raw = typeof originalUrl === 'string' ? originalUrl : '/';
  const queryIndex = raw.indexOf('?');
  const requestPath = (queryIndex === -1 ? raw : raw.slice(0, queryIndex)) || '/';
  const rawQuery = queryIndex === -1 ? '' : raw.slice(queryIndex + 1);

  if (!rawQuery) {
    return {
      requestPath,
      queryString: null,
      fullUrl: `${publicOrigin}${requestPath}`,
      status: 'ok'
    };
  }

  try {
    const redacted = redactQuery(rawQuery);
    const available = Math.max(0, 4096 - publicOrigin.length - requestPath.length - 1);
    const limited = truncate(redacted.queryString, available);
    return {
      requestPath,
      queryString: limited.value,
      fullUrl: `${publicOrigin}${requestPath}?${limited.value}`,
      status: limited.truncated ? 'truncated' : redacted.redacted ? 'redacted' : 'ok'
    };
  } catch {
    return {
      requestPath,
      queryString: null,
      fullUrl: `${publicOrigin}${requestPath}`,
      status: 'invalid_query_redacted'
    };
  }
}

function sanitizeReferrer(value) {
  if (typeof value !== 'string' || !value) {
    return { value: null, host: null, status: 'missing' };
  }
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol)) {
      return { value: null, host: null, status: 'invalid_scheme' };
    }
    url.username = '';
    url.password = '';
    const redacted = redactQuery(url.search.slice(1));
    url.search = redacted.queryString ? `?${redacted.queryString}` : '';
    const limited = truncate(url.toString(), 4096);
    return {
      value: limited.value,
      host: url.hostname.toLowerCase().slice(0, 255),
      status: limited.truncated ? 'truncated' : redacted.redacted ? 'redacted' : 'ok'
    };
  } catch {
    return { value: null, host: null, status: 'invalid_redacted' };
  }
}

function captureRequestClient(req) {
  const userAgent = truncate(req.get('user-agent') || '', 2048).value;
  const acceptLanguage = truncate(req.get('accept-language') || '', 1024).value;
  const clientHints = {};
  for (const name of CLIENT_HINT_HEADERS) {
    const value = req.get(name);
    if (typeof value === 'string' && value) {
      clientHints[name] = truncate(value, 1024).value;
    }
  }
  while (Buffer.byteLength(JSON.stringify(clientHints)) > 8192) {
    const lastKey = Object.keys(clientHints).at(-1);
    if (!lastKey) break;
    delete clientHints[lastKey];
  }
  return { userAgent, acceptLanguage, clientHints };
}

module.exports = {
  captureRequestClient,
  normalizeTrustedIp,
  sanitizePublicRequestUrl,
  sanitizeReferrer
};

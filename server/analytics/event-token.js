const crypto = require('node:crypto');

const AUDIENCE = 'analytics-client-context';
const TTL_SECONDS = 600;
const SALT = Buffer.from('minimalist-blog/analytics');
const INFO = Buffer.from('analytics-client-context/v1');

function deriveSigningKey(secret) {
  if (!Buffer.isBuffer(secret) || secret.length < 32) {
    throw new Error('analytics event token secret must be at least 32 bytes');
  }
  return Buffer.from(crypto.hkdfSync('sha256', secret, SALT, INFO, 32));
}

function decodeCanonicalBase64Url(segment) {
  if (!/^[A-Za-z0-9_-]+$/.test(segment)) throw new Error('invalid base64url');
  const decoded = Buffer.from(segment, 'base64url');
  if (decoded.toString('base64url') !== segment) throw new Error('non-canonical base64url');
  return decoded;
}

function validClaims(claims) {
  if (!claims || typeof claims !== 'object' || Array.isArray(claims)) return false;
  const keys = Object.keys(claims);
  if (keys.join(',') !== 'v,aud,eventId,iat,exp') return false;
  return claims.v === 1
    && claims.aud === AUDIENCE
    && /^[0-9a-f]{32}$/.test(claims.eventId)
    && Number.isInteger(claims.iat)
    && Number.isInteger(claims.exp)
    && claims.exp === claims.iat + TTL_SECONDS;
}

function createEventTokenSigner({ secret }) {
  const signingKey = deriveSigningKey(secret);

  return Object.freeze({
    sign(eventId, now = Date.now()) {
      if (!/^[0-9a-f]{32}$/.test(eventId)) throw new Error('invalid analytics event id');
      const iat = Math.floor(now / 1000);
      const claims = { v: 1, aud: AUDIENCE, eventId, iat, exp: iat + TTL_SECONDS };
      const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
      const input = `v1.${payload}`;
      const signature = crypto.createHmac('sha256', signingKey).update(input, 'ascii').digest('base64url');
      return `${input}.${signature}`;
    },
    verify(token, now = Date.now()) {
      try {
        if (typeof token !== 'string' || token.length > 2048) return { status: 'invalid' };
        const [version, payload, signature, extra] = token.split('.');
        if (version !== 'v1' || !payload || !signature || extra !== undefined) return { status: 'invalid' };
        const expected = crypto.createHmac('sha256', signingKey)
          .update(`v1.${payload}`, 'ascii')
          .digest();
        const actual = decodeCanonicalBase64Url(signature);
        if (actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected)) {
          return { status: 'invalid' };
        }
        const claims = JSON.parse(decodeCanonicalBase64Url(payload).toString('utf8'));
        if (!validClaims(claims)) return { status: 'invalid' };
        if (Math.floor(now / 1000) >= claims.exp) return { status: 'expired', claims };
        return { status: 'valid', claims };
      } catch {
        return { status: 'invalid' };
      }
    },
    createEventId() {
      return crypto.randomBytes(16).toString('hex');
    }
  });
}

module.exports = { AUDIENCE, TTL_SECONDS, createEventTokenSigner };

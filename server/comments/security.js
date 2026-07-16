const {
  createHash,
  hkdfSync,
  randomBytes,
  timingSafeEqual
} = require('node:crypto');
const jwt = require('jsonwebtoken');
const { isSafeSlug } = require('../utils/path-security');

const TOKEN_ISSUER = 'minimalist-blog-comments';
const OAUTH_AUDIENCE = 'google-oauth-callback';
const SESSION_AUDIENCE = 'comment-session';
const OAUTH_TTL_SECONDS = 10 * 60;
const SESSION_TTL_SECONDS = 7 * 24 * 60 * 60;
const HKDF_SALT = Buffer.from('minimalist-blog-comments-v1', 'utf8');

function nowSeconds(clock) {
  const value = clock.now();
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    throw new TypeError('clock.now() must return a valid Date');
  }
  return Math.floor(value.getTime() / 1000);
}

function deriveKey(secret, context) {
  return Buffer.from(hkdfSync(
    'sha256',
    Buffer.from(secret, 'utf8'),
    HKDF_SALT,
    Buffer.from(context, 'utf8'),
    32
  ));
}

function randomBase64Url(byteLength = 32) {
  return randomBytes(byteLength).toString('base64url');
}

function createPkcePair() {
  const verifier = randomBase64Url(32);
  const challenge = createHash('sha256').update(verifier, 'ascii').digest('base64url');
  return { verifier, challenge };
}

function safeEqual(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string') return false;
  const leftBytes = Buffer.from(left, 'utf8');
  const rightBytes = Buffer.from(right, 'utf8');
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

function sanitizeReturnPath(value) {
  if (typeof value !== 'string') return '/';
  const match = value.match(/^\/article\/([^/?#]+)$/);
  return match && isSafeSlug(match[1]) ? value : '/';
}

function createTokenService(secret, clock) {
  const oauthKey = deriveKey(secret, 'comment-oauth');
  const sessionKey = deriveKey(secret, 'comment-session');

  function sign(payload, key, audience, ttlSeconds) {
    const issuedAt = nowSeconds(clock);
    return jwt.sign(
      { ...payload, iat: issuedAt, exp: issuedAt + ttlSeconds },
      key,
      {
        algorithm: 'HS256',
        issuer: TOKEN_ISSUER,
        audience
      }
    );
  }

  function verify(token, key, audience) {
    return jwt.verify(token, key, {
      algorithms: ['HS256'],
      issuer: TOKEN_ISSUER,
      audience,
      clockTimestamp: nowSeconds(clock)
    });
  }

  return Object.freeze({
    createOAuthContext({ tokenId, state, codeVerifier, returnTo }) {
      return sign({
        token_use: 'oauth_context',
        jti: tokenId,
        state,
        code_verifier: codeVerifier,
        return_to: sanitizeReturnPath(returnTo)
      }, oauthKey, OAUTH_AUDIENCE, OAUTH_TTL_SECONDS);
    },

    verifyOAuthContext(token) {
      const payload = verify(token, oauthKey, OAUTH_AUDIENCE);
      if (payload.token_use !== 'oauth_context'
        || typeof payload.jti !== 'string'
        || !/^[A-Za-z0-9_-]{43}$/.test(payload.jti)
        || typeof payload.state !== 'string'
        || typeof payload.code_verifier !== 'string'
        || typeof payload.return_to !== 'string'
        || sanitizeReturnPath(payload.return_to) !== payload.return_to) {
        throw new jwt.JsonWebTokenError('invalid OAuth context claims');
      }
      return payload;
    },

    createSession({ commenterId, csrfToken }) {
      return sign({
        token_use: 'comment_session',
        sub: String(commenterId),
        csrf: csrfToken
      }, sessionKey, SESSION_AUDIENCE, SESSION_TTL_SECONDS);
    },

    verifySession(token) {
      const payload = verify(token, sessionKey, SESSION_AUDIENCE);
      if (payload.token_use !== 'comment_session'
        || typeof payload.sub !== 'string'
        || !/^\d+$/.test(payload.sub)
        || typeof payload.csrf !== 'string'
        || payload.csrf.length < 32) {
        throw new jwt.JsonWebTokenError('invalid comment session claims');
      }
      return payload;
    }
  });
}

function cookieOptions(secure) {
  return {
    httpOnly: true,
    sameSite: 'lax',
    secure
  };
}

function oauthCookieOptions(secure, includeLifetime = true) {
  return {
    ...cookieOptions(secure),
    path: '/auth/google/callback',
    ...(includeLifetime ? { maxAge: OAUTH_TTL_SECONDS * 1000 } : {})
  };
}

function sessionCookieOptions(secure, includeLifetime = true) {
  return {
    ...cookieOptions(secure),
    path: '/',
    ...(includeLifetime ? { maxAge: SESSION_TTL_SECONDS * 1000 } : {})
  };
}

module.exports = {
  OAUTH_TTL_SECONDS,
  SESSION_TTL_SECONDS,
  createPkcePair,
  createTokenService,
  oauthCookieOptions,
  randomBase64Url,
  safeEqual,
  sanitizeReturnPath,
  sessionCookieOptions
};

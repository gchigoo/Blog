const express = require('express');
const { validateClientContext } = require('./context-validator');
const { normalizeTrustedIp } = require('./request-security');
const { updateEventContext } = require('./repository');

const CONTEXT_PATH = '/api/analytics/client-context';
const BODY_LIMIT_BYTES = 16 * 1024;

function errorResponse(res, status, error, retryAfter = null) {
  res.set('Cache-Control', 'no-store');
  if (retryAfter !== null) res.set('Retry-After', String(retryAfter));
  return res.status(status).json({ error });
}

function createPublicContextRouter({ db, config, clock, tokenSigner, rateLimiters }) {
  const router = express.Router();
  const parser = express.json({ limit: BODY_LIMIT_BYTES, strict: true, type: 'application/json' });

  function precheck(req, res, next) {
    if (!req.is('application/json')) return errorResponse(res, 415, 'unsupported_media_type');
    if (req.get('origin') !== config.publicOrigin) return errorResponse(res, 403, 'origin_forbidden');

    const ip = normalizeTrustedIp(req) || 'invalid';
    const ipLimit = rateLimiters.consumeIp(ip);
    if (!ipLimit.allowed) return errorResponse(res, 429, 'rate_limited', ipLimit.retryAfter);

    const verified = tokenSigner.verify(req.get('x-analytics-event-token'), clock.now());
    if (verified.status === 'expired') return errorResponse(res, 410, 'token_expired');
    if (verified.status !== 'valid') return errorResponse(res, 401, 'invalid_event_token');

    const eventLimit = rateLimiters.consumeEvent(
      verified.claims.eventId,
      verified.claims.exp * 1000 + 60_000
    );
    if (!eventLimit.allowed) return errorResponse(res, 429, 'rate_limited', eventLimit.retryAfter);

    const contentLength = req.get('content-length');
    if (contentLength && /^\d+$/.test(contentLength) && Number(contentLength) > BODY_LIMIT_BYTES) {
      return errorResponse(res, 413, 'payload_too_large');
    }
    req.analyticsEventClaims = verified.claims;
    return next();
  }

  router.post(CONTEXT_PATH, precheck, parser, (req, res) => {
    let validated;
    try {
      validated = validateClientContext(req.body);
    } catch {
      return errorResponse(res, 400, 'invalid_context');
    }
    const result = updateEventContext(
      db,
      req.analyticsEventClaims.eventId,
      validated,
      new Date(clock.now()).toISOString()
    );
    if (result === 'not_found') return errorResponse(res, 425, 'event_not_ready', 1);
    if (result === 'conflict') return errorResponse(res, 409, 'context_conflict');
    res.set('Cache-Control', 'no-store');
    return res.status(204).end();
  });

  router.use((error, req, res, next) => {
    if (req.path !== CONTEXT_PATH) return next(error);
    if (error?.type === 'entity.too.large') return errorResponse(res, 413, 'payload_too_large');
    if (error instanceof SyntaxError || error?.type === 'entity.parse.failed') {
      return errorResponse(res, 400, 'malformed_json');
    }
    return next(error);
  });

  return router;
}

module.exports = { BODY_LIMIT_BYTES, CONTEXT_PATH, createPublicContextRouter };

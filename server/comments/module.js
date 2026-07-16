const express = require('express');
const { authenticateToken } = require('../middleware/auth');
const { GoogleIdentityError } = require('./google-identity');
const { CommentStoreError, createCommentStore } = require('./store');
const {
  createPkcePair,
  createTokenService,
  OAUTH_TTL_SECONDS,
  oauthCookieOptions,
  randomBase64Url,
  safeEqual,
  sanitizeReturnPath,
  sessionCookieOptions
} = require('./security');

const OAUTH_COOKIE = 'comment_oauth';
const SESSION_COOKIE = 'comment_session';

function oauthErrorStatus(code) {
  if (code === 'exchange_failed') return 502;
  if (code === 'internal_error') return 500;
  return 400;
}

function requireSameOrigin(req, res, next) {
  const origin = req.get('origin');
  if (!origin) {
    return res.status(403).json({ error: 'same_origin_required' });
  }

  try {
    const parsedOrigin = new URL(origin);
    const expectedOrigin = new URL(`${req.protocol}://${req.get('host')}`).origin;
    if (parsedOrigin.origin !== origin || parsedOrigin.origin !== expectedOrigin) {
      return res.status(403).json({ error: 'same_origin_required' });
    }
  } catch {
    return res.status(403).json({ error: 'same_origin_required' });
  }
  return next();
}

function createCommentsModule({ db, config, identityClient, clock = { now: () => new Date() } }) {
  if (!config?.enabled) {
    throw new TypeError('createCommentsModule requires enabled comments configuration');
  }
  if (!db || typeof db.prepare !== 'function') {
    throw new TypeError('createCommentsModule requires a database connection');
  }
  if (typeof identityClient?.createAuthorizationUrl !== 'function'
    || typeof identityClient?.exchangeCode !== 'function') {
    throw new TypeError('createCommentsModule requires a Google identity client');
  }
  if (typeof clock?.now !== 'function') {
    throw new TypeError('createCommentsModule requires a clock with now()');
  }

  const authRouter = express.Router();
  const publicRouter = express.Router();
  const adminRouter = express.Router();
  const tokens = createTokenService(config.sessionSecret, clock);
  const store = createCommentStore(db);
  const secureCookies = config.secureCookies === true;

  function clearOAuthCookie(res) {
    res.clearCookie(OAUTH_COOKIE, oauthCookieOptions(secureCookies, false));
  }

  function clearSessionCookie(res) {
    res.clearCookie(SESSION_COOKIE, sessionCookieOptions(secureCookies, false));
  }

  function commenterSession(req, res, next) {
    req.commenter = null;
    req.commentSession = null;
    const token = req.cookies?.[SESSION_COOKIE];
    if (!token) return next();

    try {
      const payload = tokens.verifySession(token);
      const commenter = store.findById(Number(payload.sub));
      if (!commenter) return next();
      req.commenter = {
        id: commenter.id,
        displayName: commenter.display_name
      };
      req.commentSession = { csrfToken: payload.csrf };
    } catch {
      clearSessionCookie(res);
    }
    next();
  }

  authRouter.get('/auth/google', (req, res) => {
    try {
      const state = randomBase64Url();
      const tokenId = randomBase64Url();
      const { verifier, challenge } = createPkcePair();
      const oauthContext = tokens.createOAuthContext({
        tokenId,
        state,
        codeVerifier: verifier,
        returnTo: sanitizeReturnPath(req.query.returnTo)
      });
      const authorizationUrl = new URL(identityClient.createAuthorizationUrl({
        state,
        codeChallenge: challenge
      }));
      if (authorizationUrl.protocol !== 'https:'
        || authorizationUrl.hostname !== 'accounts.google.com') {
        throw new Error('identity client returned an invalid authorization URL');
      }

      const createdAt = clock.now();
      store.registerOAuthContext({
        tokenId,
        createdAt: createdAt.toISOString(),
        expiresAt: new Date(
          createdAt.getTime() + OAUTH_TTL_SECONDS * 1000
        ).toISOString()
      });

      res.cookie(OAUTH_COOKIE, oauthContext, oauthCookieOptions(secureCookies));
      res.redirect(authorizationUrl.toString());
    } catch {
      res.status(500).json({ error: 'google_login_unavailable' });
    }
  });

  authRouter.get('/auth/google/callback', async (req, res) => {
    clearOAuthCookie(res);

    let errorCode = null;
    try {
      const state = typeof req.query.state === 'string' ? req.query.state : '';
      const contextToken = req.cookies?.[OAUTH_COOKIE];
      if (!state || !contextToken) {
        throw new GoogleIdentityError('invalid_callback');
      }

      let context;
      try {
        context = tokens.verifyOAuthContext(contextToken);
      } catch {
        throw new GoogleIdentityError('invalid_callback');
      }
      if (!safeEqual(state, context.state)) {
        throw new GoogleIdentityError('invalid_callback');
      }
      if (!store.consumeOAuthContext({
        tokenId: context.jti,
        consumedAt: clock.now().toISOString()
      })) {
        throw new GoogleIdentityError('invalid_callback');
      }
      if (req.query.error) {
        throw new GoogleIdentityError(
          req.query.error === 'access_denied' ? 'provider_denied' : 'invalid_callback'
        );
      }

      const code = typeof req.query.code === 'string' ? req.query.code : '';
      if (!code) {
        throw new GoogleIdentityError('invalid_callback');
      }

      const identity = await identityClient.exchangeCode({
        code,
        codeVerifier: context.code_verifier
      });
      const timestamp = clock.now().toISOString();
      const commenter = store.upsertIdentity(identity, timestamp);
      if (!commenter) {
        throw new GoogleIdentityError('identity_invalid');
      }

      const sessionToken = tokens.createSession({
        commenterId: commenter.id,
        csrfToken: randomBase64Url()
      });
      res.cookie(SESSION_COOKIE, sessionToken, sessionCookieOptions(secureCookies));
      return res.redirect(context.return_to);
    } catch (error) {
      errorCode = error instanceof GoogleIdentityError
        ? error.code
        : 'internal_error';
    }

    console.warn(`[comments] OAuth failed: ${errorCode}`);
    return res.status(oauthErrorStatus(errorCode)).json({ error: 'google_login_failed' });
  });

  authRouter.post('/auth/logout', (req, res) => {
    if (!req.commenter || !req.commentSession) {
      return res.status(401).json({ error: 'comment_login_required' });
    }
    if (!safeEqual(req.body?.csrfToken, req.commentSession.csrfToken)) {
      return res.status(403).json({ error: 'invalid_csrf_token' });
    }
    clearSessionCookie(res);
    return res.status(204).end();
  });

  publicRouter.post('/api/articles/:id/comments', (req, res) => {
    if (!req.commenter || !req.commentSession) {
      return res.status(401).json({ error: 'comment_login_required' });
    }
    if (!safeEqual(req.body?.csrfToken, req.commentSession.csrfToken)) {
      return res.status(403).json({ error: 'invalid_csrf_token' });
    }

    const articleId = Number(req.params.id);
    const rawContent = req.body?.content;
    const content = typeof rawContent === 'string' ? rawContent.trim() : '';
    const contentLength = Array.from(content).length;
    if (!Number.isInteger(articleId) || articleId <= 0) {
      return res.status(404).json({ error: 'article_not_found' });
    }
    if (contentLength < 1 || contentLength > 1000) {
      return res.status(422).json({ error: 'invalid_comment_content' });
    }

    try {
      const comment = store.createPendingComment({
        articleId,
        commenterId: req.commenter.id,
        content,
        createdAt: clock.now().toISOString()
      });
      console.info(`[comments] submitted comment ${comment.id} as pending`);
      return res.status(201).json({
        comment: {
          id: comment.id,
          status: comment.status,
          createdAt: comment.createdAt
        },
        message: '评论已提交，等待审核'
      });
    } catch (error) {
      if (error instanceof CommentStoreError) {
        if (error.code === 'article_not_found') {
          return res.status(404).json({ error: 'article_not_found' });
        }
        if (error.code === 'rate_limited') {
          return res.status(429).json({ error: 'comment_rate_limited' });
        }
      }
      console.error('[comments] failed to create comment');
      return res.status(500).json({ error: 'comment_create_failed' });
    }
  });

  adminRouter.get('/admin/comments', authenticateToken, (req, res) => {
    const status = typeof req.query.status === 'string' ? req.query.status : 'pending';
    try {
      return res.render('admin/comments', {
        comments: store.listForModeration(status),
        status,
        user: req.user
      });
    } catch (error) {
      if (error instanceof CommentStoreError && error.code === 'invalid_status') {
        return res.status(422).json({ error: 'invalid_comment_status' });
      }
      console.error('[comments] failed to render moderation queue');
      return res.status(500).send('服务器错误');
    }
  });

  adminRouter.patch(
    '/api/admin/comments/:id',
    authenticateToken,
    requireSameOrigin,
    (req, res) => {
      const commentId = Number(req.params.id);
      const targetStatus = req.body?.status;
      if (!Number.isInteger(commentId) || commentId <= 0) {
        return res.status(404).json({ error: 'comment_not_found' });
      }
      if (!['approved', 'rejected'].includes(targetStatus)) {
        return res.status(422).json({ error: 'invalid_comment_status' });
      }

      try {
        const comment = store.reviewComment({
          commentId,
          targetStatus,
          reviewerId: req.user.id,
          reviewedAt: clock.now().toISOString()
        });
        console.info(
          `[comments] reviewed comment ${comment.id} as ${comment.status} by admin ${req.user.id}`
        );
        return res.json({ comment });
      } catch (error) {
        if (error instanceof CommentStoreError) {
          if (error.code === 'comment_not_found') {
            return res.status(404).json({ error: 'comment_not_found' });
          }
          if (['invalid_status', 'invalid_transition'].includes(error.code)) {
            return res.status(422).json({ error: 'invalid_comment_status' });
          }
        }
        console.error('[comments] failed to review comment');
        return res.status(500).json({ error: 'comment_review_failed' });
      }
    }
  );

  adminRouter.delete(
    '/api/admin/comments/:id',
    authenticateToken,
    requireSameOrigin,
    (req, res) => {
      const commentId = Number(req.params.id);
      if (!Number.isInteger(commentId) || commentId <= 0
        || !store.deleteComment(commentId)) {
        return res.status(404).json({ error: 'comment_not_found' });
      }
      console.info(`[comments] deleted comment ${commentId} by admin ${req.user.id}`);
      return res.status(204).end();
    }
  );

  function getArticleCommentsViewModel(articleId, session = {}) {
    const commenter = session?.commenter || null;
    return {
      enabled: true,
      comments: store.listApprovedByArticle(articleId),
      commenter,
      csrfToken: commenter ? session.csrfToken || null : null
    };
  }

  return Object.freeze({
    enabled: true,
    authRouter,
    publicRouter,
    adminRouter,
    commenterSession,
    getArticleCommentsViewModel
  });
}

module.exports = {
  createCommentsModule,
  requireSameOrigin
};

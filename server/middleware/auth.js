const jwt = require('jsonwebtoken');
const config = require('../config');

function adminCookieOptions(includeLifetime = true) {
  return {
    httpOnly: true,
    sameSite: 'strict',
    secure: config.secureCookies,
    path: '/',
    ...(includeLifetime ? { maxAge: 7 * 24 * 60 * 60 * 1000 } : {})
  };
}

function tokenFromRequest(req) {
  if (req.cookies?.token) return req.cookies.token;
  const authorization = req.headers.authorization;
  if (typeof authorization !== 'string') return null;
  const match = authorization.match(/^Bearer\s+(\S+)$/i);
  return match ? match[1] : null;
}

function verifyRequestToken(req) {
  const token = tokenFromRequest(req);
  if (!token) return { error: 'missing' };
  try {
    return { user: jwt.verify(token, config.jwtSecret, { algorithms: ['HS256'] }) };
  } catch (error) {
    return { error: error.name === 'TokenExpiredError' ? 'expired' : 'invalid' };
  }
}

/**
 * API JWT 认证中间件。
 */
function authenticateToken(req, res, next) {
  const authentication = verifyRequestToken(req);
  if (authentication.error === 'missing') {
    return res.status(401).json({ error: '未授权访问，请先登录' });
  }
  if (authentication.error === 'expired') {
    return res.status(401).json({ error: 'Token 已过期，请重新登录' });
  }
  if (authentication.error) {
    return res.status(403).json({ error: '无效的 Token' });
  }

  req.user = authentication.user;
  next();
}

/**
 * 后台 HTML 页面认证中间件。无效会话统一回到登录页。
 */
function authenticatePage(req, res, next) {
  res.set('Cache-Control', 'private, no-store');
  const authentication = verifyRequestToken(req);
  if (authentication.error) {
    if (req.cookies?.token) res.clearCookie('token', adminCookieOptions(false));

    // Normal browser navigation gets a login redirect. Programmatic callers keep
    // the established 401/403 contract instead of unexpectedly following HTML.
    if ((req.get('accept') || '').includes('text/html')) {
      return res.redirect(303, '/admin/login');
    }
    if (authentication.error === 'invalid') {
      return res.status(403).json({ error: '无效的 Token' });
    }
    return res.status(401).json({
      error: authentication.error === 'expired'
        ? 'Token 已过期，请重新登录'
        : '未授权访问，请先登录'
    });
  }

  req.user = authentication.user;
  next();
}

/**
 * 可选认证中间件（用于前台页面）
 */
function optionalAuth(req, res, next) {
  const authentication = verifyRequestToken(req);
  if (authentication.user) req.user = authentication.user;
  next();
}

/**
 * 生成 JWT Token
 * @param {Object} payload - 载荷数据
 * @returns {string} - Token
 */
function generateToken(payload) {
  return jwt.sign(payload, config.jwtSecret, {
    algorithm: 'HS256',
    expiresIn: config.jwtExpire
  });
}

module.exports = {
  adminCookieOptions,
  authenticatePage,
  authenticateToken,
  optionalAuth,
  generateToken
};

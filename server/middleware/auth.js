const jwt = require('jsonwebtoken');
const config = require('../config');

/**
 * JWT 认证中间件
 */
function authenticateToken(req, res, next) {
  // 从 Cookie 或 Authorization header 中获取 token
  const token = req.cookies.token || 
                (req.headers.authorization && req.headers.authorization.split(' ')[1]);
  
  if (!token) {
    return res.status(401).json({ error: '未授权访问，请先登录' });
  }
  
  try {
    const decoded = jwt.verify(token, config.jwtSecret);
    req.user = decoded;
    next();
  } catch (error) {
    if (error.name === 'TokenExpiredError') {
      return res.status(401).json({ error: 'Token 已过期，请重新登录' });
    }
    return res.status(403).json({ error: '无效的 Token' });
  }
}

/**
 * 可选认证中间件（用于前台页面）
 */
function optionalAuth(req, res, next) {
  const token = req.cookies.token;
  
  if (token) {
    try {
      const decoded = jwt.verify(token, config.jwtSecret);
      req.user = decoded;
    } catch (error) {
      // Token 无效或过期，继续但不设置 user
    }
  }
  
  next();
}

/**
 * 生成 JWT Token
 * @param {Object} payload - 载荷数据
 * @returns {string} - Token
 */
function generateToken(payload) {
  return jwt.sign(payload, config.jwtSecret, { 
    expiresIn: config.jwtExpire 
  });
}

module.exports = {
  authenticateToken,
  optionalAuth,
  generateToken
};

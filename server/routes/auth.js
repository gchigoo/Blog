const express = require('express');
const router = express.Router();
const bcrypt = require('bcrypt');
const { dbGet } = require('../db');
const { createLoginRateLimiter } = require('../auth/login-rate-limiter');
const { adminCookieOptions, generateToken } = require('../middleware/auth');

const loginRateLimiter = createLoginRateLimiter();
const DUMMY_PASSWORD_HASH = '$2b$10$i/He/TN.yHvkYSoJFS8NrOugV5BvbVpC6aLpgwJAsBB2NOezXx71a';

router.use((req, res, next) => {
  res.set('Cache-Control', 'no-store');
  next();
});

/**
 * POST /api/auth/login
 * 用户登录
 */
router.post('/login', (req, res) => {
  try {
    const rateLimit = loginRateLimiter.consume(req.ip || req.socket.remoteAddress || 'unknown');
    if (!rateLimit.allowed) {
      res.set('Retry-After', String(rateLimit.retryAfter));
      return res.status(429).json({ error: '登录尝试过于频繁，请稍后重试' });
    }

    const { username, password } = req.body || {};

    if (typeof username !== 'string' || typeof password !== 'string'
      || !username.trim() || !password) {
      return res.status(400).json({ error: '用户名和密码不能为空' });
    }
    
    // 查询用户
    const user = dbGet(
      'SELECT id, username, password_hash FROM users WHERE username = ?',
      [username]
    );
    
    // 即使用户名不存在也执行同等成本的 bcrypt，减少账号枚举时序差异。
    bcrypt.compare(password, user?.password_hash || DUMMY_PASSWORD_HASH, (err, isValid) => {
      if (err || !user || !isValid) {
        return res.status(401).json({ error: '用户名或密码错误' });
      }
      
      // 生成 Token
      const token = generateToken({ 
        id: user.id, 
        username: user.username 
      });
      
      // 设置 Cookie
      res.cookie('token', token, adminCookieOptions());
      
      res.json({ 
        success: true, 
        message: '登录成功',
        user: { id: user.id, username: user.username }
      });
    });
  } catch (error) {
    console.error('登录失败:', error);
    res.status(500).json({ error: '服务器错误' });
  }
});

/**
 * POST /api/auth/logout
 * 用户登出
 */
router.post('/logout', (req, res) => {
  res.clearCookie('token', adminCookieOptions(false));
  res.json({ success: true, message: '登出成功' });
});

/**
 * GET /api/auth/check
 * 检查登录状态
 */
router.get('/check', (req, res) => {
  const token = req.cookies.token;
  
  if (!token) {
    return res.json({ authenticated: false });
  }
  
  try {
    const jwt = require('jsonwebtoken');
    const config = require('../config');
    const decoded = jwt.verify(token, config.jwtSecret, { algorithms: ['HS256'] });
    res.json({ 
      authenticated: true, 
      user: { id: decoded.id, username: decoded.username }
    });
  } catch {
    res.json({ authenticated: false });
  }
});

module.exports = router;

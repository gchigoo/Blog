const express = require('express');
const router = express.Router();
const bcrypt = require('bcrypt');
const { dbGet } = require('../db');
const { generateToken } = require('../middleware/auth');

/**
 * POST /api/auth/login
 * 用户登录
 */
router.post('/login', (req, res) => {
  try {
    const { username, password } = req.body;
    
    if (!username || !password) {
      return res.status(400).json({ error: '用户名和密码不能为空' });
    }
    
    // 查询用户
    const user = dbGet(
      'SELECT id, username, password_hash FROM users WHERE username = ?',
      [username]
    );
    
    if (!user) {
      return res.status(401).json({ error: '用户名或密码错误' });
    }
    
    // 验证密码（异步）
    bcrypt.compare(password, user.password_hash, (err, isValid) => {
      if (err || !isValid) {
        return res.status(401).json({ error: '用户名或密码错误' });
      }
      
      // 生成 Token
      const token = generateToken({ 
        id: user.id, 
        username: user.username 
      });
      
      // 设置 Cookie
      res.cookie('token', token, {
        httpOnly: true,
        maxAge: 7 * 24 * 60 * 60 * 1000, // 7 天
        sameSite: 'strict'
      });
      
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
  res.clearCookie('token');
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
    const decoded = jwt.verify(token, config.jwtSecret);
    res.json({ 
      authenticated: true, 
      user: { id: decoded.id, username: decoded.username }
    });
  } catch (error) {
    res.json({ authenticated: false });
  }
});

module.exports = router;

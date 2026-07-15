const express = require('express');
const { db } = require('../db');
const { getOverview } = require('../analytics/store');
const { authenticateToken } = require('../middleware/auth');

const router = express.Router();

router.get('/', authenticateToken, (req, res) => {
  try {
    res.json(getOverview(db, Date.now(), req.query.days));
  } catch (error) {
    console.error('读取匿名访问统计失败:', error.message);
    res.status(500).json({ error: '读取访问统计失败' });
  }
});

module.exports = router;

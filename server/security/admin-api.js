const express = require('express');
const { authenticateToken } = require('../middleware/auth');
const { banNetwork } = require('./ip-bans');

// An IPv4 address, or an IPv6 address or /64; IPv6 bans always cover the /64.
function requestedNetwork(value) {
  if (typeof value !== 'string' || value.length > 64) return null;
  return banNetwork(value.trim().replace(/\/64$/, ''));
}

function createIpBanAdminRouter({ guard }) {
  const router = express.Router();
  router.use((req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
  });
  router.use(authenticateToken);

  router.get('/', (req, res) => {
    const limit = /^\d{1,4}$/.test(String(req.query.limit ?? '')) ? Number(req.query.limit) : 200;
    return res.json(guard.list(Math.min(Math.max(limit, 1), 1000)));
  });

  router.post('/unban', (req, res) => {
    const network = requestedNetwork(req.body?.network);
    if (!network) return res.status(400).json({ error: 'invalid_network' });
    if (!guard.unban(network)) return res.status(404).json({ error: 'ban_not_found', network });
    return res.json({ unbanned: network });
  });

  return router;
}

module.exports = { createIpBanAdminRouter, requestedNetwork };

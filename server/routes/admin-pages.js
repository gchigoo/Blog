const express = require('express');
const { authenticatePage } = require('../middleware/auth');

/**
 * Admin HTML rendering routes. URLs and Chinese output are identical to the
 * previous pages router: `/admin/login`, `/admin`, `/admin/upload`, and
 * `/admin/articles`. The admin header's public links point directly at
 * `/zh/` and `/zh/about` so an English locale cookie can neither send the
 * admin to the English site nor introduce a negotiator/legacy 301 hop.
 */
function createAdminPagesRouter({ articleService }) {
  const router = express.Router();

  router.get('/login', (req, res) => {
    res.set('Cache-Control', 'private, no-store');
    res.render('admin/login');
  });
  router.get('/', authenticatePage, (req, res) => res.redirect('/admin/upload'));
  router.get('/upload', authenticatePage, (req, res) => res.render('admin/upload', { user: req.user }));
  router.get('/articles', authenticatePage, (req, res) => res.render('admin/articles', {
    articles: articleService.listAdmin(),
    user: req.user
  }));

  return router;
}

module.exports = { createAdminPagesRouter };

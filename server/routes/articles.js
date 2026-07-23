const express = require('express');
const { groupArticlesByMonth } = require('../utils/presentation');

function parsePositiveInteger(value, defaultValue, maximum) {
  if (value === undefined) return defaultValue;
  if (typeof value !== 'string' || !/^\d+$/.test(value)) return null;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > maximum) return null;
  return parsed;
}

function createArticlesRouter({ articleService }) {
  const router = express.Router();

  router.get('/', (req, res) => {
    const page = parsePositiveInteger(req.query.page, 1, 1_000_000);
    const pageSize = parsePositiveInteger(req.query.pageSize, 20, 100);
    if (page === null || pageSize === null) {
      return res.status(400).json({ error: '分页参数无效' });
    }
    const result = articleService.listPublished(page, pageSize);
    return res.json({
      articles: result.articles,
      pagination: {
        page: result.page,
        pageSize: result.pageSize,
        total: result.total,
        totalPages: result.totalPages
      }
    });
  });

  router.get('/tag/:tag', (req, res) => res.json({
    tag: req.params.tag,
    articles: articleService.listByTag(req.params.tag)
  }));
  router.get('/tags/all', (req, res) => res.json(articleService.listTags()));
  router.get('/archive/all', (req, res) => {
    res.json(groupArticlesByMonth(articleService.listArchive()));
  });
  router.get('/:slug', (req, res) => {
    const article = articleService.getPublishedBySlug(req.params.slug);
    return article ? res.json(article) : res.status(404).json({ error: '文章不存在' });
  });

  return router;
}

module.exports = { createArticlesRouter, parsePositiveInteger };

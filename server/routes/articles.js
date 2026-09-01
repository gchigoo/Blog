const express = require('express');
const { groupArticlesByMonth } = require('../utils/presentation');

function parsePositiveInteger(value, defaultValue, maximum) {
  if (value === undefined) return defaultValue;
  if (typeof value !== 'string' || !/^\d+$/.test(value)) return null;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > maximum) return null;
  return parsed;
}

/**
 * The public localized article JSON shape: existing title/slug/description and
 * created timestamp fields plus `locale`, `translationKey`, and the localized
 * taxonomy projection. `alternate` is appended by the detail route.
 */
function serializeLocalizedArticle(article) {
  if (!article) return null;
  return {
    id: article.id,
    title: article.title,
    slug: article.slug,
    description: article.description,
    created_at: article.created_at,
    updated_at: article.updated_at,
    locale: article.locale,
    translationKey: article.translationKey,
    taxonomy: article.taxonomy
  };
}

/**
 * Legacy Chinese article router mounted at `/api/articles`. It keeps the old
 * zh-scoped response shapes (pagination envelope, `{ tag, articles }`, the
 * `{ name, count }` tag cloud, and the raw article model with display-label
 * `tags`) so existing consumers keep working.
 */
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

/**
 * Localized article router mounted at `/api/:locale/articles` behind the
 * strict locale middleware. Static routes (category, tag, taxonomy, archive)
 * are registered before the dynamic `/:slug` so the dynamic route stays last.
 */
function createLocalizedArticlesRouter({ articleService }) {
  const router = express.Router();

  router.get('/', (req, res) => {
    const page = parsePositiveInteger(req.query.page, 1, 1_000_000);
    const pageSize = parsePositiveInteger(req.query.pageSize, 20, 100);
    if (page === null || pageSize === null) {
      return res.status(400).json({ error: '分页参数无效' });
    }
    const result = articleService.listPublished(req.locale, page, pageSize);
    return res.json({
      articles: result.articles.map(serializeLocalizedArticle),
      pagination: {
        page: result.page,
        pageSize: result.pageSize,
        total: result.total,
        totalPages: result.totalPages
      }
    });
  });

  router.get('/category/:slug', (req, res) => res.json({
    category: req.params.slug,
    articles: articleService.listByCategory(req.locale, req.params.slug).map(serializeLocalizedArticle)
  }));
  router.get('/tag/:slug', (req, res) => res.json({
    tag: req.params.slug,
    articles: articleService.listByTag(req.locale, req.params.slug).map(serializeLocalizedArticle)
  }));
  router.get('/taxonomy', (req, res) => res.json(articleService.listTaxonomy(req.locale)));
  router.get('/archive/all', (req, res) => {
    res.json(groupArticlesByMonth(articleService.listArchive(req.locale).map(serializeLocalizedArticle)));
  });
  router.get('/:slug', (req, res) => {
    const article = articleService.getPublishedBySlug(req.locale, req.params.slug);
    if (!article) return res.status(404).json({ error: '文章不存在' });
    return res.json({ ...serializeLocalizedArticle(article), alternate: articleService.alternateFor(article) });
  });

  return router;
}

module.exports = { createArticlesRouter, createLocalizedArticlesRouter };

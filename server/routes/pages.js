const express = require('express');
const fs = require('node:fs');
const path = require('node:path');
const { authenticatePage, optionalAuth } = require('../middleware/auth');
const { renderMarkdown } = require('../utils/markdown');
const { escapeXml, groupArticlesByMonth } = require('../utils/presentation');

function parsePage(value) {
  if (value === undefined) return 1;
  if (typeof value !== 'string' || !/^\d+$/.test(value)) return null;
  const page = Number(value);
  return Number.isSafeInteger(page) && page >= 1 && page <= 1_000_000 ? page : null;
}

function createPagesRouter({ config, articleService, commentsModule }) {
  const router = express.Router();
  const origin = config.site.publicOrigin || `http://localhost:${config.port}`;
  const canonical = pathname => `${origin}${pathname}`;
  const baseSeo = (title, description, pathname, type = 'website') => ({
    title,
    description: description || config.site.description,
    canonical: canonical(pathname),
    type
  });

  router.get('/', optionalAuth, (req, res) => {
    const page = parsePage(req.query.page);
    if (page === null) return res.status(400).send('页码格式无效');
    const result = articleService.listPublished(page, config.pageSize);
    return res.render('index', {
      ...result,
      user: req.user,
      seo: baseSeo(config.site.title, config.site.description, page === 1 ? '/' : `/?page=${page}`)
    });
  });

  router.get('/article/:slug', optionalAuth, (req, res) => {
    const article = articleService.getPublishedBySlug(req.params.slug);
    if (!article) return res.status(404).render('404', { user: req.user, seo: null });
    const comments = commentsModule
      ? commentsModule.getArticleCommentsViewModel(article.id, {
        commenter: req.commenter,
        csrfToken: req.commentSession?.csrfToken || null
      })
      : { enabled: false };
    return res.render('article', {
      article,
      comments,
      navigation: articleService.navigationFor(article),
      relatedArticles: articleService.relatedFor(article),
      user: req.user,
      seo: baseSeo(article.title, article.description, `/article/${encodeURIComponent(article.slug)}`, 'article')
    });
  });

  router.get('/archive', optionalAuth, (req, res) => {
    return res.render('archive', {
      archive: groupArticlesByMonth(articleService.listArchive()),
      user: req.user,
      seo: baseSeo('归档', config.site.description, '/archive')
    });
  });

  router.get('/tags', optionalAuth, (req, res) => res.render('tags', {
    tags: articleService.listTags(),
    user: req.user,
    seo: baseSeo('标签', config.site.description, '/tags')
  }));

  router.get('/tag/:tag', optionalAuth, (req, res) => res.render('tag', {
    tag: req.params.tag,
    articles: articleService.listByTag(req.params.tag),
    user: req.user,
    seo: baseSeo(`标签：${req.params.tag}`, config.site.description, `/tag/${encodeURIComponent(req.params.tag)}`)
  }));

  router.get('/search', optionalAuth, (req, res) => {
    const query = typeof req.query.q === 'string' ? req.query.q.normalize('NFKC').trim() : '';
    if ([...query].length > 100) return res.status(400).send('搜索条件过长');
    return res.render('search', {
      query,
      articles: query ? articleService.search(query) : [],
      user: req.user,
      seo: { ...baseSeo('搜索', config.site.description, '/search'), noindex: true }
    });
  });

  router.get('/about', optionalAuth, (req, res, next) => {
    try {
      const markdown = fs.readFileSync(path.resolve(__dirname, '..', '..', config.aboutPath), 'utf8');
      return res.render('about', {
        aboutHtml: renderMarkdown(markdown),
        user: req.user,
        seo: baseSeo('关于', config.site.description, '/about')
      });
    } catch (error) {
      return next(error);
    }
  });

  router.get('/feed.xml', (req, res) => {
    const articles = articleService.listPublished(1, 50).articles;
    const items = articles.map(article => `
      <item>
        <title>${escapeXml(article.title)}</title>
        <link>${escapeXml(canonical(`/article/${encodeURIComponent(article.slug)}`))}</link>
        <guid isPermaLink="true">${escapeXml(canonical(`/article/${encodeURIComponent(article.slug)}`))}</guid>
        <description>${escapeXml(article.description || '')}</description>
        <pubDate>${new Date(article.created_at).toUTCString()}</pubDate>
      </item>`).join('');
    res.type('application/rss+xml').send(`<?xml version="1.0" encoding="UTF-8"?>
      <rss version="2.0"><channel>
      <title>${escapeXml(config.site.title)}</title>
      <link>${escapeXml(origin)}</link>
      <description>${escapeXml(config.site.description)}</description>${items}
      </channel></rss>`);
  });

  router.get('/sitemap.xml', (req, res) => {
    const articles = articleService.listArchive();
    const staticPaths = ['/', '/archive', '/tags', '/about'];
    const urls = [
      ...staticPaths.map(pathname => ({ loc: canonical(pathname), updated: null })),
      ...articles.map(article => ({
        loc: canonical(`/article/${encodeURIComponent(article.slug)}`),
        updated: article.updated_at || article.created_at
      }))
    ];
    res.type('application/xml').send(`<?xml version="1.0" encoding="UTF-8"?>
      <urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${urls.map(url => `
        <url><loc>${escapeXml(url.loc)}</loc>${url.updated ? `<lastmod>${new Date(url.updated).toISOString()}</lastmod>` : ''}</url>`).join('')}
      </urlset>`);
  });

  router.get('/robots.txt', (req, res) => {
    res.type('text/plain').send(`User-agent: *\nAllow: /\nDisallow: /admin\nDisallow: /api\nSitemap: ${canonical('/sitemap.xml')}\n`);
  });

  router.get('/admin/login', (req, res) => {
    res.set('Cache-Control', 'private, no-store');
    res.render('admin/login');
  });
  router.get('/admin', authenticatePage, (req, res) => res.redirect('/admin/upload'));
  router.get('/admin/upload', authenticatePage, (req, res) => res.render('admin/upload', { user: req.user }));
  router.get('/admin/articles', authenticatePage, (req, res) => res.render('admin/articles', {
    articles: articleService.listAdmin(),
    user: req.user
  }));

  return router;
}

module.exports = { createPagesRouter, parsePage };

const express = require('express');
const fs = require('node:fs');
const path = require('node:path');
const { optionalAuth } = require('../middleware/auth');
const { renderMarkdown } = require('../utils/markdown');
const { escapeXml, groupArticlesByMonth } = require('../utils/presentation');
const { loadTaxonomyCatalog } = require('../taxonomy/catalog');
const { createTranslator } = require('../i18n/messages');
const {
  SUPPORTED_LOCALES,
  DEFAULT_LOCALE,
  isSupportedLocale,
  localeMetadata,
  siteForLocale
} = require('../i18n/config');
const {
  negotiateLocale,
  localizedPath,
  encodePathSegment,
  LOCALE_COOKIE,
  localeCookieOptions
} = require('../i18n/request');

function parsePage(value) {
  if (value === undefined) return 1;
  if (typeof value !== 'string' || !/^\d+$/.test(value)) return null;
  const page = Number(value);
  return Number.isSafeInteger(page) && page >= 1 && page <= 1_000_000 ? page : null;
}

/**
 * The raw query substring of a request, byte-for-byte. Redirects must never
 * rebuild the query through the redirect query object, so the original string
 * is appended directly to the target path.
 */
function rawQuery(req) {
  const queryIndex = req.originalUrl.indexOf('?');
  return queryIndex === -1 ? '' : req.originalUrl.slice(queryIndex);
}

/**
 * Install locale request locals shared by every localized public surface.
 * `res.locals` receives `locale`, `i18n`, `localizedPath`, `localeMeta`,
 * the locale-specific `site`, and safe language-switch data.
 */
function setLocaleLocals(req, res, config, locale) {
  req.locale = locale;
  res.locals.locale = locale;
  res.locals.i18n = createTranslator(locale);
  res.locals.localizedPath = pathname => localizedPath(locale, pathname);
  res.locals.localeMeta = localeMetadata(locale);
  res.locals.site = siteForLocale(config, locale);
  res.locals.availableLocales = SUPPORTED_LOCALES;
  res.locals.languageSwitch = Object.freeze(
    SUPPORTED_LOCALES.map(candidate => ({
      locale: candidate,
      path: localizedPath(candidate, req.originalUrl)
    }))
  );
  return res;
}

/**
 * Render a localized 404. Locale locals set by an outer locale middleware are
 * preserved; otherwise the default locale is installed so the page is always
 * localized with the right `html lang` and messages.
 */
function renderNotFound(req, res, config, status = 404) {
  if (!isSupportedLocale(req.locale)) {
    setLocaleLocals(req, res, config, DEFAULT_LOCALE);
  }
  return res.status(status).render('404', { user: req.user || null, seo: null });
}

/**
 * Root locale negotiation: `GET /` chooses the locale from the
 * `blog_locale` cookie first, then `Accept-Language`, then the zh default,
 * and 302s to the strict localized home. The raw query is preserved
 * byte-for-byte. Only this router varies by `Cookie, Accept-Language`;
 * localized pages never do.
 */
function createRootNegotiatorRouter() {
  const router = express.Router();
  router.get('/', (req, res) => {
    const locale = negotiateLocale({
      cookieLocale: req.cookies && req.cookies[LOCALE_COOKIE],
      acceptLanguage: req.headers['accept-language']
    });
    res.set('Vary', 'Cookie, Accept-Language');
    return res.redirect(302, `/${locale}/${req.originalUrl.slice(1)}`);
  });
  return router;
}

/**
 * Slash canonicalizers for the two supported locales: `GET /zh` -> 308 `/zh/`
 * and `GET /en` -> 308 `/en/`, preserving the raw query. Requests that
 * already carry the trailing slash pass through to the strict locale router.
 */
function createSlashCanonicalizerRouter(locale) {
  const router = express.Router();
  const mountPath = `/${locale}`;
  router.get('/', (req, res, next) => {
    const pathname = req.originalUrl.split('?')[0];
    if (pathname !== mountPath) return next();
    return res.redirect(308, `${mountPath}/${rawQuery(req)}`);
  });
  return router;
}

/**
 * Resolve a legacy tag string against the Chinese taxonomy labels and legacy
 * names. The returned slug is the stored raw zh label slug (re-encoded later),
 * never a blind echo of the incoming display string.
 */
function resolveLegacyTagSlug(catalog, rawTag) {
  const normalized = String(rawTag || '').normalize('NFKC').trim();
  if (!normalized) return null;
  for (const category of catalog.categories) {
    for (const tag of category.tags) {
      const zhLabel = tag.labels.zh;
      for (const candidate of [zhLabel.name, zhLabel.slug, ...(tag.legacyNames || [])]) {
        if (candidate.normalize('NFKC') === normalized) return zhLabel.slug;
      }
    }
  }
  return null;
}

/**
 * Find a taxonomy tag for the current locale by display name or stored slug
 * (plus zh legacy names for the zh surface), so old name-based links keep
 * working on localized tag pages.
 */
function findLocalizedTaxonomyTag(catalog, locale, value) {
  const normalized = String(value || '').normalize('NFKC').trim();
  if (!normalized) return null;
  for (const category of catalog.categories) {
    for (const tag of category.tags) {
      const label = tag.labels[locale];
      const candidates = locale === DEFAULT_LOCALE
        ? [label.name, label.slug, ...(tag.legacyNames || [])]
        : [label.name, label.slug];
      for (const candidate of candidates) {
        if (candidate.normalize('NFKC') === normalized) return tag;
      }
    }
  }
  return null;
}

/**
 * Permanent 301s for the pre-i18n public paths. The raw query is appended
 * byte-for-byte. Unknown legacy tags render a localized 404 instead of
 * creating an open redirect. Mounted before the analytics collector so no
 * redirect hop can be counted.
 */
function createLegacyRedirectRouter({ config }) {
  const router = express.Router();
  const taxonomyPath = path.resolve(__dirname, '..', '..', config.taxonomyPath);
  let catalog = null;
  function ensureCatalog() {
    if (catalog === null) catalog = loadTaxonomyCatalog(taxonomyPath);
    return catalog;
  }

  router.get('/article/:slug', (req, res) => {
    return res.redirect(301, `/zh/article/${encodePathSegment(req.params.slug)}${rawQuery(req)}`);
  });
  router.get('/archive', (req, res) => res.redirect(301, `/zh/archive${rawQuery(req)}`));
  router.get('/tags', (req, res) => res.redirect(301, `/zh/tags${rawQuery(req)}`));
  router.get('/tag/:tag', (req, res) => {
    const slug = resolveLegacyTagSlug(ensureCatalog(), req.params.tag);
    if (!slug) return renderNotFound(req, res, config);
    return res.redirect(301, `/zh/tag/${encodePathSegment(slug)}${rawQuery(req)}`);
  });
  router.get('/search', (req, res) => res.redirect(301, `/zh/search${rawQuery(req)}`));
  router.get('/about', (req, res) => res.redirect(301, `/zh/about${rawQuery(req)}`));
  router.get('/feed.xml', (req, res) => res.redirect(301, `/zh/feed.xml${rawQuery(req)}`));

  return router;
}

/**
 * Root-level machine endpoints that must not be captured by the strict
 * `/:locale` router. The sitemap lists default-locale URLs so every entry
 * resolves without a redirect hop.
 */
function createRootMetadataRouter({ config, articleService }) {
  const router = express.Router();
  const origin = config.site.publicOrigin || `http://localhost:${config.port}`;
  const canonical = pathname => `${origin}${pathname}`;
  const localePath = pathname => `/${DEFAULT_LOCALE}${pathname === '/' ? '/' : pathname}`;

  router.get('/sitemap.xml', (req, res) => {
    const articles = articleService.listArchive(DEFAULT_LOCALE);
    const staticPaths = ['/', '/archive', '/tags', '/about'].map(localePath);
    const urls = [
      ...staticPaths.map(pathname => ({ loc: canonical(pathname), updated: null })),
      ...articles.map(article => ({
        loc: canonical(`/${DEFAULT_LOCALE}/article/${encodeURIComponent(article.slug)}`),
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

  return router;
}

/**
 * The strict localized public router mounted under `/:locale`. The middleware
 * validates the route segment against the two-item allowlist, installs the
 * locale request locals, and writes the one-year locale cookie. Unsupported
 * locale-like paths return the generic localized 404 directly, so they can
 * never reach the article slug routes.
 */
function createLocalizedPagesRouter({ config, articleService, commentsModule }) {
  const router = express.Router();
  const taxonomyPath = path.resolve(__dirname, '..', '..', config.taxonomyPath);
  let catalog = null;
  function ensureCatalog() {
    if (catalog === null) catalog = loadTaxonomyCatalog(taxonomyPath);
    return catalog;
  }
  const origin = config.site.publicOrigin || `http://localhost:${config.port}`;
  const canonical = pathname => `${origin}${pathname}`;

  router.use((req, res, next) => {
    // Express 5 does not populate req.params from a `/:locale` mount path,
    // so the locale is taken from the mount base instead.
    const locale = typeof req.baseUrl === 'string' && req.baseUrl.startsWith('/')
      ? req.baseUrl.slice(1)
      : '';
    // Unsupported locale-like paths return the generic localized 404 right
    // here so they can never fall through to the router's article slug routes.
    if (!isSupportedLocale(locale)) {
      return renderNotFound(req, res, config);
    }
    setLocaleLocals(req, res, config, locale);
    res.cookie(LOCALE_COOKIE, locale, localeCookieOptions(config.secureCookies));
    next();
  });

  function baseSeo(req, res, title, description, pathname, type = 'website') {
    return {
      title,
      description: description || res.locals.site.description,
      canonical: canonical(pathname),
      type
    };
  }

  router.get('/', optionalAuth, (req, res) => {
    const locale = res.locals.locale;
    const page = parsePage(req.query.page);
    if (page === null) {
      return res.status(400).type('text/plain')
        .send(locale === 'en' ? 'Invalid page format' : '页码格式无效');
    }
    const result = articleService.listPublished(locale, page, config.pageSize);
    // Locale page 1 stays 200 even with zero posts; any page beyond
    // max(1, totalPages) is a localized 404.
    if (page > Math.max(1, result.totalPages)) {
      return renderNotFound(req, res, config);
    }
    return res.render('index', {
      ...result,
      user: req.user,
      seo: baseSeo(req, res, res.locals.site.title, res.locals.site.description,
        page === 1 ? `/${locale}/` : `/${locale}/?page=${page}`)
    });
  });

  router.get('/article/:slug', optionalAuth, (req, res) => {
    const article = articleService.getPublishedBySlug(res.locals.locale, req.params.slug);
    if (!article) return renderNotFound(req, res, config);
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
      seo: baseSeo(req, res, article.title, article.description,
        `/${res.locals.locale}/article/${encodeURIComponent(article.slug)}`, 'article')
    });
  });

  router.get('/archive', optionalAuth, (req, res) => res.render('archive', {
    archive: groupArticlesByMonth(articleService.listArchive(res.locals.locale)),
    user: req.user,
    seo: baseSeo(req, res, res.locals.i18n('archive.title'), null, `/${res.locals.locale}/archive`)
  }));

  router.get('/tags', optionalAuth, (req, res) => {
    const locale = res.locals.locale;
    const tags = articleService.listTaxonomy(locale).tags.map(tag => ({ name: tag.name, count: tag.count }));
    return res.render('tags', {
      tags,
      user: req.user,
      seo: baseSeo(req, res, res.locals.i18n('tags.title'), null, `/${locale}/tags`)
    });
  });

  router.get('/tag/:tag', optionalAuth, (req, res) => {
    const locale = res.locals.locale;
    const tag = findLocalizedTaxonomyTag(ensureCatalog(), locale, req.params.tag);
    if (!tag) return renderNotFound(req, res, config);
    const label = tag.labels[locale];
    return res.render('tag', {
      tag: label.name,
      articles: articleService.listByTag(locale, label.slug),
      user: req.user,
      seo: baseSeo(req, res, res.locals.i18n('tags.tagTitle', { tag: label.name }), null,
        `/${locale}/tag/${encodePathSegment(label.slug)}`)
    });
  });

  router.get('/search', optionalAuth, (req, res) => {
    const query = typeof req.query.q === 'string' ? req.query.q.normalize('NFKC').trim() : '';
    if ([...query].length > 100) {
      return res.status(400).type('text/plain')
        .send(res.locals.locale === 'en' ? 'Search query too long' : '搜索条件过长');
    }
    return res.render('search', {
      query,
      articles: query ? articleService.search(res.locals.locale, query) : [],
      user: req.user,
      seo: { ...baseSeo(req, res, res.locals.i18n('search.title'), null, `/${res.locals.locale}/search`), noindex: true }
    });
  });

  router.get('/about', optionalAuth, (req, res, next) => {
    const locale = res.locals.locale;
    try {
      const markdown = fs.readFileSync(path.resolve(__dirname, '..', '..', config.aboutPaths[locale]), 'utf8');
      return res.render('about', {
        aboutHtml: renderMarkdown(markdown, { locale }),
        title: res.locals.i18n('about.title'),
        user: req.user,
        seo: baseSeo(req, res, res.locals.i18n('about.title'), null, `/${locale}/about`)
      });
    } catch (error) {
      return next(error);
    }
  });

  router.get('/feed.xml', (req, res) => {
    const locale = res.locals.locale;
    const site = res.locals.site;
    const articles = articleService.listPublished(locale, 1, 50).articles;
    const items = articles.map(article => `
      <item>
        <title>${escapeXml(article.title)}</title>
        <link>${escapeXml(canonical(`/${locale}/article/${encodeURIComponent(article.slug)}`))}</link>
        <guid isPermaLink="true">${escapeXml(canonical(`/${locale}/article/${encodeURIComponent(article.slug)}`))}</guid>
        <description>${escapeXml(article.description || '')}</description>
        <pubDate>${new Date(article.created_at).toUTCString()}</pubDate>
      </item>`).join('');
    res.type('application/rss+xml').send(`<?xml version="1.0" encoding="UTF-8"?>
      <rss version="2.0"><channel>
      <title>${escapeXml(site.title)}</title>
      <link>${escapeXml(canonical(`/${locale}/`))}</link>
      <description>${escapeXml(site.description)}</description>${items}
      </channel></rss>`);
  });

  return router;
}

module.exports = {
  createRootMetadataRouter,
  createRootNegotiatorRouter,
  createSlashCanonicalizerRouter,
  createLegacyRedirectRouter,
  createLocalizedPagesRouter,
  renderNotFound,
  setLocaleLocals,
  parsePage
};

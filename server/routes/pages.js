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

const otherLocaleOf = locale => (locale === 'zh' ? 'en' : 'zh');

/**
 * Push one hreflang alternate onto a `baseSeo` object. `href` must be the
 * absolute self-origin URL of the target locale page, present only when that
 * locale endpoint actually exists.
 */
function addAlternate(seo, hreflang, href) {
  seo.alternates.push({ hreflang, href });
}

/**
 * Derive `og:locale:alternate` values from the existing hreflang alternates
 * (never from locales whose endpoint does not exist).
 */
function finalizeOgLocaleAlternates(seo, localeMetadata) {
  const alternates = seo.alternates
    .filter(alternate => alternate.hreflang !== seo.locale)
    .map(alternate => localeMetadata(alternate.hreflang).ogLocale);
  if (alternates.length > 0) seo.ogLocaleAlternates = alternates;
  return seo;
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
 * `/:locale` router. The multilingual sitemap lists both locales' published
 * static/article/taxonomy URLs with reciprocal `xhtml:link` alternates, so
 * every entry resolves without a redirect hop and never points at a locale
 * endpoint that does not exist.
 */
function createRootMetadataRouter({ config, articleService }) {
  const router = express.Router();
  const origin = config.site.publicOrigin || `http://localhost:${config.port}`;
  const canonical = pathname => `${origin}${pathname}`;

  router.get('/sitemap.xml', (req, res) => {
    const groups = [];
    const seen = new Set();
    const rendered = [];

    // Unpaginated static pages always exist in both locales.
    for (const pathname of ['/', '/archive', '/tags', '/about']) {
      groups.push(SUPPORTED_LOCALES.map(locale => ({
        locale,
        url: canonical(localizedPath(locale, pathname)),
        lastmod: null
      })));
    }

    // Published articles grouped by logical post; only published siblings
    // ever pair up as reciprocal alternates.
    const articlesByPost = new Map();
    for (const locale of SUPPORTED_LOCALES) {
      for (const article of articleService.listArchive(locale)) {
        if (!articlesByPost.has(article.post_id)) articlesByPost.set(article.post_id, []);
        articlesByPost.get(article.post_id).push({
          locale,
          url: canonical(`/${locale}/article/${encodePathSegment(article.slug)}`),
          lastmod: article.updated_at || article.created_at
        });
      }
    }
    for (const locales of articlesByPost.values()) groups.push(locales);

    // Taxonomy pages with published counts, grouped by stable id so localized
    // label slugs pair up across locales.
    for (const kind of ['tags', 'categories']) {
      const byId = new Map();
      const pathName = kind === 'tags' ? 'tag' : 'category';
      for (const locale of SUPPORTED_LOCALES) {
        for (const entry of articleService.listTaxonomy(locale)[kind]) {
          if (entry.count === 0) continue;
          if (!byId.has(entry.id)) byId.set(entry.id, []);
          byId.get(entry.id).push({
            locale,
            url: canonical(`/${locale}/${pathName}/${encodePathSegment(entry.slug)}`),
            lastmod: null
          });
        }
      }
      for (const locales of byId.values()) groups.push(locales);
    }

    for (const locales of groups) {
      for (const entry of locales) {
        if (seen.has(entry.url)) continue;
        seen.add(entry.url);
        const links = locales.map(target =>
          `<xhtml:link rel="alternate" hreflang="${target.locale}" href="${escapeXml(target.url)}"/>`
        );
        links.push(`<xhtml:link rel="alternate" hreflang="x-default" href="${escapeXml(canonical('/'))}"/>`);
        rendered.push(
          '<url>\n' +
          `  <loc>${escapeXml(entry.url)}</loc>\n` +
          (entry.lastmod ? `  <lastmod>${new Date(entry.lastmod).toISOString()}</lastmod>\n` : '') +
          links.map(link => `  ${link}`).join('\n') +
          '\n</url>'
        );
      }
    }

    res.type('application/xml').send(
      '<?xml version="1.0" encoding="UTF-8"?>\n' +
      '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" ' +
      'xmlns:xhtml="http://www.w3.org/1999/xhtml">\n' +
      `${rendered.join('\n')}\n</urlset>`
    );
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
      type,
      locale: res.locals.locale,
      ogLocale: res.locals.localeMeta.ogLocale,
      alternates: [],
      xDefault: canonical('/')
    };
  }

  /**
   * Rebuild the language switch from the resolved hreflang alternates so a
   * switch target is only offered when the target locale endpoint actually
   * exists (pagination pages, article siblings, taxonomy endpoints).
   */
  function syncLanguageSwitch(res, seo) {
    res.locals.languageSwitch = Object.freeze(
      seo.alternates.map(alternate => ({
        locale: alternate.hreflang,
        path: alternate.href.slice(origin.length)
      }))
    );
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
    // A target-locale alternate/switch URL exists only when that locale also
    // has page N under the same explicit pagination contract. The other-locale
    // query must use the real config.pageSize so totalPages reflects the
    // locale's actual page count (page size 1 would overcount and advertise
    // dead hreflang/switch targets).
    const other = otherLocaleOf(locale);
    const otherResult = articleService.listPublished(other, 1, config.pageSize);
    const otherHasPage = page <= Math.max(1, otherResult.totalPages);
    const homePath = target => (page === 1 ? `/${target}/` : `/${target}/?page=${page}`);
    const seo = baseSeo(req, res, res.locals.site.title, res.locals.site.description, homePath(locale));
    addAlternate(seo, locale, canonical(homePath(locale)));
    if (otherHasPage) addAlternate(seo, other, canonical(homePath(other)));
    syncLanguageSwitch(res, seo);
    return res.render('index', {
      ...result,
      user: req.user,
      seo: finalizeOgLocaleAlternates(seo, localeMetadata)
    });
  });

  router.get('/article/:slug', optionalAuth, (req, res) => {
    const locale = res.locals.locale;
    const article = articleService.getPublishedBySlug(locale, req.params.slug);
    if (!article) return renderNotFound(req, res, config);
    const comments = commentsModule
      ? commentsModule.getArticleCommentsViewModel(article.id, {
        commenter: req.commenter,
        csrfToken: req.commentSession?.csrfToken || null
      })
      : { enabled: false };
    const articlePath = `/${locale}/article/${encodePathSegment(article.slug)}`;
    const seo = baseSeo(req, res, article.title, article.description, articlePath, 'article');
    addAlternate(seo, locale, canonical(articlePath));
    // Article alternates come only from published sibling translations.
    const alternate = articleService.alternateFor(article);
    if (alternate) {
      addAlternate(seo, alternate.locale,
        canonical(`/${alternate.locale}/article/${encodePathSegment(alternate.slug)}`));
    }
    syncLanguageSwitch(res, seo);
    return res.render('article', {
      article,
      comments,
      navigation: articleService.navigationFor(article),
      relatedArticles: articleService.relatedFor(article),
      user: req.user,
      seo: finalizeOgLocaleAlternates(seo, localeMetadata)
    });
  });

  router.get('/archive', optionalAuth, (req, res) => {
    const locale = res.locals.locale;
    const pathname = `/${locale}/archive`;
    const seo = baseSeo(req, res, res.locals.i18n('archive.title'), null, pathname);
    for (const candidate of SUPPORTED_LOCALES) {
      addAlternate(seo, candidate, canonical(localizedPath(candidate, pathname)));
    }
    return res.render('archive', {
      archive: groupArticlesByMonth(articleService.listArchive(locale)),
      user: req.user,
      seo: finalizeOgLocaleAlternates(seo, localeMetadata)
    });
  });

  router.get('/tags', optionalAuth, (req, res) => {
    const locale = res.locals.locale;
    const pathname = `/${locale}/tags`;
    const seo = baseSeo(req, res, res.locals.i18n('tags.title'), null, pathname);
    for (const candidate of SUPPORTED_LOCALES) {
      addAlternate(seo, candidate, canonical(localizedPath(candidate, pathname)));
    }
    const tags = articleService.listTaxonomy(locale).tags.map(tag => ({ name: tag.name, count: tag.count }));
    return res.render('tags', {
      tags,
      user: req.user,
      seo: finalizeOgLocaleAlternates(seo, localeMetadata)
    });
  });

  router.get('/tag/:tag', optionalAuth, (req, res) => {
    const locale = res.locals.locale;
    const tag = findLocalizedTaxonomyTag(ensureCatalog(), locale, req.params.tag);
    if (!tag) return renderNotFound(req, res, config);
    const label = tag.labels[locale];
    const tagPath = `/${locale}/tag/${encodePathSegment(label.slug)}`;
    const seo = baseSeo(req, res, res.locals.i18n('tags.tagTitle', { tag: label.name }), null, tagPath);
    addAlternate(seo, locale, canonical(tagPath));
    // The target-locale tag alternate only exists when that locale has
    // published articles under its own label slug.
    const other = otherLocaleOf(locale);
    const otherLabel = tag.labels[other];
    if (articleService.listByTag(other, otherLabel.slug).length > 0) {
      addAlternate(seo, other, canonical(`/${other}/tag/${encodePathSegment(otherLabel.slug)}`));
    }
    syncLanguageSwitch(res, seo);
    return res.render('tag', {
      tag: label.name,
      articles: articleService.listByTag(locale, label.slug),
      user: req.user,
      seo: finalizeOgLocaleAlternates(seo, localeMetadata)
    });
  });

  // Localized category pages resolve only real published endpoints, so
  // category alternates and sitemap entries never point at empty pages.
  router.get('/category/:slug', optionalAuth, (req, res) => {
    const locale = res.locals.locale;
    const category = articleService.listTaxonomy(locale).categories
      .find(candidate => candidate.slug === req.params.slug);
    if (!category || category.count === 0) return renderNotFound(req, res, config);
    const categoryPath = `/${locale}/category/${encodePathSegment(category.slug)}`;
    const seo = baseSeo(req, res, res.locals.i18n('categories.title'), null, categoryPath);
    addAlternate(seo, locale, canonical(categoryPath));
    const other = otherLocaleOf(locale);
    const otherCategory = articleService.listTaxonomy(other).categories
      .find(candidate => candidate.id === category.id);
    if (otherCategory && otherCategory.count > 0) {
      addAlternate(seo, other, canonical(`/${other}/category/${encodePathSegment(otherCategory.slug)}`));
    }
    syncLanguageSwitch(res, seo);
    return res.render('category', {
      category,
      articles: articleService.listByCategory(locale, category.slug),
      user: req.user,
      seo: finalizeOgLocaleAlternates(seo, localeMetadata)
    });
  });

  router.get('/search', optionalAuth, (req, res) => {
    const query = typeof req.query.q === 'string' ? req.query.q.normalize('NFKC').trim() : '';
    if ([...query].length > 100) {
      return res.status(400).type('text/plain')
        .send(res.locals.locale === 'en' ? 'Search query too long' : '搜索条件过长');
    }
    const seo = finalizeOgLocaleAlternates(
      baseSeo(req, res, res.locals.i18n('search.title'), null, `/${res.locals.locale}/search`),
      localeMetadata
    );
    return res.render('search', {
      query,
      articles: query ? articleService.search(res.locals.locale, query) : [],
      user: req.user,
      seo: { ...seo, noindex: true }
    });
  });

  router.get('/about', optionalAuth, (req, res, next) => {
    const locale = res.locals.locale;
    try {
      const markdown = fs.readFileSync(path.resolve(__dirname, '..', '..', config.aboutPaths[locale]), 'utf8');
      const pathname = `/${locale}/about`;
      const seo = baseSeo(req, res, res.locals.i18n('about.title'), null, pathname);
      for (const candidate of SUPPORTED_LOCALES) {
        addAlternate(seo, candidate, canonical(localizedPath(candidate, pathname)));
      }
      return res.render('about', {
        aboutHtml: renderMarkdown(markdown, { locale }),
        title: res.locals.i18n('about.title'),
        user: req.user,
        seo: finalizeOgLocaleAlternates(seo, localeMetadata)
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
        <link>${escapeXml(canonical(`/${locale}/article/${encodePathSegment(article.slug)}`))}</link>
        <guid isPermaLink="true">${escapeXml(canonical(`/${locale}/article/${encodePathSegment(article.slug)}`))}</guid>
        <description>${escapeXml(article.description || '')}</description>
        <pubDate>${new Date(article.created_at).toUTCString()}</pubDate>
      </item>`).join('');
    res.type('application/rss+xml').send(`<?xml version="1.0" encoding="UTF-8"?>
      <rss version="2.0"><channel>
      <title>${escapeXml(site.title)}</title>
      <link>${escapeXml(canonical(`/${locale}/`))}</link>
      <description>${escapeXml(site.description)}</description>
      <language>${escapeXml(res.locals.localeMeta.rssLanguage)}</language>${items}
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

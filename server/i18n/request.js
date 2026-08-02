const { SUPPORTED_LOCALES, DEFAULT_LOCALE, isSupportedLocale } = require('./config');
const { validateSegment } = require('../taxonomy/catalog');

const QUALITY_PATTERN = /^q\s*=\s*([0-9]*\.?[0-9]+)$/;

// The public locale preference cookie: one year, HttpOnly, SameSite=Lax,
// Path=/, and Secure in production. It is only written by strict localized
// routes; root negotiation never sets it.
const LOCALE_COOKIE = 'blog_locale';
const LOCALE_COOKIE_MAX_AGE_MS = 365 * 24 * 60 * 60 * 1000;

function localeCookieOptions(secure = false) {
  return {
    httpOnly: true,
    sameSite: 'lax',
    path: '/',
    secure: Boolean(secure),
    maxAge: LOCALE_COOKIE_MAX_AGE_MS
  };
}

function parseAcceptLanguageHeader(header) {
  if (typeof header !== 'string' || header.trim() === '') return [];
  const accepted = [];
  for (const rawPart of header.split(',')) {
    const part = rawPart.trim();
    if (part === '') continue;
    const [rangePart, ...parameters] = part.split(';');
    const range = rangePart.trim().toLowerCase();
    if (range === '' || range === '*') continue;
    let quality = 1;
    let wellFormed = true;
    for (const parameter of parameters) {
      const match = QUALITY_PATTERN.exec(parameter.trim());
      if (!match) {
        wellFormed = false;
        break;
      }
      quality = Number(match[1]);
      if (!Number.isFinite(quality) || quality < 0 || quality > 1) {
        wellFormed = false;
        break;
      }
    }
    if (!wellFormed || quality <= 0) continue;
    const primary = range.split('-')[0].trim();
    if (primary === 'en') {
      accepted.push({ locale: 'en', quality });
    } else if (primary === 'zh') {
      accepted.push({ locale: 'zh', quality });
    }
  }
  accepted.sort((a, b) => b.quality - a.quality);
  return accepted.map(entry => entry.locale);
}

/**
 * @param {{ cookieLocale?: string, acceptLanguage?: string }} [options]
 */
function negotiateLocale({ cookieLocale, acceptLanguage } = {}) {
  if (isSupportedLocale(cookieLocale)) return cookieLocale;
  const accepted = parseAcceptLanguageHeader(acceptLanguage);
  return accepted[0] || DEFAULT_LOCALE;
}

function localizedPath(locale, pathname) {
  if (!isSupportedLocale(locale)) {
    throw new Error(`unsupported locale: ${locale}`);
  }
  if (typeof pathname !== 'string' || !pathname.startsWith('/')) {
    throw new Error('localizedPath requires an absolute application path');
  }
  const queryIndex = pathname.indexOf('?');
  const hashIndex = pathname.indexOf('#');
  const suffixIndex = [queryIndex, hashIndex]
    .filter(index => index !== -1)
    .reduce((min, index) => (min === -1 ? index : Math.min(min, index)), -1);
  const raw = suffixIndex === -1 ? pathname : pathname.slice(0, suffixIndex);
  const suffix = suffixIndex === -1 ? '' : pathname.slice(suffixIndex);

  const segments = raw.split('/');
  if (segments.length > 1 && isSupportedLocale(segments[1])) {
    segments.splice(1, 1);
  }
  const path = segments.join('/') || '/';
  if (path === '/') {
    return `/${locale}/${suffix}`;
  }
  return `/${locale}${path}${suffix}`;
}

function encodePathSegment(rawSlug) {
  validateSegment(rawSlug, 'slug');
  return encodeURIComponent(rawSlug);
}

module.exports = {
  SUPPORTED_LOCALES,
  DEFAULT_LOCALE,
  LOCALE_COOKIE,
  parseAcceptLanguageHeader,
  negotiateLocale,
  localizedPath,
  encodePathSegment,
  localeCookieOptions
};

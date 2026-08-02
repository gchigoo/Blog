const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { SUPPORTED_LOCALES } = require('../i18n/config');

const PUBLIC_ROOT = path.resolve(__dirname, '..', '..', 'public');
const assetVersions = new Map();
const dateFormatters = new Map();
// Locale-aware formatters are cached by JSON.stringify({ locale, timeZone,
// options }) so zh and en never share a cached Intl.DateTimeFormat instance.
const localizedDateFormatters = new Map();
const archiveDateFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Shanghai',
  year: 'numeric',
  month: 'numeric'
});
const yearFormatter = new Intl.DateTimeFormat('zh-CN', {
  timeZone: 'Asia/Shanghai',
  year: 'numeric'
});

function assertSupportedLocale(locale) {
  if (!SUPPORTED_LOCALES.includes(locale)) {
    throw new Error(`unsupported locale: ${locale}`);
  }
}

function getLocalizedDateFormatter(locale, options = {}) {
  const key = JSON.stringify({ locale, timeZone: 'Asia/Shanghai', options });
  let formatter = localizedDateFormatters.get(key);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat(locale, { timeZone: 'Asia/Shanghai', ...options });
    localizedDateFormatters.set(key, formatter);
  }
  return formatter;
}

function assetUrl(publicPath) {
  if (typeof publicPath !== 'string' || !publicPath.startsWith('/') || publicPath.includes('..')) {
    throw new TypeError('asset path must be an absolute public path');
  }
  let version = assetVersions.get(publicPath);
  if (!version) {
    const filePath = path.resolve(PUBLIC_ROOT, `.${publicPath}`);
    if (!filePath.startsWith(`${PUBLIC_ROOT}${path.sep}`)) throw new TypeError('invalid asset path');
    version = crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex').slice(0, 12);
    assetVersions.set(publicPath, version);
  }
  return `${publicPath}?v=${version}`;
}

function formatDate(value, options = {}) {
  const key = JSON.stringify(options);
  let formatter = dateFormatters.get(key);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('zh-CN', {
      timeZone: 'Asia/Shanghai',
      ...options
    });
    dateFormatters.set(key, formatter);
  }
  return formatter.format(new Date(value));
}

function formatYear(value) {
  return yearFormatter.formatToParts(new Date(value)).find(part => part.type === 'year').value;
}

/**
 * Locale-aware date formatting on the fixed Asia/Shanghai calendar. The cache
 * key covers locale, timezone, and options so cross-locale formatter reuse is
 * impossible. `formatDate`/`formatYear` remain the Chinese/Beijing
 * compatibility helpers for admin views and operational scripts.
 */
function formatLocalizedDate(value, locale, options = {}) {
  assertSupportedLocale(locale);
  return getLocalizedDateFormatter(locale, options).format(new Date(value));
}

/**
 * Localized month name (1-12) resolved through Intl.DateTimeFormat instead of
 * a hard-coded Chinese array.
 */
function formatLocalizedMonth(monthNumber, locale) {
  assertSupportedLocale(locale);
  if (!Number.isInteger(monthNumber) || monthNumber < 1 || monthNumber > 12) {
    throw new Error('month number must be an integer between 1 and 12');
  }
  const formatter = getLocalizedDateFormatter(locale, { month: 'long' });
  // Noon UTC on the 15th is unambiguous for every timezone.
  return formatter.format(new Date(Date.UTC(2000, monthNumber - 1, 15, 12)));
}

function formatLocalizedYear(value, locale) {
  assertSupportedLocale(locale);
  return getLocalizedDateFormatter(locale, { year: 'numeric' }).format(new Date(value));
}

function groupArticlesByMonth(articles) {
  const archive = {};
  for (const article of articles) {
    const parts = archiveDateFormatter.formatToParts(new Date(article.created_at));
    const year = parts.find(part => part.type === 'year').value;
    const month = String(Number(parts.find(part => part.type === 'month').value));
    archive[year] ||= {};
    archive[year][month] ||= [];
    archive[year][month].push(article);
  }
  return archive;
}

function escapeXml(value) {
  return String(value ?? '').replace(/[<>&"']/g, character => ({
    '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;'
  })[character]);
}

module.exports = {
  assetUrl,
  escapeXml,
  formatDate,
  formatLocalizedDate,
  formatLocalizedMonth,
  formatLocalizedYear,
  formatYear,
  groupArticlesByMonth
};

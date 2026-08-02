const SUPPORTED_LOCALES = Object.freeze(['zh', 'en']);
const DEFAULT_LOCALE = 'zh';

const LOCALE_METADATA = Object.freeze({
  zh: Object.freeze({ htmlLang: 'zh-CN', ogLocale: 'zh_CN', rssLanguage: 'zh-CN' }),
  en: Object.freeze({ htmlLang: 'en', ogLocale: 'en_US', rssLanguage: 'en' })
});

function isSupportedLocale(value) {
  return typeof value === 'string' && SUPPORTED_LOCALES.includes(value);
}

function assertSupportedLocale(locale) {
  if (!isSupportedLocale(locale)) {
    throw new Error(`unsupported locale: ${locale}`);
  }
  return locale;
}

function localeMetadata(locale) {
  assertSupportedLocale(locale);
  return LOCALE_METADATA[locale];
}

function siteForLocale(config, locale) {
  assertSupportedLocale(locale);
  const localized = config && config.siteLocales && config.siteLocales[locale];
  if (!localized) {
    throw new Error(`missing localized site configuration for ${locale}`);
  }
  return localized;
}

module.exports = {
  SUPPORTED_LOCALES,
  DEFAULT_LOCALE,
  LOCALE_METADATA,
  isSupportedLocale,
  assertSupportedLocale,
  localeMetadata,
  siteForLocale
};

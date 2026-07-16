const COMMENT_CONFIG_KEYS = [
  'GOOGLE_CLIENT_ID',
  'GOOGLE_CLIENT_SECRET',
  'GOOGLE_REDIRECT_URI',
  'COMMENT_SESSION_SECRET'
];

function trimSetting(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function parseCommentsConfig(env = process.env) {
  const values = Object.fromEntries(
    COMMENT_CONFIG_KEYS.map(key => [key, trimSetting(env[key])])
  );
  const configuredCount = COMMENT_CONFIG_KEYS.filter(key => values[key]).length;

  if (configuredCount === 0) {
    return { enabled: false };
  }

  const errors = [];
  for (const key of COMMENT_CONFIG_KEYS) {
    if (!values[key]) errors.push(`${key} is required`);
  }

  let redirectUrl;
  if (values.GOOGLE_REDIRECT_URI) {
    try {
      redirectUrl = new URL(values.GOOGLE_REDIRECT_URI);
    } catch {
      errors.push('GOOGLE_REDIRECT_URI must be an absolute URL');
    }
  }

  if (redirectUrl) {
    if (redirectUrl.username || redirectUrl.password) {
      errors.push('GOOGLE_REDIRECT_URI must not contain credentials');
    }
    if (redirectUrl.search) {
      errors.push('GOOGLE_REDIRECT_URI must not contain a query');
    }
    if (redirectUrl.hash) {
      errors.push('GOOGLE_REDIRECT_URI must not contain a fragment');
    }
    if (redirectUrl.pathname !== '/auth/google/callback') {
      errors.push('GOOGLE_REDIRECT_URI path must be /auth/google/callback');
    }

    const isHttps = redirectUrl.protocol === 'https:';
    const isLocalHttp = redirectUrl.protocol === 'http:'
      && ['localhost', '127.0.0.1'].includes(redirectUrl.hostname);
    const isProduction = trimSetting(env.NODE_ENV) === 'production';

    if ((isProduction && !isHttps) || (!isProduction && !isHttps && !isLocalHttp)) {
      errors.push('GOOGLE_REDIRECT_URI must use HTTPS except for local development');
    }
  }

  if (values.COMMENT_SESSION_SECRET
    && Buffer.byteLength(values.COMMENT_SESSION_SECRET, 'utf8') < 32) {
    errors.push('COMMENT_SESSION_SECRET must be at least 32 UTF-8 bytes');
  }

  if (errors.length > 0) {
    throw new Error(`Invalid comments configuration: ${errors.join('; ')}`);
  }

  return Object.freeze({
    enabled: true,
    googleClientId: values.GOOGLE_CLIENT_ID,
    googleClientSecret: values.GOOGLE_CLIENT_SECRET,
    googleRedirectUri: values.GOOGLE_REDIRECT_URI,
    sessionSecret: values.COMMENT_SESSION_SECRET,
    secureCookies: trimSetting(env.NODE_ENV) === 'production'
  });
}

module.exports = {
  COMMENT_CONFIG_KEYS,
  parseCommentsConfig
};

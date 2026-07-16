const { OAuth2Client } = require('google-auth-library');

const NETWORK_ERROR_CODES = new Set([
  'ECONNABORTED',
  'ECONNREFUSED',
  'ECONNRESET',
  'EAI_AGAIN',
  'ENOTFOUND',
  'ENETUNREACH',
  'ETIMEDOUT'
]);

function isTemporaryProviderError(error) {
  const status = Number(error?.response?.status);
  return status >= 500
    || NETWORK_ERROR_CODES.has(error?.code)
    || NETWORK_ERROR_CODES.has(error?.cause?.code);
}

class GoogleIdentityError extends Error {
  constructor(code, options = {}) {
    super(code, options);
    this.name = 'GoogleIdentityError';
    this.code = code;
  }
}

function classifyTokenExchangeError(error) {
  const providerCode = error?.response?.data?.error;
  const status = Number(error?.response?.status);

  if (providerCode === 'invalid_grant' || (status >= 400 && status < 500)) {
    return 'invalid_callback';
  }
  if (isTemporaryProviderError(error)) {
    return 'exchange_failed';
  }
  return 'exchange_failed';
}

function classifyIdentityVerificationError(error) {
  return isTemporaryProviderError(error)
    ? 'exchange_failed'
    : 'identity_invalid';
}

function createGoogleIdentityClient({ clientId, clientSecret, redirectUri, oauthClient }) {
  const client = oauthClient || new OAuth2Client(clientId, clientSecret, redirectUri);

  return Object.freeze({
    createAuthorizationUrl({ state, codeChallenge }) {
      return client.generateAuthUrl({
        access_type: 'online',
        scope: ['openid', 'profile'],
        state,
        code_challenge: codeChallenge,
        code_challenge_method: 'S256'
      });
    },

    async exchangeCode({ code, codeVerifier }) {
      let tokens;
      try {
        ({ tokens } = await client.getToken({ code, codeVerifier }));
      } catch (error) {
        throw new GoogleIdentityError(classifyTokenExchangeError(error), { cause: error });
      }

      if (typeof tokens?.id_token !== 'string' || tokens.id_token.length === 0) {
        throw new GoogleIdentityError('identity_invalid');
      }

      let payload;
      try {
        const ticket = await client.verifyIdToken({
          idToken: tokens.id_token,
          audience: clientId
        });
        payload = ticket.getPayload();
      } catch (error) {
        throw new GoogleIdentityError(classifyIdentityVerificationError(error), { cause: error });
      }

      if (typeof payload?.sub !== 'string' || payload.sub.length === 0) {
        throw new GoogleIdentityError('identity_invalid');
      }

      return {
        subject: payload.sub,
        displayName: typeof payload.name === 'string' ? payload.name : null
      };
    }
  });
}

module.exports = {
  GoogleIdentityError,
  createGoogleIdentityClient
};

class ArticleAudioInputError extends Error {
  constructor(status, code, safeMessage, reason) {
    super(safeMessage);
    this.name = 'ArticleAudioInputError';
    this.status = status;
    this.code = code;
    this.safeMessage = safeMessage;
    this.reason = reason;
  }
}

function articleAudioError(status, code, safeMessage, reason) {
  return new ArticleAudioInputError(status, code, safeMessage, reason);
}

function isArticleAudioInputError(error) {
  return error instanceof ArticleAudioInputError;
}

module.exports = {
  ArticleAudioInputError,
  articleAudioError,
  isArticleAudioInputError
};

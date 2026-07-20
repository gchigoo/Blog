class ArticleAudioInputError extends Error {
  constructor(status, code, safeMessage) {
    super(safeMessage);
    this.name = 'ArticleAudioInputError';
    this.status = status;
    this.code = code;
    this.safeMessage = safeMessage;
  }
}

function articleAudioError(status, code, safeMessage) {
  return new ArticleAudioInputError(status, code, safeMessage);
}

function isArticleAudioInputError(error) {
  return error instanceof ArticleAudioInputError;
}

module.exports = {
  ArticleAudioInputError,
  articleAudioError,
  isArticleAudioInputError
};

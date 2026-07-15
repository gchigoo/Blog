const MIN_PASSWORD_LENGTH = 12;

/**
 * Validate administrator passwords with one shared rule.
 * @param {string} password
 * @returns {string|null} An error message, or null when valid.
 */
function validatePassword(password) {
  if (typeof password !== 'string' || password.length < MIN_PASSWORD_LENGTH) {
    return `密码长度至少 ${MIN_PASSWORD_LENGTH} 位`;
  }

  const characterClasses = [
    /[a-z]/.test(password),
    /[A-Z]/.test(password),
    /[0-9]/.test(password),
    /[^A-Za-z0-9]/.test(password)
  ].filter(Boolean).length;

  if (characterClasses < 3) {
    return '密码必须包含小写字母、大写字母、数字和特殊字符中的至少三类';
  }

  return null;
}

module.exports = {
  MIN_PASSWORD_LENGTH,
  validatePassword
};

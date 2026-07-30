const NAMED_BOT_RULES = [
  { pattern: /googlebot/i, botName: 'Googlebot' },
  { pattern: /applebot/i, botName: 'Applebot' },
  { pattern: /(?:bingbot|bingpreview)/i, botName: 'Bingbot' },
  { pattern: /facebookexternalhit/i, botName: 'Facebook crawler' },
  { pattern: /telegrambot/i, botName: 'TelegramBot' }
];
const GENERIC_BOT_PATTERN = /(?:^|[^a-z])bot(?:[^a-z]|$)|crawler|spider|slurp/i;
const HUMAN = Object.freeze({ trafficKind: 'human', botName: null });

function classifyClient(userAgent = '') {
  const value = typeof userAgent === 'string' ? userAgent : '';
  for (const { pattern, botName } of NAMED_BOT_RULES) {
    if (pattern.test(value)) return Object.freeze({ trafficKind: 'bot', botName });
  }
  if (GENERIC_BOT_PATTERN.test(value)) {
    return Object.freeze({ trafficKind: 'bot', botName: 'Other bot' });
  }
  return HUMAN;
}

module.exports = { classifyClient };

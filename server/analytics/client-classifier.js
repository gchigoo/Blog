const NAMED_BOT_RULES = [
  { pattern: /googlebot/i, botName: 'Googlebot' },
  { pattern: /applebot/i, botName: 'Applebot' },
  { pattern: /(?:bingbot|bingpreview)/i, botName: 'Bingbot' },
  { pattern: /facebookexternalhit/i, botName: 'Facebook crawler' },
  { pattern: /telegrambot/i, botName: 'TelegramBot' },
  { pattern: /gptbot/i, botName: 'GPTBot' },
  { pattern: /claudebot/i, botName: 'ClaudeBot' },
  { pattern: /ahrefsbot/i, botName: 'AhrefsBot' },
  { pattern: /twitterbot/i, botName: 'Twitterbot' },
  { pattern: /yandexbot/i, botName: 'YandexBot' },
  { pattern: /amazonbot/i, botName: 'Amazonbot' },
  { pattern: /petalbot/i, botName: 'PetalBot' }
];
// Generic crawler words must end an ASCII token. This recognizes real compound
// agents such as ExampleBot while avoiding embedded product names such as
// RoboticsLabBrowser, SpiderMonkey, and AcmeCrawlerToolkit.
const GENERIC_BOT_PATTERN = /(?:^|[^a-z0-9])(?:[a-z0-9_-]+(?:bot|crawler|spider)|bot|crawler|spider|slurp)(?=$|[^a-z0-9])/i;
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

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
const TOOL_BOT_RULES = [
  { pattern: /headlesschrome/i, botName: 'Headless Chrome' },
  { pattern: /phantomjs/i, botName: 'PhantomJS' },
  { pattern: /google-inspectiontool/i, botName: 'Google Inspection' },
  { pattern: /chrome-lighthouse/i, botName: 'Lighthouse' }
];
// Generic crawler words must end an ASCII token. This recognizes real compound
// agents such as ExampleBot while avoiding embedded product names such as
// RoboticsLabBrowser, SpiderMonkey, and AcmeCrawlerToolkit.
const GENERIC_BOT_PATTERN = /(?:^|[^a-z0-9])(?:[a-z0-9_-]+(?:bot|crawler|spider)|bot|crawler|spider|slurp)(?=$|[^a-z0-9])/i;
const LIBRARY_BOT_PATTERN = /(?:^|[^a-z0-9])(?:curl|wget|httpie|httpx|aiohttp|undici|node-fetch|go-http-client|python-requests|python-urllib|libwww-perl|okhttp|scrapy|axios|java\/|php\/|faraday|restsharp|zgrab|nuclei|masscan|censysinspect)(?:\/|\s|$)/i;
const AUTOMATED_BOT_SCORE_MAX = 29;
const HUMAN = Object.freeze({ trafficKind: 'human', botName: null });
const OTHER_BOT = Object.freeze({ trafficKind: 'bot', botName: 'Other bot' });

function botResult(botName) {
  return Object.freeze({ trafficKind: 'bot', botName });
}

function headerValue(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function parseBotScore(value) {
  const raw = headerValue(value);
  if (!/^\d{1,2}$/.test(raw)) return null;
  const score = Number(raw);
  return score >= 1 && score <= 99 ? score : null;
}

function isVerifiedBotFlag(value) {
  const raw = headerValue(value).toLowerCase();
  return raw === 'true' || raw === '1' || raw === 'yes';
}

function hasNavigationSignals(signals) {
  const mode = headerValue(signals.secFetchMode).toLowerCase();
  const dest = headerValue(signals.secFetchDest).toLowerCase();
  const clientHint = headerValue(signals.secChUa);
  const accept = headerValue(signals.accept).toLowerCase();
  // `sec-*` headers are forbidden in fetch() clients, so tests and some
  // HTTP libraries can only present `Accept: text/html`. Real browsers send
  // both navigation fetch metadata and a document Accept string.
  return mode === 'navigate' || dest === 'document' || clientHint !== ''
    || accept.includes('text/html');
}

function classifyRequestSignals(signals) {
  if (!signals || typeof signals !== 'object') return null;
  if (isVerifiedBotFlag(signals.cfVerifiedBot)) return OTHER_BOT;
  const score = parseBotScore(signals.cfBotScore);
  if (score !== null && score <= AUTOMATED_BOT_SCORE_MAX) return OTHER_BOT;
  if (/mozilla\/\d/i.test(String(signals.userAgent || '')) && !hasNavigationSignals(signals)) {
    return OTHER_BOT;
  }
  return null;
}

/**
 * Classify a client from its User-Agent, with optional request signals.
 * `signals` is omitted in unit tests that only cover UA rules. The collector
 * always passes it so Cloudflare bot headers and browser navigation hints
 * can catch Chrome-impersonating scanners that never execute the analytics
 * event token.
 *
 * @param {string} [userAgent]
 * @param {{
 *   secChUa?: string,
 *   secFetchMode?: string,
 *   secFetchDest?: string,
 *   accept?: string,
 *   cfBotScore?: string,
 *   cfVerifiedBot?: string
 * }} [signals]
 */
function classifyClient(userAgent = '', signals) {
  const value = typeof userAgent === 'string' ? userAgent : '';
  if (value.trim() === '') return OTHER_BOT;
  for (const { pattern, botName } of NAMED_BOT_RULES) {
    if (pattern.test(value)) return botResult(botName);
  }
  if (GENERIC_BOT_PATTERN.test(value)) return botResult('Other bot');
  for (const { pattern, botName } of TOOL_BOT_RULES) {
    if (pattern.test(value)) return botResult(botName);
  }
  if (LIBRARY_BOT_PATTERN.test(value)) return OTHER_BOT;
  if (signals !== undefined) {
    const fromSignals = classifyRequestSignals({ ...signals, userAgent: value });
    if (fromSignals) return fromSignals;
  }
  return HUMAN;
}

function classificationSignals(req) {
  return {
    secChUa: req.get('sec-ch-ua'),
    secFetchMode: req.get('sec-fetch-mode'),
    secFetchDest: req.get('sec-fetch-dest'),
    accept: req.get('accept'),
    cfBotScore: req.get('cf-bot-score') || req.get('x-bot-score'),
    cfVerifiedBot: req.get('cf-verified-bot') || req.get('x-verified-bot')
  };
}

module.exports = {
  AUTOMATED_BOT_SCORE_MAX,
  classifyClient,
  classificationSignals
};

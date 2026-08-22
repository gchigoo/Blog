const assert = require('node:assert/strict');
const test = require('node:test');
const { classifyClient } = require('../server/analytics/client-classifier');

const namedCases = [
  ['Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)', 'Googlebot'],
  ['Mozilla/5.0 Applebot/0.1', 'Applebot'],
  ['bingbot/2.0', 'Bingbot'],
  ['bingpreview/1.0', 'Bingbot'],
  ['facebookexternalhit/1.1', 'Facebook crawler'],
  ['TelegramBot (like TwitterBot)', 'TelegramBot'],
  ['GPTBot/1.2', 'GPTBot'],
  ['ClaudeBot/1.0', 'ClaudeBot'],
  ['AhrefsBot/7.0', 'AhrefsBot'],
  ['Twitterbot/1.0', 'Twitterbot'],
  ['YandexBot/3.0', 'YandexBot'],
  ['Amazonbot/0.1', 'Amazonbot'],
  ['PetalBot/1.0', 'PetalBot'],
  ['ExampleBot/1.0', 'Other bot'],
  ['ExampleCrawler/1.0', 'Other bot'],
  ['ExampleSpider/1.0', 'Other bot'],
  ['Yahoo! Slurp', 'Other bot'],
  ['', 'Other bot'],
  ['   ', 'Other bot'],
  ['curl/8.7.1', 'Other bot'],
  ['python-requests/2.32.0', 'Other bot'],
  ['Go-http-client/2.0', 'Other bot'],
  ['Mozilla/5.0 HeadlessChrome/126.0.0.0 Safari/537.36', 'Headless Chrome'],
  ['Mozilla/5.0 Google-InspectionTool/1.0', 'Google Inspection']
];

for (const [userAgent, botName] of namedCases) {
  test(`classifies ${botName} from ${userAgent || 'empty UA'}`, () => {
    assert.deepEqual(classifyClient(userAgent), { trafficKind: 'bot', botName });
    assert.ok(Object.isFrozen(classifyClient(userAgent)));
  });
}

test('keeps ordinary browsers and embedded crawler-product words human without request signals', () => {
  for (const userAgent of [
    'Mozilla/5.0 Chrome/126 Safari/537.36',
    'RoboticsLabBrowser/1.0',
    'SpiderMonkey/128.0',
    'AcmeCrawlerToolkit/4.2'
  ]) {
    assert.deepEqual(classifyClient(userAgent), { trafficKind: 'human', botName: null });
  }
});

test('request signals classify Mozilla agents without navigation hints as bots', () => {
  const chromeUa = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
  assert.deepEqual(
    classifyClient(chromeUa, {}),
    { trafficKind: 'bot', botName: 'Other bot' }
  );
  assert.deepEqual(
    classifyClient(chromeUa, { secFetchMode: 'navigate' }),
    { trafficKind: 'human', botName: null }
  );
  assert.deepEqual(
    classifyClient(chromeUa, { secChUa: '"Chromium";v="126"' }),
    { trafficKind: 'human', botName: null }
  );
  assert.deepEqual(
    classifyClient(chromeUa, { accept: 'text/html,application/xhtml+xml;q=0.9' }),
    { trafficKind: 'human', botName: null }
  );
  assert.deepEqual(
    classifyClient(chromeUa, { accept: '*/*' }),
    { trafficKind: 'bot', botName: 'Other bot' }
  );
  assert.deepEqual(
    classifyClient('Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15', {
      secFetchMode: 'navigate',
      secFetchDest: 'document'
    }),
    { trafficKind: 'human', botName: null }
  );
});

test('Cloudflare bot headers classify automated and verified traffic as bots', () => {
  const chromeUa = 'Mozilla/5.0 Chrome/126 Safari/537.36';
  const browserSignals = { secFetchMode: 'navigate', secChUa: '"Chromium";v="126"' };
  assert.deepEqual(
    classifyClient(chromeUa, { ...browserSignals, cfBotScore: '1' }),
    { trafficKind: 'bot', botName: 'Other bot' }
  );
  assert.deepEqual(
    classifyClient(chromeUa, { ...browserSignals, cfBotScore: '29' }),
    { trafficKind: 'bot', botName: 'Other bot' }
  );
  assert.deepEqual(
    classifyClient(chromeUa, { ...browserSignals, cfBotScore: '30' }),
    { trafficKind: 'human', botName: null }
  );
  assert.deepEqual(
    classifyClient(chromeUa, { ...browserSignals, cfBotScore: '99' }),
    { trafficKind: 'human', botName: null }
  );
  assert.deepEqual(
    classifyClient(chromeUa, { ...browserSignals, cfBotScore: 'abc' }),
    { trafficKind: 'human', botName: null }
  );
  assert.deepEqual(
    classifyClient(chromeUa, { ...browserSignals, cfVerifiedBot: 'true' }),
    { trafficKind: 'bot', botName: 'Other bot' }
  );
});

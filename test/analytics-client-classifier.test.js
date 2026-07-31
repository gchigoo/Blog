const assert = require('node:assert/strict');
const test = require('node:test');
const { classifyClient } = require('../server/analytics/client-classifier');

const cases = [
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
  ['Yahoo! Slurp', 'Other bot']
];

for (const [userAgent, botName] of cases) {
  test(`classifies ${botName}`, () => {
    assert.deepEqual(classifyClient(userAgent), { trafficKind: 'bot', botName });
    assert.ok(Object.isFrozen(classifyClient(userAgent)));
  });
}

test('keeps ordinary, blank, and embedded crawler-product words human', () => {
  for (const userAgent of [
    '',
    'Mozilla/5.0 Chrome/126 Safari/537.36',
    'RoboticsLabBrowser/1.0',
    'SpiderMonkey/128.0',
    'AcmeCrawlerToolkit/4.2'
  ]) {
    assert.deepEqual(classifyClient(userAgent), { trafficKind: 'human', botName: null });
  }
});

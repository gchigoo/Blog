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

test('keeps ordinary, blank, and ambiguous clients human', () => {
  for (const userAgent of ['', 'Mozilla/5.0 Chrome/126 Safari/537.36', 'RoboticsLabBrowser/1.0']) {
    assert.deepEqual(classifyClient(userAgent), { trafficKind: 'human', botName: null });
  }
});

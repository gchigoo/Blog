const { test, expect } = require('@playwright/test');
const { openScenario } = require('./browser-assets');

async function playPauseAndSeek(audio) {
  return audio.evaluate(async element => {
    function waitForMetadata() {
      if (element.readyState >= HTMLMediaElement.HAVE_METADATA) return Promise.resolve();
      return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('metadata timeout')), 8_000);
        element.addEventListener('loadedmetadata', () => {
          clearTimeout(timeout);
          resolve();
        }, { once: true });
        element.addEventListener('error', () => {
          clearTimeout(timeout);
          reject(new Error(`media error ${element.error?.code || 'unknown'}`));
        }, { once: true });
      });
    }

    await waitForMetadata();
    await element.play();
    await new Promise((resolve, reject) => {
      const deadline = performance.now() + 8_000;
      const check = () => {
        if (element.currentTime > 0.05) return resolve();
        if (element.error) return reject(new Error(`media error ${element.error.code}`));
        if (performance.now() >= deadline) return reject(new Error('playback did not advance'));
        setTimeout(check, 25);
      };
      check();
    });
    element.pause();

    const seekTarget = Math.min(0.5, Math.max(0.1, element.duration / 2));
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('seek timeout')), 5_000);
      element.addEventListener('seeked', () => {
        clearTimeout(timeout);
        resolve();
      }, { once: true });
      element.currentTime = seekTarget;
    });
    return {
      currentTime: element.currentTime,
      duration: element.duration,
      paused: element.paused
    };
  });
}

test('article audio card is usable without desktop or mobile overflow', async ({ page }, testInfo) => {
  test.skip(
    testInfo.project.name === 'article-audio-webkit',
    'Chromium captures the responsive screenshots; WebKit remains in the real playback matrix.'
  );
  test.setTimeout(90_000);
  const stylesheetResponse = page.waitForResponse(response => (
    new URL(response.url()).pathname === '/css/article-audio.css'
  ));
  await openScenario(page, {
    path: '/__audio/article',
    skipFontWait: true,
    waitUntil: 'domcontentloaded'
  });
  expect((await stylesheetResponse).status()).toBe(200);

  const cards = page.locator('.article-audio');
  const card = cards.first();
  const audio = card.locator('audio');
  await expect(cards).toHaveCount(4);
  await expect(card.locator('.article-audio__title')).toHaveText('Stay Until Tomorrow');
  await expect(card.locator('.article-audio__artist')).toHaveText('AI Voice Experiment');
  await expect(card.locator('.article-audio__caption')).toContainText('MP3 合成音频播放验证');
  await expect(audio).toHaveAttribute('controls', '');
  await expect(audio).toHaveAttribute('preload', 'metadata');
  await expect(audio).toHaveAttribute('aria-labelledby', 'article-audio-title-1');
  await expect(audio).not.toHaveAttribute('autoplay', /.*/);
  await expect(audio.locator('source')).toHaveAttribute('type', 'audio/mpeg');
  await expect(audio.locator('a')).toHaveCount(0);
  await expect(card.locator('.article-audio__fallback')).toHaveAttribute(
    'href',
    /^\/audio\/audio-browser\/[a-f0-9]{64}\.mp3$/
  );

  await audio.focus();
  await expect(audio).toBeFocused();

  const layout = await page.evaluate(() => {
    const element = document.querySelector('.article-audio');
    const control = element.querySelector('audio');
    const cardRect = element.getBoundingClientRect();
    const controlRect = control.getBoundingClientRect();
    const style = getComputedStyle(element);
    return {
      bodyWidth: document.body.scrollWidth,
      viewportWidth: window.innerWidth,
      cardLeft: cardRect.left,
      cardRight: cardRect.right,
      controlLeft: controlRect.left,
      controlRight: controlRect.right,
      borderStyle: style.borderStyle,
      backgroundImage: style.backgroundImage
    };
  });
  expect(layout.bodyWidth).toBeLessThanOrEqual(layout.viewportWidth);
  expect(layout.cardLeft).toBeGreaterThanOrEqual(0);
  expect(layout.cardRight).toBeLessThanOrEqual(layout.viewportWidth);
  expect(layout.controlLeft).toBeGreaterThanOrEqual(layout.cardLeft);
  expect(layout.controlRight).toBeLessThanOrEqual(layout.cardRight);
  expect(layout.borderStyle).toBe('solid');
  expect(layout.backgroundImage).not.toBe('none');

  const screenshotPath = testInfo.outputPath('article-audio-runtime.png');
  await page.screenshot({ path: screenshotPath, fullPage: true });
  await testInfo.attach('article-audio-runtime', {
    path: screenshotPath,
    contentType: 'image/png'
  });
});

test('article audio browser matrix performs real play, pause, seek, or the allowed FLAC fallback', async ({ page }, testInfo) => {
  await openScenario(page, {
    path: '/__audio/article',
    skipFontWait: true,
    waitUntil: 'domcontentloaded'
  });
  const expected = [
    { extension: 'mp3', mimeType: 'audio/mpeg' },
    { extension: 'aac', mimeType: 'audio/aac' },
    { extension: 'm4a', mimeType: 'audio/mp4' },
    { extension: 'flac', mimeType: 'audio/flac' }
  ];
  const cards = page.locator('.article-audio');
  await expect(cards).toHaveCount(expected.length);
  const results = [];

  for (let index = 0; index < expected.length; index += 1) {
    const format = expected[index];
    const card = cards.nth(index);
    const audio = card.locator('audio');
    const source = audio.locator('source');
    const fallback = card.locator('.article-audio__fallback');
    await expect(source).toHaveAttribute('type', format.mimeType);
    await expect(source).toHaveAttribute('src', new RegExp(`\\.${format.extension}$`));
    await expect(fallback).toBeVisible();
    const capability = await audio.evaluate((element, mimeType) => element.canPlayType(mimeType), format.mimeType);

    try {
      const playback = await playPauseAndSeek(audio);
      expect(playback.paused).toBe(true);
      expect(playback.currentTime).toBeGreaterThan(0);
      results.push({ ...format, capability, status: 'played', playback });
    } catch (error) {
      const fallbackAllowed = (
        testInfo.project.name === 'article-audio-webkit' &&
        format.extension === 'flac'
      );
      if (!fallbackAllowed) throw error;

      await fallback.focus();
      await expect(fallback).toBeFocused();
      const href = await fallback.getAttribute('href');
      const response = await page.request.get(href);
      expect(response.status()).toBe(200);
      expect(response.headers()['content-type']).toBe(format.mimeType);
      results.push({
        ...format,
        capability,
        status: 'fallback',
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }

  expect(results.filter(result => result.status === 'fallback')).toEqual(
    results.filter(result => result.extension === 'flac' && result.status === 'fallback')
  );
  await testInfo.attach('article-audio-playback-matrix', {
    body: Buffer.from(JSON.stringify({ project: testInfo.project.name, results }, null, 2)),
    contentType: 'application/json'
  });
});

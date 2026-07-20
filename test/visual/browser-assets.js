const fs = require('node:fs');
const path = require('node:path');

const assetsDir = path.resolve(__dirname, 'assets');
const interCssUrl = 'https://fonts.xz.style/serve/inter.css';
const newCssUrl = 'https://cdn.jsdelivr.net/npm/@exampledev/new.css@1.1.2/new.min.css';

async function installPinnedAssetRoutes(page, options = {}) {
  await page.route(interCssUrl, route => route.fulfill({
    ...(options.skipFonts
      ? { body: 'html, body { font-family: Arial, sans-serif; }' }
      : { path: path.join(assetsDir, 'inter.css') }),
    contentType: 'text/css; charset=utf-8'
  }));
  await page.route(newCssUrl, route => route.fulfill({
    path: path.join(assetsDir, 'new.min.css'),
    contentType: 'text/css; charset=utf-8'
  }));
  await page.route('https://fonts.xz.style/serve/src/inter/**', route => {
    const fileName = path.basename(new URL(route.request().url()).pathname);
    const localPath = path.join(assetsDir, fileName);
    if (!fs.existsSync(localPath)) return route.abort('blockedbyclient');
    return route.fulfill({ path: localPath, contentType: 'font/woff2' });
  });
}

async function openScenario(page, scenario) {
  await installPinnedAssetRoutes(page, { skipFonts: scenario.skipFontWait === true });
  const waitUntil = scenario.waitUntil || 'networkidle';
  if (scenario.setupPath) {
    const setupResponse = await page.goto(scenario.setupPath, { waitUntil });
    if (!setupResponse || setupResponse.status() >= 400) {
      throw new Error(`Scenario setup failed: ${scenario.setupPath}`);
    }
  }
  const response = await page.goto(scenario.path, { waitUntil });
  if (!response || response.status() >= 400) {
    throw new Error(`Scenario failed: ${scenario.path}`);
  }
  await page.evaluate(async skipFontWait => {
    const faces = [
      '400 16px Inter',
      'italic 400 16px Inter',
      '500 16px Inter',
      '600 16px Inter',
      '700 16px Inter',
      '800 16px Inter'
    ];
    if (!skipFontWait) {
      await Promise.all(faces.map(face => document.fonts.load(face)));
      await document.fonts.ready;
      if (!faces.every(face => document.fonts.check(face))) {
        throw new Error('Pinned Inter fonts did not finish loading.');
      }
    }
    document.body.getBoundingClientRect();
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  }, scenario.skipFontWait === true);
  return response;
}

module.exports = { openScenario };

const { test, expect } = require('@playwright/test');
const { openScenario } = require('./browser-assets');
const { collectLayoutSnapshot } = require('./layout-snapshot');
const { scenarios } = require('./scenarios');

test.describe('EJS layout-exact and visual characterization', () => {
  for (const scenario of scenarios) {
    test(scenario.id, async ({ page }) => {
      await openScenario(page, scenario);
      if (scenario.id === 'admin-analytics') {
        expect(await page.evaluate(() => ({
          documentWidth: document.documentElement.scrollWidth,
          viewportWidth: document.documentElement.clientWidth
        }))).toEqual(expect.objectContaining({
          documentWidth: expect.any(Number),
          viewportWidth: expect.any(Number)
        }));
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);

        const isDesktop = test.info().project.name.startsWith('desktop-');
        if (isDesktop) {
          await expect(page.locator('.analytics-event-table')).toBeVisible();
          await expect(page.locator('.analytics-event-cards')).toBeHidden();
        } else {
          await expect(page.locator('.analytics-event-table')).toBeHidden();
          await expect(page.locator('.analytics-event-cards')).toBeVisible();
        }
      }
      const layout = await collectLayoutSnapshot(page);
      expect(JSON.stringify(layout, null, 2)).toMatchSnapshot(`${scenario.id}.layout.json`);
      await expect(page).toHaveScreenshot(`${scenario.id}.png`, {
        fullPage: true
      });
    });
  }
});

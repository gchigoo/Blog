const { test, expect } = require('@playwright/test');
const { openScenario } = require('./browser-assets');
const { collectLayoutSnapshot } = require('./layout-snapshot');
const { scenarios } = require('./scenarios');

test.describe('EJS layout-exact and visual characterization', () => {
  for (const scenario of scenarios) {
    test(scenario.id, async ({ page }) => {
      await openScenario(page, scenario);
      const layout = await collectLayoutSnapshot(page);
      expect(JSON.stringify(layout, null, 2)).toMatchSnapshot(`${scenario.id}.layout.json`);
      await expect(page).toHaveScreenshot(`${scenario.id}.png`, {
        fullPage: true
      });
    });
  }
});

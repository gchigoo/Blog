const { test, expect } = require('@playwright/test');
const { openScenario } = require('./browser-assets');
const { scenarios } = require('./scenarios');

test.describe('EJS rendered HTML characterization', () => {
  for (const scenario of scenarios) {
    test(scenario.id, async ({ page }) => {
      const response = await openScenario(page, scenario);
      const html = await response.text();
      expect(html).toMatchSnapshot(`${scenario.id}.html`);
    });
  }
});

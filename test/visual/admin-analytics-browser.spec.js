const { test, expect } = require('@playwright/test');

function eventApiResponse(page, predicate) {
  return page.waitForResponse(response => {
    const url = new URL(response.url());
    return url.pathname === '/api/admin/analytics/events' && predicate(url, response);
  });
}

async function openAnalytics(page) {
  await page.goto('/admin/analytics');
  await expect(page.locator('#event-list')).toHaveAttribute('aria-busy', 'false');
}

async function goToNextPage(page) {
  const responsePromise = eventApiResponse(page, url => url.searchParams.get('cursor') === 'fixture-page-2');
  const next = page.locator('[data-analytics-page="next"]');
  await expect(next).toBeEnabled();
  expect(await next.evaluate(node => node.tagName)).toBe('BUTTON');
  await next.click();
  expect((await responsePromise).status()).toBe(200);
  await expect(page.locator('#analytics-event-summary')).toContainText('第 2 页');
}

test('next page updates only the event workspace and preserves scroll', async ({ page }) => {
  await openAnalytics(page);
  await page.evaluate(() => {
    window.__analyticsOverviewNode = document.querySelector('#analytics-overview');
    const workspace = document.querySelector('#event-list');
    window.scrollTo(0, workspace.offsetTop + 120);
  });
  const before = await page.evaluate(() => window.scrollY);

  await goToNextPage(page);

  expect(await page.evaluate(() => document.querySelector('#analytics-overview') === window.__analyticsOverviewNode)).toBe(true);
  expect(await page.evaluate(() => window.scrollY)).toBe(before);
  await expect(page).toHaveURL(/cursor=fixture-page-2/);
  await expect(page.locator('#analytics-event-table-body tr')).toHaveCount(2);
  await expect(page.locator('#analytics-event-cards .analytics-event-card')).toHaveCount(2);
  await expect(page.locator('#analytics-event-table-body')).not.toContainText('google.com');
});

test('a direct cursor URL refreshes the current page without a durable Previous stack', async ({ page }) => {
  await page.goto('/admin/analytics?days=7&traffic=all&cursor=fixture-page-2');
  await expect(page.locator('#analytics-event-table-body')).toContainText('Fixture page 2');
  await page.reload();
  await expect(page.locator('#analytics-event-table-body')).toContainText('Fixture page 2');
  await expect(page).toHaveURL(/cursor=fixture-page-2/);
  await expect(page.locator('[data-analytics-page="previous"]')).toBeDisabled();
});

test('enhanced Previous returns to page 1 without a reload', async ({ page }) => {
  await openAnalytics(page);
  await goToNextPage(page);

  const responsePromise = eventApiResponse(page, url => !url.searchParams.has('cursor'));
  const previous = page.locator('[data-analytics-page="previous"]');
  await expect(previous).toBeEnabled();
  await previous.click();
  expect((await responsePromise).status()).toBe(200);

  await expect(page.locator('#analytics-event-summary')).toContainText('第 1 页');
  await expect(page.locator('#analytics-event-table-body')).toContainText('Fixture page 1');
  await expect(page).not.toHaveURL(/cursor=/);
  await expect(page.locator('[data-analytics-page="previous"]')).toBeDisabled();
});

test('browser Back and Forward restore rows and URL without adding history entries', async ({ page }) => {
  await openAnalytics(page);
  const initialLength = await page.evaluate(() => history.length);
  await goToNextPage(page);
  const pushedLength = await page.evaluate(() => history.length);
  expect(pushedLength).toBe(initialLength + 1);

  const backResponse = eventApiResponse(page, url => !url.searchParams.has('cursor'));
  await page.goBack();
  expect((await backResponse).status()).toBe(200);
  await expect(page.locator('#analytics-event-table-body')).toContainText('Fixture page 1');
  await expect(page.locator('#analytics-search')).toHaveValue('');
  await expect(page).not.toHaveURL(/cursor=/);
  expect(await page.evaluate(() => history.length)).toBe(pushedLength);

  const forwardResponse = eventApiResponse(page, url => url.searchParams.get('cursor') === 'fixture-page-2');
  await page.goForward();
  expect((await forwardResponse).status()).toBe(200);
  await expect(page.locator('#analytics-event-table-body')).toContainText('Fixture page 2');
  await expect(page.locator('#analytics-search')).toHaveValue('');
  await expect(page).toHaveURL(/cursor=fixture-page-2/);
  expect(await page.evaluate(() => history.length)).toBe(pushedLength);
});

test('filter submit clears the cursor stack and safely preserves encoded filters', async ({ page }) => {
  await openAnalytics(page);
  await goToNextPage(page);

  const search = '筛选 A&B';
  await page.locator('#analytics-search').fill(search);
  await page.getByRole('radio', { name: '爬虫' }).check();
  const responsePromise = eventApiResponse(page, url => (
    url.searchParams.get('search') === search &&
    url.searchParams.get('traffic') === 'bot' &&
    !url.searchParams.has('cursor')
  ));
  await page.locator('#analytics-filter-form button[type="submit"]').first().click();
  expect((await responsePromise).status()).toBe(200);

  await expect(page.locator('#analytics-event-summary')).toContainText('第 1 页');
  await expect(page.locator('.analytics-applied-filters')).toContainText(search);
  await expect(page.locator('[data-analytics-page="previous"]')).toBeDisabled();
  await expect(page.locator('#analytics-event-table-body tr[data-traffic-kind="bot"]')).toHaveCount(2);
  await expect(page.locator('#analytics-event-table-body')).toContainText('Googlebot');
  await expect(page.locator('#analytics-event-table-body')).toContainText(search);
  const current = new URL(page.url());
  expect(current.searchParams.get('search')).toBe(search);
  expect(current.searchParams.get('traffic')).toBe('bot');
  expect(current.searchParams.has('cursor')).toBe(false);
});

test('a delayed old request cannot overwrite a newer request', async ({ page, request }) => {
  await openAnalytics(page);
  const stateResponse = await request.get('/__test/analytics-slow-state');
  const { completed } = await stateResponse.json();

  await page.locator('#analytics-search').fill('slow');
  const slowRequest = page.waitForRequest(requestEvent => {
    const url = new URL(requestEvent.url());
    return url.pathname === '/api/admin/analytics/events' && url.searchParams.get('search') === 'slow';
  });
  await page.locator('#analytics-filter-form button[type="submit"]').first().click();
  await slowRequest;

  const latestResponse = eventApiResponse(page, url => url.searchParams.get('search') === 'latest');
  await page.evaluate(() => {
    document.querySelector('#analytics-search').value = 'latest';
    document.querySelector('#analytics-filter-form').requestSubmit();
  });
  expect((await latestResponse).status()).toBe(200);
  const slowCompletion = await request.get(`/__test/analytics-wait-slow?after=${completed}`);
  expect(slowCompletion.status()).toBe(200);

  await expect(page.locator('#analytics-event-table-body')).toContainText('latest');
  await expect(page.locator('#analytics-event-table-body')).not.toContainText('slow');
  await expect(page.locator('.analytics-applied-filters')).toContainText('latest');
  expect(new URL(page.url()).searchParams.get('search')).toBe('latest');
});

test('a failed next request keeps the previous session stack intact', async ({ page, request }) => {
  await request.post('/__test/analytics-reset');
  await openAnalytics(page);
  await page.locator('#analytics-search').fill('retry-next');
  const filteredResponse = eventApiResponse(page, (url, response) => (
    url.searchParams.get('search') === 'retry-next' && response.status() === 200
  ));
  await page.locator('#analytics-filter-form button[type="submit"]').first().click();
  await filteredResponse;

  const failureResponse = eventApiResponse(page, (url, response) => (
    url.searchParams.get('search') === 'retry-next' &&
    url.searchParams.get('cursor') === 'fixture-page-2' &&
    response.status() === 500
  ));
  await page.locator('[data-analytics-page="next"]').click();
  await failureResponse;
  await expect(page.locator('[data-analytics-retry]')).toBeVisible();
  await expect(page.locator('[data-analytics-page="previous"]')).toBeDisabled();
  expect(new URL(page.url()).searchParams.has('cursor')).toBe(false);
});

test('one-time server failure keeps old rows and local retry succeeds', async ({ page, request }) => {
  await request.post('/__test/analytics-reset');
  await openAnalytics(page);
  const originalText = await page.locator('#analytics-event-table-body tr').first().innerText();
  await page.locator('#analytics-search').fill('retry');

  const failureResponse = eventApiResponse(page, (url, response) => (
    url.searchParams.get('search') === 'retry' && response.status() === 500
  ));
  await page.locator('#analytics-filter-form button[type="submit"]').first().click();
  await failureResponse;

  await expect(page.locator('#analytics-event-table-body tr').first()).toContainText(originalText);
  await expect(page.locator('[data-analytics-retry]')).toBeVisible();
  expect(new URL(page.url()).searchParams.has('search')).toBe(false);

  const successResponse = eventApiResponse(page, (url, response) => (
    url.searchParams.get('search') === 'retry' && response.status() === 200
  ));
  await page.locator('[data-analytics-retry]').click();
  await successResponse;
  await expect(page.locator('#analytics-event-table-body')).toContainText('retry');
  expect(new URL(page.url()).searchParams.get('search')).toBe('retry');
});

test('invalid filter keeps user input and old rows usable', async ({ page }) => {
  await openAnalytics(page);
  const originalText = await page.locator('#analytics-event-table-body tr').first().innerText();
  await page.locator('#analytics-search').fill('invalid');

  const invalidResponse = eventApiResponse(page, (url, response) => (
    url.searchParams.get('search') === 'invalid' && response.status() === 400
  ));
  await page.locator('#analytics-filter-form button[type="submit"]').first().click();
  await invalidResponse;

  await expect(page.locator('#analytics-search')).toHaveValue('invalid');
  await expect(page.locator('#analytics-event-table-body tr').first()).toContainText(originalText);
  await expect(page.locator('#analytics-event-status')).toHaveAttribute('role', 'alert');
  await expect(page.locator('#analytics-event-status')).toContainText('筛选条件无效');
  await expect(page.locator('[data-analytics-retry]')).toBeVisible();
  await expect(page.locator('.analytics-detail-button').first()).toBeEnabled();
  expect(new URL(page.url()).searchParams.has('search')).toBe(false);
});

test('updated detail buttons work through event delegation', async ({ page }) => {
  await openAnalytics(page);
  await goToNextPage(page);
  const button = page.locator('#analytics-event-table-body .analytics-detail-button').first();
  const eventId = await button.getAttribute('data-event-id');
  const detailResponse = page.waitForResponse(response => (
    new URL(response.url()).pathname === `/api/admin/analytics/events/${eventId}`
  ));
  await button.click();
  expect((await detailResponse).status()).toBe(200);

  await expect(page.locator('#analytics-detail-panel')).toBeVisible();
  await expect(page.locator('#analytics-detail-id')).toHaveText(eventId);
  await expect(page.locator('#analytics-detail-json')).toContainText(eventId);
});

test('result summary receives focus with preventScroll behavior', async ({ page }) => {
  await openAnalytics(page);
  await page.evaluate(() => {
    const originalFocus = HTMLElement.prototype.focus;
    window.__analyticsFocusOptions = [];
    HTMLElement.prototype.focus = function focus(options) {
      if (this.id === 'analytics-event-summary') window.__analyticsFocusOptions.push(options || null);
      return originalFocus.call(this, options);
    };
    const workspace = document.querySelector('#event-list');
    window.scrollTo(0, workspace.offsetTop + 140);
  });
  const before = await page.evaluate(() => window.scrollY);

  await goToNextPage(page);

  await expect(page.locator('#analytics-event-summary')).toBeFocused();
  expect(await page.evaluate(() => window.__analyticsFocusOptions.some(options => options?.preventScroll === true))).toBe(true);
  expect(await page.evaluate(() => window.scrollY)).toBe(before);
});

test('JavaScript-disabled Next navigation reloads at the event workspace anchor', async ({ browser }) => {
  const context = await browser.newContext({ javaScriptEnabled: false });
  const page = await context.newPage();
  try {
    await page.goto('http://127.0.0.1:4173/admin/analytics');
    const next = page.locator('[data-analytics-page="next"]');
    expect(await next.evaluate(node => node.tagName)).toBe('A');
    await Promise.all([
      page.waitForNavigation(),
      next.click()
    ]);
    await expect(page).toHaveURL(/cursor=fixture-page-2.*#event-list$/);
    await expect(page.locator('#analytics-event-table-body')).toContainText('Fixture page 2');
    expect(await page.evaluate(() => location.hash)).toBe('#event-list');
  } finally {
    await context.close();
  }
});

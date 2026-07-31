const { test, expect } = require('@playwright/test');

const fixtureRows = [
  { position: 1, observedAtUtc: '2026-07-17T08:30:00.000Z', metricId: 601 },
  { position: 2, observedAtUtc: '2026-07-17T07:10:00.000Z', metricId: 602 },
  { position: 3, observedAtUtc: '2026-07-17T06:30:00.000Z', metricId: 603 },
  { position: 4, observedAtUtc: '2026-07-17T05:10:00.000Z', metricId: 604 },
  { position: 5, observedAtUtc: '2026-07-17T04:30:00.000Z', metricId: 605 },
  { position: 6, observedAtUtc: '2026-07-17T03:10:00.000Z', metricId: 606 }
];

function fixtureCursor(position) {
  const row = fixtureRows.find(item => item.position === position);
  return Buffer.from(JSON.stringify({
    observedAtUtc: row.observedAtUtc,
    metricId: row.metricId
  })).toString('base64url');
}

function decodeFixtureCursor(cursor) {
  return JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
}

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
  const responsePromise = eventApiResponse(page, url => url.searchParams.has('cursor'));
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
  expect(new URL(page.url()).searchParams.has('cursor')).toBe(true);
  await expect(page.locator('#analytics-event-table-body tr')).toHaveCount(2);
  await expect(page.locator('#analytics-event-cards .analytics-event-card')).toHaveCount(2);
  await expect(page.locator('#analytics-event-table-body')).not.toContainText('google.com');
});

test('paging uses the committed query instead of unsubmitted draft edits', async ({ page }) => {
  await openAnalytics(page);
  await page.locator('#analytics-search').fill('committed');
  const filterResponse = eventApiResponse(page, url => url.searchParams.get('search') === 'committed');
  await page.locator('#analytics-filter-form button[type="submit"]').first().click();
  await filterResponse;

  await page.locator('#analytics-search').fill('draft-only');
  const nextResponse = eventApiResponse(page, url => (
    url.searchParams.get('search') === 'committed' &&
    url.searchParams.has('cursor')
  ));
  await page.locator('[data-analytics-page="next"]').click();
  await nextResponse;

  await expect(page.locator('#analytics-search')).toHaveValue('committed');
  await expect(page.locator('.analytics-applied-filters')).toContainText('committed');
  await expect(page.locator('#analytics-event-table-body')).toContainText('committed');
  expect(new URL(page.url()).searchParams.get('search')).toBe('committed');
});

test('a direct cursor URL refreshes the current page without a durable Previous stack', async ({ page }) => {
  const cursor = fixtureCursor(2);
  await page.goto(`/admin/analytics?days=7&traffic=all&cursor=${encodeURIComponent(cursor)}`);
  await expect(page.locator('#analytics-event-table-body')).toContainText('Fixture event 3');
  await page.reload();
  await expect(page.locator('#analytics-event-table-body')).toContainText('Fixture event 3');
  expect(new URL(page.url()).searchParams.get('cursor')).toBe(cursor);
  await expect(page.locator('[data-analytics-page="previous"]')).toBeDisabled();
});

test('same-tab refresh after enhanced navigation restores its history stack', async ({ page }) => {
  await openAnalytics(page);
  await goToNextPage(page);
  await page.reload();

  await expect(page.locator('#analytics-event-table-body')).toContainText('Fixture event 3');
  expect(new URL(page.url()).searchParams.has('cursor')).toBe(true);
  await expect(page.locator('[data-analytics-page="previous"]')).toBeEnabled();
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
  await expect(page.locator('#analytics-event-table-body')).toContainText('Fixture event 1');
  await expect(page).not.toHaveURL(/cursor=/);
  await expect(page.locator('[data-analytics-page="previous"]')).toBeDisabled();
});

test('browser Back and Forward preserve the exact accepted raw query', async ({ page }) => {
  const rawQuery = 'days=7&traffic=all&opaque=bare&spelling=a%20b&hex=%2f';
  await page.goto(`/admin/analytics?${rawQuery}`);
  expect(await page.evaluate(() => history.state.analytics.query)).toBe(rawQuery);
  const nextResponse = eventApiResponse(page, url => url.searchParams.has('cursor'));
  await page.locator('[data-analytics-page="next"]').click();
  await nextResponse;

  const backResponse = eventApiResponse(page, url => !url.searchParams.has('cursor'));
  await page.goBack();
  await backResponse;
  expect(new URL(page.url()).search.slice(1)).toBe(rawQuery);
  expect(await page.evaluate(() => history.state.analytics.query)).toBe(rawQuery);
  expect(await page.evaluate(() => {
    const source = history.state.analytics.query;
    return source.includes('spelling=a%20b') && source.includes('hex=%2f');
  })).toBe(true);

  const forwardResponse = eventApiResponse(page, url => url.searchParams.has('cursor'));
  await page.goForward();
  await forwardResponse;
  const forwardQuery = new URL(page.url()).search.slice(1);
  expect(await page.evaluate(() => history.state.analytics.query)).toBe(forwardQuery);
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
  await expect(page.locator('#analytics-event-table-body')).toContainText('Fixture event 1');
  await expect(page.locator('#analytics-search')).toHaveValue('');
  await expect(page).not.toHaveURL(/cursor=/);
  expect(await page.evaluate(() => history.length)).toBe(pushedLength);

  const forwardResponse = eventApiResponse(page, url => url.searchParams.has('cursor'));
  await page.goForward();
  expect((await forwardResponse).status()).toBe(200);
  await expect(page.locator('#analytics-event-table-body')).toContainText('Fixture event 3');
  await expect(page.locator('#analytics-search')).toHaveValue('');
  expect(new URL(page.url()).searchParams.has('cursor')).toBe(true);
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

test('filters activated after load render removable chips with dynamic country cascade metadata', async ({ page }) => {
  await page.goto('/admin/analytics?limit=1&opaque=kept');
  await expect(page.locator('[data-analytics-remove-filter]')).toHaveCount(0);
  await page.locator('.analytics-advanced-filters summary').click();

  await page.locator('#analytics-filter-form input[name="country"]').fill('CN');
  await page.locator('#analytics-filter-form input[name="subdivision"]').fill('beijing');
  await page.locator('#analytics-filter-form input[name="city"]').fill('beijing');
  await page.locator('#analytics-filter-form input[name="browser"]').fill('chrome');
  const submitResponse = eventApiResponse(page, url => (
    url.searchParams.get('country') === 'CN' &&
    url.searchParams.get('subdivision') === 'beijing' &&
    url.searchParams.get('city') === 'beijing' &&
    url.searchParams.get('browser') === 'chrome' &&
    url.searchParams.get('limit') === '1' &&
    url.searchParams.get('opaque') === 'kept'
  ));
  await page.locator('#analytics-filter-form button[type="submit"]').first().click();
  expect((await submitResponse).status()).toBe(200);

  await expect(page.locator('.analytics-advanced-filters summary')).toHaveText('高级筛选（4）');
  await expect(page.locator('[data-analytics-remove-filter]')).toHaveCount(4);
  await expect(page.locator('[data-analytics-remove-filter="country"]')).toHaveAttribute(
    'data-analytics-remove-names',
    'country,subdivision,city'
  );
  await page.locator('[data-analytics-remove-filter="country"]').evaluate(chip => {
    chip.dataset.analyticsRemoveNames = 'country,untrusted';
  });

  const countryResponse = page.waitForResponse(response => {
    const url = new URL(response.url());
    return url.pathname === '/api/admin/analytics/events' &&
      !url.searchParams.has('country') &&
      !url.searchParams.has('subdivision') &&
      !url.searchParams.has('city') &&
      url.searchParams.get('browser') === 'chrome' &&
      url.searchParams.get('limit') === '1' &&
      url.searchParams.get('opaque') === 'kept' &&
      !url.searchParams.has('cursor');
  }, { timeout: 2_000 });
  await page.locator('[data-analytics-remove-filter="country"]').click();
  expect((await countryResponse).status()).toBe(200);

  await expect(page.locator('.analytics-advanced-filters summary')).toHaveText('高级筛选（1）');
  await expect(page.locator('[data-analytics-remove-filter]')).toHaveCount(1);
  await expect(page.locator('[data-analytics-remove-filter="browser"]')).toBeVisible();

  const browserResponse = page.waitForResponse(response => {
    const url = new URL(response.url());
    return url.pathname === '/api/admin/analytics/events' &&
      !url.searchParams.has('browser') &&
      url.searchParams.get('limit') === '1' &&
      url.searchParams.get('opaque') === 'kept';
  }, { timeout: 2_000 });
  await page.locator('[data-analytics-remove-filter="browser"]').click();
  expect((await browserResponse).status()).toBe(200);
  await expect(page.locator('[data-analytics-remove-filter]')).toHaveCount(0);
});

test('committed filter chips show advanced count and remove one filter at a time', async ({ page }) => {
  await page.goto('/admin/analytics?days=7&traffic=bot&search=needle&ip=203.0.113.10&country=CN&city=beijing&limit=1');
  await expect(page.locator('.analytics-advanced-filters summary')).toHaveText('高级筛选（3）');
  await expect(page.locator('[data-analytics-remove-filter]')).toHaveCount(5);

  const response = eventApiResponse(page, url => (
    !url.searchParams.has('city') &&
    url.searchParams.get('country') === 'CN' &&
    url.searchParams.get('ip') === '203.0.113.10' &&
    url.searchParams.get('search') === 'needle' &&
    url.searchParams.get('traffic') === 'bot' &&
    url.searchParams.get('limit') === '1' &&
    !url.searchParams.has('cursor')
  ));
  await page.locator('[data-analytics-remove-filter="city"]').click();
  expect((await response).status()).toBe(200);

  await expect(page.locator('.analytics-advanced-filters summary')).toHaveText('高级筛选（2）');
  await expect(page.locator('[data-analytics-remove-filter="city"]')).toHaveCount(0);
  await expect(page.locator('[data-analytics-remove-filter="ip"]')).toHaveAttribute('aria-label', '移除完整 IP 筛选：203.0.113.10');
  await expect(page.locator('[data-analytics-page="previous"]')).toBeDisabled();
  const url = new URL(page.url());
  expect(url.searchParams.has('city')).toBe(false);
  expect(url.searchParams.get('country')).toBe('CN');
  expect(url.searchParams.get('limit')).toBe('1');
});

test('country removal cascades geographic dependents from committed state and resets pagination', async ({ page }) => {
  await page.goto('/admin/analytics?days=7&traffic=bot&search=needle&country=CN&subdivision=beijing&city=beijing&browser=chrome&limit=1&opaque=kept');
  await expect(page.locator('.analytics-advanced-filters summary')).toHaveText('高级筛选（4）');
  await expect(page.locator('[data-analytics-remove-filter]')).toHaveCount(6);
  await goToNextPage(page);
  await page.locator('#analytics-filter-form input[name="city"]').fill('draft-city');

  const response = eventApiResponse(page, url => (
    !url.searchParams.has('country') &&
    !url.searchParams.has('subdivision') &&
    !url.searchParams.has('city') &&
    url.searchParams.get('browser') === 'chrome' &&
    url.searchParams.get('search') === 'needle' &&
    url.searchParams.get('traffic') === 'bot' &&
    url.searchParams.get('limit') === '1' &&
    url.searchParams.get('opaque') === 'kept' &&
    !url.searchParams.has('cursor')
  ));
  await page.locator('[data-analytics-remove-filter="country"]').click();
  expect((await response).status()).toBe(200);

  await expect(page.locator('.analytics-advanced-filters summary')).toHaveText('高级筛选（1）');
  await expect(page.locator('[data-analytics-remove-filter]')).toHaveCount(3);
  await expect(page.locator('[data-analytics-remove-filter="country"]')).toHaveCount(0);
  await expect(page.locator('[data-analytics-remove-filter="subdivision"]')).toHaveCount(0);
  await expect(page.locator('[data-analytics-remove-filter="city"]')).toHaveCount(0);
  await expect(page.locator('[data-analytics-remove-filter="browser"]')).toBeVisible();
  await expect(page.locator('#analytics-filter-form input[name="city"]')).toHaveValue('');
  await expect(page.locator('#analytics-event-table-body')).toContainText('needle');
  await expect(page.locator('[data-analytics-page="previous"]')).toBeDisabled();
  const url = new URL(page.url());
  expect(url.searchParams.get('opaque')).toBe('kept');
  expect(url.searchParams.get('limit')).toBe('1');
  expect(url.searchParams.has('cursor')).toBe(false);
});

test('failed country cascade keeps committed chips URL and rows; retry commits the exact cascade', async ({ page, request }) => {
  await request.post('/__test/analytics-reset');
  await page.goto('/admin/analytics?days=7&traffic=all&search=retry-remove&country=CN&subdivision=beijing&city=beijing&browser=chrome&limit=1&opaque=kept');
  const originalRows = await page.locator('#analytics-event-table-body').innerText();
  const originalUrl = page.url();
  const originalChipCount = await page.locator('[data-analytics-remove-filter]').count();

  const isExactCascade = url => (
    url.searchParams.get('search') === 'retry-remove' &&
    !url.searchParams.has('country') &&
    !url.searchParams.has('subdivision') &&
    !url.searchParams.has('city') &&
    url.searchParams.get('browser') === 'chrome' &&
    url.searchParams.get('limit') === '1' &&
    url.searchParams.get('opaque') === 'kept' &&
    !url.searchParams.has('cursor')
  );
  const failure = eventApiResponse(page, (url, response) => isExactCascade(url) && response.status() === 500);
  await page.locator('[data-analytics-remove-filter="country"]').click();
  await failure;

  await expect(page.locator('[data-analytics-remove-filter]')).toHaveCount(originalChipCount);
  await expect(page.locator('[data-analytics-remove-filter="country"]')).toBeVisible();
  await expect(page.locator('[data-analytics-remove-filter="subdivision"]')).toBeVisible();
  await expect(page.locator('[data-analytics-remove-filter="city"]')).toBeVisible();
  expect(await page.locator('#analytics-event-table-body').innerText()).toBe(originalRows);
  expect(page.url()).toBe(originalUrl);
  await expect(page.locator('[data-analytics-retry]')).toBeVisible();

  const success = eventApiResponse(page, (url, response) => isExactCascade(url) && response.status() === 200);
  await page.locator('[data-analytics-retry]').click();
  await success;
  await expect(page.locator('[data-analytics-remove-filter="country"]')).toHaveCount(0);
  await expect(page.locator('[data-analytics-remove-filter="subdivision"]')).toHaveCount(0);
  await expect(page.locator('[data-analytics-remove-filter="city"]')).toHaveCount(0);
  expect(new URL(page.url()).searchParams.get('opaque')).toBe('kept');
});

test('long hostile filter values remain text-only chips', async ({ page }) => {
  const value = '"><img data-filter-chip-injected src=x onerror=alert(9)>' + '长'.repeat(180);
  await page.goto(`/admin/analytics?days=7&search=${encodeURIComponent(value)}&pathPrefix=${encodeURIComponent(value)}`);
  await expect(page.locator('[data-analytics-remove-filter="search"]')).toContainText(value);
  await expect(page.locator('[data-analytics-remove-filter="pathPrefix"]')).toContainText(value);
  await expect(page.locator('[data-filter-chip-injected]')).toHaveCount(0);
});

test('pending list request exposes loading state and disables all filter entry points', async ({ page }) => {
  await openAnalytics(page);
  await page.locator('#analytics-search').fill('slow');
  const requestPromise = page.waitForRequest(requestEvent => (
    new URL(requestEvent.url()).searchParams.get('search') === 'slow'
  ));
  await page.locator('#analytics-filter-form button[type="submit"]').first().click();
  await requestPromise;

  await expect(page.locator('#event-list')).toHaveAttribute('aria-busy', 'true');
  await expect(page.locator('#analytics-event-status')).toHaveAttribute('role', 'status');
  await expect(page.locator('#analytics-event-status')).toContainText('正在加载');
  await expect(page.locator('#analytics-search')).toBeDisabled();
  await expect(page.getByRole('radio', { name: '爬虫' })).toBeDisabled();
  await expect(page.locator('#analytics-filter-form select[name="device"]')).toBeDisabled();
  await expect(page.locator('.analytics-filter-shortcut').first()).toBeDisabled();
  await expect(page.locator('[data-analytics-page="next"]')).toBeDisabled();
  await expect(page.locator('#event-list')).toHaveAttribute('aria-busy', 'false');
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
    const input = document.querySelector('#analytics-search');
    input.disabled = false;
    input.value = 'latest';
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
    url.searchParams.has('cursor') &&
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

  await page.locator('#analytics-search').fill('edited-after-failure');
  const successResponse = eventApiResponse(page, (url, response) => (
    url.searchParams.get('search') === 'retry' && response.status() === 200
  ));
  await page.locator('[data-analytics-retry]').click();
  await successResponse;
  await expect(page.locator('#analytics-search')).toHaveValue('retry');
  await expect(page.locator('.analytics-applied-filters')).toContainText('retry');
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

for (const search of ['non-json', 'json-text', 'bad-shape', 'bad-item', 'bad-next-cursor', 'oversized-list']) {
  test(`malformed successful list response ${search} preserves committed results`, async ({ page }) => {
    await openAnalytics(page);
    const originalText = await page.locator('#analytics-event-table-body').innerText();
    const originalCardsText = await page.locator('#analytics-event-cards').innerText();
    await page.locator('#analytics-search').fill(search);
    const responsePromise = eventApiResponse(page, url => url.searchParams.get('search') === search);
    await page.locator('#analytics-filter-form button[type="submit"]').first().click();
    await responsePromise;

    await expect(page.locator('#analytics-event-table-body')).toHaveText(originalText);
    await expect(page.locator('#analytics-event-cards')).toHaveText(originalCardsText);
    await expect(page.locator('[data-analytics-retry]')).toBeVisible();
    expect(new URL(page.url()).searchParams.has('search')).toBe(false);
  });
}

test('production-compatible long and nullable list fields render successfully', async ({ page }) => {
  await openAnalytics(page);
  await page.locator('#analytics-search').fill('long-valid');
  const response = eventApiResponse(page, url => url.searchParams.get('search') === 'long-valid');
  await page.locator('#analytics-filter-form button[type="submit"]').first().click();
  await response;

  const expectedLength = await page.locator('#analytics-event-table-body code.analytics-break').nth(0).evaluate(node => node.textContent.length);
  expect(expectedLength).toBeGreaterThan(4096);
  await expect(page.locator('#analytics-event-table-body')).toContainText('未知');
  await expect(page.locator('[data-analytics-retry]')).toHaveCount(0);
  expect(new URL(page.url()).searchParams.get('search')).toBe('long-valid');
});

test('empty result and terminal page disable paging safely', async ({ page }) => {
  await openAnalytics(page);
  await page.locator('#analytics-search').fill('empty');
  const emptyResponse = eventApiResponse(page, url => url.searchParams.get('search') === 'empty');
  await page.locator('#analytics-filter-form button[type="submit"]').first().click();
  await emptyResponse;
  await expect(page.locator('.analytics-empty')).toBeVisible();
  await expect(page.locator('#analytics-event-table-body tr')).toHaveCount(0);
  await expect(page.locator('[data-analytics-page="next"]')).toBeDisabled();

  await page.locator('#analytics-search').fill('terminal');
  const resetResponse = eventApiResponse(page, url => url.searchParams.get('search') === 'terminal');
  await page.locator('#analytics-filter-form button[type="submit"]').first().click();
  await resetResponse;
  await goToNextPage(page);
  const terminalResponse = eventApiResponse(page, url => url.searchParams.has('cursor'));
  await page.locator('[data-analytics-page="next"]').click();
  await terminalResponse;
  await expect(page.locator('#analytics-event-summary')).toContainText('第 3 页');
  await expect(page.locator('[data-analytics-page="next"]')).toBeDisabled();
});

test('non-progressing next cursor is rejected without growing the stack', async ({ page }) => {
  await openAnalytics(page);
  await page.locator('#analytics-search').fill('same-cursor');
  const filterResponse = eventApiResponse(page, url => url.searchParams.get('search') === 'same-cursor');
  await page.locator('#analytics-filter-form button[type="submit"]').first().click();
  await filterResponse;
  const originalText = await page.locator('#analytics-event-table-body').innerText();
  const responsePromise = eventApiResponse(page, url => url.searchParams.has('cursor'));
  await page.locator('[data-analytics-page="next"]').click();
  await responsePromise;
  await expect(page.locator('#analytics-event-table-body')).toContainText('same-cursor');
  expect(await page.locator('#analytics-event-table-body').innerText()).toBe(originalText);
  await expect(page.locator('[data-analytics-retry]')).toBeVisible();
  await expect(page.locator('[data-analytics-page="previous"]')).toBeDisabled();
});

test('limit=1 enhanced paging uses the exact last-row tuple without gaps or duplicates', async ({ page }) => {
  await page.goto('/admin/analytics?days=7&traffic=all&limit=1');
  await expect(page.locator('#analytics-event-table-body tr')).toHaveCount(1);
  await expect(page.locator('#analytics-event-table-body')).toContainText('Fixture event 1');
  await page.reload();
  await expect(page.locator('#analytics-event-table-body')).toContainText('Fixture event 1');

  await page.locator('#analytics-search').fill('limited');
  const filterResponse = eventApiResponse(page, url => (
    url.searchParams.get('search') === 'limited' && url.searchParams.get('limit') === '1'
  ));
  await page.locator('#analytics-filter-form button[type="submit"]').first().click();
  await filterResponse;
  await expect(page.locator('#analytics-event-table-body')).toContainText('limited');
  await expect(page.locator('#analytics-event-table-body code.analytics-break').first()).toHaveText('/fixture/event-1');

  const nextResponse = eventApiResponse(page, url => (
    url.searchParams.has('cursor') && url.searchParams.get('limit') === '1'
  ));
  const nextRequest = page.waitForRequest(request => new URL(request.url()).searchParams.has('cursor'));
  await page.locator('[data-analytics-page="next"]').click();
  const requestUrl = new URL((await nextRequest).url());
  await nextResponse;
  const emittedCursor = requestUrl.searchParams.get('cursor');
  expect(decodeFixtureCursor(emittedCursor)).toEqual({
    observedAtUtc: fixtureRows[0].observedAtUtc,
    metricId: fixtureRows[0].metricId
  });
  await expect(page.locator('#analytics-event-table-body tr')).toHaveCount(1);
  await expect(page.locator('#analytics-event-table-body')).toContainText('limited');
  await expect(page.locator('#analytics-event-table-body code.analytics-break').first()).toHaveText('/fixture/event-2');
  await expect(page.locator('#analytics-event-table-body')).not.toContainText('/fixture/event-1');
  expect(new URL(page.url()).searchParams.get('limit')).toBe('1');
});

test('human detail uses dedicated text-only fields for hostile production values', async ({ page }) => {
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
  await expect(page.locator('#analytics-detail-page-title')).toHaveText('<img data-hostile-title src=x onerror=alert(1)>');
  await expect(page.locator('#analytics-detail-page-path')).toHaveText('/fixture/<script>alert(2)</script>');
  await expect(page.locator('#analytics-detail-traffic')).toHaveText('真人');
  await expect(page.locator('#analytics-detail-bot-name')).toHaveText('不适用');
  await expect(page.locator('#analytics-detail-referrer')).toHaveText('"><svg data-hostile-referrer onload=alert(3)>');
  await expect(page.locator('#analytics-detail-user-agent')).toHaveText('<iframe data-hostile-ua src=javascript:alert(4)>');
  await expect(page.locator('#analytics-detail-client-status')).toHaveText('客户端解析失败');
  await expect(page.locator('#analytics-detail-context-status')).toHaveText('真人访问未提供浏览器上下文');
  await expect(page.locator('#analytics-detail-json')).toContainText(eventId);
  await expect(page.locator('[data-hostile-title], [data-hostile-referrer], [data-hostile-ua]')).toHaveCount(0);
  expect(await page.evaluate(() => window.__analyticsInjectionExecuted || false)).toBe(false);
});

test('bot detail identifies crawler context absence with the approved copy', async ({ page }) => {
  await openAnalytics(page);
  const button = page.locator('#analytics-event-table-body .analytics-detail-button').nth(1);
  const eventId = await button.getAttribute('data-event-id');
  const detailResponse = page.waitForResponse(response => (
    new URL(response.url()).pathname === `/api/admin/analytics/events/${eventId}`
  ));
  await button.click();
  expect((await detailResponse).status()).toBe(200);

  await expect(page.locator('#analytics-detail-traffic')).toHaveText('爬虫');
  await expect(page.locator('#analytics-detail-bot-name')).toHaveText('Googlebot');
  await expect(page.locator('#analytics-detail-context-status')).toHaveText('爬虫未提供浏览器上下文');
  await expect(page.locator('#analytics-detail-user-agent')).toContainText('Googlebot');
});

test('invalid detail contract keeps the prior detail hidden and reports an error', async ({ page }) => {
  await openAnalytics(page);
  const button = page.locator('#analytics-event-table-body .analytics-detail-button').first();
  const eventId = await button.getAttribute('data-event-id');
  await page.route(`**/api/admin/analytics/events/${eventId}`, route => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ id: eventId })
  }));
  await button.click();
  await expect(page.locator('#analytics-detail-panel')).toBeHidden();
  await expect(page.locator('#analytics-detail-status')).toHaveAttribute('role', 'alert');
  await expect(page.locator('#analytics-detail-status')).toContainText('访问详情加载失败');
  await expect(page.locator('#analytics-detail-page-title')).toHaveText('');
});

test('latest detail wins when detail requests complete out of order', async ({ page, request }) => {
  await openAnalytics(page);
  const state = await (await request.get('/__test/analytics-detail-slow-state')).json();
  const buttons = page.locator('#analytics-event-table-body .analytics-detail-button');
  const slowId = await buttons.nth(0).getAttribute('data-event-id');
  const fastId = await buttons.nth(1).getAttribute('data-event-id');
  const slowRequest = page.waitForRequest(requestEvent => new URL(requestEvent.url()).pathname.endsWith(`/${slowId}`));
  await buttons.nth(0).click();
  await slowRequest;
  const fastResponse = page.waitForResponse(response => new URL(response.url()).pathname.endsWith(`/${fastId}`));
  await buttons.nth(1).click();
  await fastResponse;
  await expect(page.locator('#analytics-detail-id')).toHaveText(fastId);
  await request.get(`/__test/analytics-wait-detail-slow?after=${state.completed}`);
  await expect(page.locator('#analytics-detail-id')).toHaveText(fastId);
});

test('list request invalidates a pending detail request', async ({ page, request }) => {
  await openAnalytics(page);
  const state = await (await request.get('/__test/analytics-detail-slow-state')).json();
  const detail = page.locator('#analytics-event-table-body .analytics-detail-button').first();
  const detailId = await detail.getAttribute('data-event-id');
  const detailRequest = page.waitForRequest(requestEvent => new URL(requestEvent.url()).pathname.endsWith(`/${detailId}`));
  await detail.click();
  await detailRequest;
  await goToNextPage(page);
  await request.get(`/__test/analytics-wait-detail-slow?after=${state.completed}`);
  await expect(page.locator('#analytics-detail-panel')).toBeHidden();
  await expect(page.locator('#analytics-detail-id')).not.toHaveText(detailId);
});

test('failed popstate preserves committed rows and retry targets exact history intent', async ({ page, request }) => {
  await openAnalytics(page);
  await goToNextPage(page);
  const pageTwoText = await page.locator('#analytics-event-table-body').innerText();
  await request.post('/__test/analytics-fail-next-pop');
  const failure = eventApiResponse(page, (url, response) => !url.searchParams.has('cursor') && response.status() === 500);
  await page.goBack();
  await failure;
  expect(await page.locator('#analytics-event-table-body').innerText()).toBe(pageTwoText);
  await expect(page.locator('[data-analytics-page="previous"]')).toBeEnabled();
  await expect(page.locator('[data-analytics-page="next"]')).toBeEnabled();
  await expect(page.locator('[data-analytics-retry]')).toBeVisible();

  const retry = eventApiResponse(page, url => !url.searchParams.has('cursor'));
  await page.locator('[data-analytics-retry]').click();
  await retry;
  await expect(page.locator('#analytics-event-table-body')).toContainText('Fixture event 1');
  await expect(page.locator('[data-analytics-page="previous"]')).toBeDisabled();
});

for (const path of [
  '/admin/analytics?days=1&days=7',
  '/admin/analytics?cursor=',
  `/admin/analytics?cursor=${fixtureCursor(1)}&cursor=${fixtureCursor(2)}`,
  '/admin/analytics?cursor=abc',
  '/admin/analytics?limit=0',
  '/admin/analytics?limit=101',
  '/admin/analytics?traffic=robot'
]) {
  test(`invalid direct boot remains completely unenhanced ${path}`, async ({ page }) => {
    await page.goto(path);
    await expect(page.locator('#analytics-event-status')).toHaveAttribute('role', 'alert');
    await expect(page.locator('#analytics-event-status')).toContainText('筛选条件无效');
    expect(page.url()).toBe(`http://127.0.0.1:4173${path}`);
    expect(await page.evaluate(() => history.state)).toBeNull();
    expect(await page.locator('#event-list').getAttribute('data-analytics-enhancement')).toBe('disabled');
    expect(await page.locator('#analytics-filter-form').evaluate(form => {
      const event = new SubmitEvent('submit', { bubbles: true, cancelable: true });
      const dispatched = form.dispatchEvent(event);
      return { dispatched, defaultPrevented: event.defaultPrevented };
    })).toEqual({ dispatched: true, defaultPrevented: false });
    expect(await page.locator('[data-analytics-page="next"]').evaluate(node => node.tagName)).toBe('BUTTON');
    await expect(page.locator('#analytics-event-table-body tr')).toHaveCount(0);
  });
}

test('unknown valid cursor tuple applies the production strict keyset predicate', async ({ page }) => {
  const cursor = Buffer.from(JSON.stringify({
    observedAtUtc: '2026-07-17T06:00:00.000Z',
    metricId: 999
  })).toString('base64url');
  await page.goto(`/admin/analytics?days=7&limit=1&cursor=${cursor}`);
  await expect(page.locator('#analytics-event-table-body code.analytics-break').first()).toHaveText('/fixture/event-4');
});

test('unknown direct-query params remain opaque in URL and history state', async ({ page }) => {
  const path = '/admin/analytics?days=7&traffic=all&opaque=a%26b&opaque=second';
  await page.goto(path);
  expect(page.url()).toBe(`http://127.0.0.1:4173${path}`);
  expect(await page.evaluate(() => history.state.analytics.query)).toBe('days=7&traffic=all&opaque=a%26b&opaque=second');

  const response = eventApiResponse(page, url => (
    url.searchParams.getAll('opaque').join(',') === 'a&b,second' && url.searchParams.has('cursor')
  ));
  await page.locator('[data-analytics-page="next"]').click();
  await response;
  expect(new URL(page.url()).searchParams.getAll('opaque')).toEqual(['a&b', 'second']);
});

test('raw query and history-state query mismatch is rejected without a request', async ({ page }) => {
  await openAnalytics(page);
  const originalText = await page.locator('#analytics-event-table-body').innerText();
  const listRequests = [];
  page.on('request', request => {
    if (new URL(request.url()).pathname === '/api/admin/analytics/events') listRequests.push(request.url());
  });
  await page.evaluate(() => {
    history.pushState({ analytics: { cursor: null, cursorStack: [], query: 'days=7&opaque=state' } }, '', '/admin/analytics?days=7&opaque=url');
    dispatchEvent(new PopStateEvent('popstate', { state: history.state }));
  });
  await expect(page.locator('#analytics-event-status')).toContainText('历史状态无效');
  expect(await page.locator('#analytics-event-table-body').innerText()).toBe(originalText);
  expect(listRequests).toEqual([]);
  expect(page.url()).toBe('http://127.0.0.1:4173/admin/analytics?days=7&opaque=url');
});

test('duplicate and empty-cursor popstate queries are rejected without normalization', async ({ page }) => {
  await openAnalytics(page);
  const originalText = await page.locator('#analytics-event-table-body').innerText();
  for (const query of ['days=1&days=7', 'cursor=']) {
    await page.evaluate(rawQuery => {
      history.pushState({ analytics: { cursor: null, cursorStack: [], query: rawQuery } }, '', `/admin/analytics?${rawQuery}`);
      dispatchEvent(new PopStateEvent('popstate', { state: history.state }));
    }, query);
    await expect(page.locator('#analytics-event-status')).toContainText('历史状态无效');
    expect(await page.locator('#analytics-event-table-body').innerText()).toBe(originalText);
    expect(new URL(page.url()).search.slice(1)).toBe(query);
  }
});

test('malformed or mismatched popstate metadata retains committed rows and cursors', async ({ page }) => {
  await openAnalytics(page);
  const originalText = await page.locator('#analytics-event-table-body').innerText();
  const listRequests = [];
  page.on('request', request => {
    if (new URL(request.url()).pathname === '/api/admin/analytics/events') listRequests.push(request.url());
  });
  await page.evaluate(() => {
    history.pushState({ analytics: { cursor: 'wrong', cursorStack: ['bad cursor'], query: 'cursor=wrong' } }, '', '/admin/analytics?cursor=fixture-page-2');
  });
  await page.evaluate(() => dispatchEvent(new PopStateEvent('popstate', { state: history.state })));

  await expect(page.locator('#analytics-event-status')).toContainText('历史状态无效');
  expect(await page.locator('#analytics-event-table-body').innerText()).toBe(originalText);
  await expect(page.locator('[data-analytics-page="previous"]')).toBeDisabled();
  await expect(page.locator('[data-analytics-page="next"]')).toBeEnabled();
  expect(listRequests).toEqual([]);
});

test('rapid popstate target is not overwritten by an older pending list request', async ({ page, request }) => {
  await openAnalytics(page);
  const state = await (await request.get('/__test/analytics-slow-state')).json();
  await page.locator('#analytics-search').fill('slow');
  const slowRequest = page.waitForRequest(requestEvent => new URL(requestEvent.url()).searchParams.get('search') === 'slow');
  await page.locator('#analytics-filter-form button[type="submit"]').first().click();
  await slowRequest;

  await page.evaluate(() => history.pushState({ analytics: { cursor: null, cursorStack: [], query: '' } }, '', '/admin/analytics'));
  const popResponse = eventApiResponse(page, url => !url.searchParams.has('search'));
  await page.evaluate(() => dispatchEvent(new PopStateEvent('popstate', { state: history.state })));
  await popResponse;
  await request.get(`/__test/analytics-wait-slow?after=${state.completed}`);
  await expect(page.locator('#analytics-event-table-body')).toContainText('Fixture event 1');
  await expect(page.locator('#analytics-event-table-body')).not.toContainText('slow');
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

test('JavaScript-disabled country removal cascades geographic dependents and preserves unrelated filters and limit', async ({ browser }) => {
  const context = await browser.newContext({ javaScriptEnabled: false });
  const page = await context.newPage();
  try {
    await page.goto('http://127.0.0.1:4173/admin/analytics?days=7&traffic=bot&search=needle&country=CN&subdivision=beijing&city=beijing&browser=chrome&limit=1');
    await expect(page.locator('.analytics-advanced-filters summary')).toHaveText('高级筛选（4）');
    await expect(page.locator('[data-analytics-remove-filter]')).toHaveCount(6);
    const countryRemoval = page.getByRole('link', { name: '移除国家代码筛选：CN' });
    expect(await countryRemoval.getAttribute('href')).toContain('limit=1');
    await Promise.all([page.waitForNavigation(), countryRemoval.click()]);
    const url = new URL(page.url());
    expect(url.searchParams.has('country')).toBe(false);
    expect(url.searchParams.has('subdivision')).toBe(false);
    expect(url.searchParams.has('city')).toBe(false);
    expect(url.searchParams.get('browser')).toBe('chrome');
    expect(url.searchParams.get('search')).toBe('needle');
    expect(url.searchParams.get('traffic')).toBe('bot');
    expect(url.searchParams.get('limit')).toBe('1');
    expect(url.searchParams.has('cursor')).toBe(false);
    expect(url.hash).toBe('#event-list');
    await expect(page.locator('.analytics-advanced-filters summary')).toHaveText('高级筛选（1）');
    await expect(page.locator('[data-analytics-remove-filter]')).toHaveCount(3);
    await expect(page.locator('[data-analytics-remove-filter="browser"]')).toBeVisible();
    await expect(page.locator('#analytics-event-table-body')).toContainText('needle');
  } finally {
    await context.close();
  }
});

test('JavaScript-disabled limit=1 navigation preserves limit and visits the next event', async ({ browser }) => {
  const context = await browser.newContext({ javaScriptEnabled: false });
  const page = await context.newPage();
  try {
    await page.goto('http://127.0.0.1:4173/admin/analytics?days=7&traffic=all&limit=1');
    await expect(page.locator('#analytics-event-table-body')).toContainText('Fixture event 1');
    const next = page.locator('[data-analytics-page="next"]');
    await Promise.all([page.waitForNavigation(), next.click()]);
    expect(new URL(page.url()).searchParams.get('limit')).toBe('1');
    await expect(page.locator('#analytics-event-table-body tr')).toHaveCount(1);
    await expect(page.locator('#analytics-event-table-body')).toContainText('Fixture event 2');
    await expect(page.locator('#analytics-event-table-body')).not.toContainText('Fixture event 1');
    expect(await page.evaluate(() => location.hash)).toBe('#event-list');
  } finally {
    await context.close();
  }
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
    expect(new URL(page.url()).searchParams.has('cursor')).toBe(true);
    await expect(page).toHaveURL(/#event-list$/);
    await expect(page.locator('#analytics-event-table-body')).toContainText('Fixture event 3');
    expect(await page.evaluate(() => location.hash)).toBe('#event-list');
  } finally {
    await context.close();
  }
});

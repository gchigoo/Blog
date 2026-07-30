# Admin Visitor Analytics Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rebuild `/admin/analytics` so it opens with a human-vs-bot overview, immediately shows IP/article/device/time records, records and labels crawlers separately, and paginates/filter results without returning to the top of the page.

**Architecture:** Keep the existing Express/EJS/SQLite analytics module and keyset cursor API. Add a centralized User-Agent classifier and idempotent traffic-kind schema migration, keep all legacy overview fields human-only, enrich event pages in one batch, then progressively enhance the fully server-rendered event workspace with DOM-safe JSON updates and History API state. Existing detail retention, authentication, URL sanitization, GeoIP, and cache invalidation remain the system boundaries.

**Tech Stack:** Node.js 24, Express 5, EJS 6, better-sqlite3, Bowser, plain browser JavaScript, CSS, Node test runner, Playwright.

## Global Constraints

- `todayActiveVisitors` uses the `Asia/Shanghai` natural-day boundary and excludes bots.
- Selected-range aggregate totals preserve the existing hourly `access_metrics.bucket_utc` precision; the UI must not claim sub-hour precision.
- `uniqueHumanIps` uses retained human detail rows. When detail collection is disabled it is `null`; when detail coverage is incomplete the UI displays “至少 N 个” rather than presenting the count as complete.
- Legacy `pageViews`, `anonymousVisitors`, `byHour`, `byPage`, and `byDevice` remain human-only because bots were historically excluded before storage.
- `access_detail_dimension_metrics` remains a human-only aggregate; bot events never upsert into it and rebuilds filter `traffic_kind = 'human'`.
- Detailed event-list and event-detail APIs are unavailable while `ANALYTICS_DETAILS_ENABLED=false`, even if retained detail rows still exist.
- Bot events receive a server-side event ID and detail row but never receive a browser client-context token or script injection.
- Search is NFKC-trimmed, ASCII case-insensitive, Unicode literal-substring matching; `%`, `_`, and `\` are escaped with SQL `LIKE ... ESCAPE '\'`.
- Article title enrichment resolves all current `articles` rows, including drafts, because the surface is authenticated administration; absent or unparseable articles use “文章（已删除或未知）”.
- SSR/no-JavaScript navigation supplies a durable Next link ending in `#event-list`; enhanced JavaScript supplies Previous within the current history/session and browser Back/Forward restores URL state.
- All untrusted strings are rendered through EJS escaping or DOM `textContent`; `innerHTML`, `insertAdjacentHTML`, and `document.write` remain prohibited in `public/js/admin-analytics.js`.
- No new runtime dependency is introduced.
- Existing performance budgets remain: event-list p95 ≤ 250 ms, overview p95 ≤ 500 ms, overview JSON ≤ 256 KiB on the 100k fixture.
- Deployment documentation must warn that rolling back to pre-traffic-kind application code after bot collection starts requires restoring a pre-release database backup or deploying a compatibility filter.

---

## File Structure

### New files

- `server/analytics/client-classifier.js` — one source of truth for `human` vs `bot` and readable bot names.
- `server/analytics/traffic-schema.js` — idempotent traffic columns, indexes, and SQLite consistency triggers shared by versioned migration and startup initialization.
- `server/analytics/page-presentation.js` — fixed-page naming, article-slug extraction, batch title resolution, and event page view models.
- `test/analytics-client-classifier.test.js` — focused classifier behavior.
- `test/visual/admin-analytics-browser.spec.js` — real-browser pagination, history, failure, focus, and JavaScript-disabled fallback tests.

### Modified files

- `server/migrations.js` — schema version 2 invokes the shared analytics traffic migration when analytics tables already exist.
- `server/analytics/store.js` — latest aggregate schema, Beijing-day HMAC, human-only overview metrics, unique-IP coverage state.
- `server/analytics/repository.js` — latest detail schema, atomic traffic writes, human-only dimension aggregation.
- `server/analytics/middleware.js` — separate request eligibility from classification; store bots and suppress their context token.
- `server/analytics/query/analytics-query.js` — traffic/search parsing, strict errors, page enrichment, event response fields, query plans.
- `server/analytics/admin-api.js` — strict overview range handling, detail-disabled errors, enriched list/detail responses.
- `server/analytics/admin-page.js` — preserved filters, system status, anchored SSR pagination, details-disabled view state.
- `views/admin/analytics.ejs` — reordered information architecture, overview cards, responsive event table/cards, collapsed secondary analysis.
- `public/css/custom.css` — overview grid, event workspace, bot labels, mobile cards, overflow/focus/loading states.
- `public/js/admin-analytics.js` — event delegation, DOM-safe list rendering, AbortController, retry, cursor/history state, detail rendering.
- `test/analytics.test.js` — Beijing identity and aggregate-only bot collection.
- `test/analytics-context.test.js` — legacy migration, triggers, atomic traffic storage, retention.
- `test/analytics-collector.test.js` — detailed human/bot collection and token suppression.
- `test/analytics-query.test.js` — overview semantics, traffic/search/title queries, cursor stability, index and performance budgets.
- `test/analytics-browser.test.js` — authenticated API/SSR contract, no-store, escaped output, JS security invariant.
- `test/helpers/ejs-visual-harness.js` — deterministic overview, human/bot event pages, paginated API, delayed/failing fixtures.
- `test/visual/scenarios.js` — retain the existing analytics visual scenario; no duplicate scenario is needed.
- `test/visual/ejs-visual.spec.js` — add a no-document-overflow assertion for analytics.
- `playwright.config.js` — add the browser-interaction project.
- `package.json` — add the analytics browser test script to the full gate.
- `DEPLOY.md` and `README.md` — crawler semantics, metric precision/coverage, migration and rollback notes.
- `test/visual/view-style-manifest.json`, analytics snapshots under `test/visual/__snapshots__/`, `test/visual/baseline-manifest.json`, and `test/visual/baseline-index.html` — approved visual evidence.

---

### Task 1: Versioned Traffic Schema and Database Invariants

**Files:**
- Create: `server/analytics/traffic-schema.js`
- Modify: `server/migrations.js`
- Modify: `server/analytics/store.js`
- Modify: `server/analytics/repository.js`
- Test: `test/analytics-context.test.js`
- Test: `test/runtime-contract.test.js`

**Interfaces:**
- Produces: `migrateAnalyticsTrafficSchema(db): void`
- Produces DB columns: `access_metrics.traffic_kind`, `access_event_details.traffic_kind`, `access_event_details.bot_name`
- Produces indexes: `idx_access_metrics_traffic_bucket`, `idx_event_details_traffic_observed`, `idx_event_details_traffic_ip_observed`
- Produces triggers: `analytics_detail_traffic_insert_guard`, `analytics_detail_traffic_update_guard`
- Later tasks rely on `traffic_kind` values being exactly `human` or `bot` and bot detail rows having a non-empty `bot_name`.

- [ ] **Step 1: Add failing legacy-migration and invariant tests**

Extend `test/analytics-context.test.js` so the legacy fixture initializes twice and asserts the new schema:

```js
initializeAnalytics(db);
initializeAnalytics(db);

assert.equal(
  db.prepare("SELECT traffic_kind FROM access_metrics WHERE path = '/legacy'").get().traffic_kind,
  'human'
);
const metricColumns = new Set(db.prepare('PRAGMA table_info(access_metrics)').all().map(row => row.name));
const detailColumns = new Set(db.prepare('PRAGMA table_info(access_event_details)').all().map(row => row.name));
assert.ok(metricColumns.has('traffic_kind'));
assert.ok(detailColumns.has('traffic_kind'));
assert.ok(detailColumns.has('bot_name'));
for (const name of [
  'idx_access_metrics_traffic_bucket',
  'idx_event_details_traffic_observed',
  'idx_event_details_traffic_ip_observed'
]) {
  assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = ?").get(name));
}
```

Add direct-insert trigger assertions after creating one parent metric:

```js
const parent = db.prepare(`
  INSERT INTO access_metrics (bucket_utc, path, visitor_day_hmac, device_kind, traffic_kind)
  VALUES ('2026-07-17T00:00:00.000Z', '/', 'visitor', 'desktop', 'human')
`).run();
assert.throws(() => db.prepare(`
  INSERT INTO access_event_details (
    metric_id, event_id, observed_at_utc, method, request_path, full_url,
    url_sanitization_status, referrer_parse_status, status_code, duration_ms,
    ip_address, ip_family, geo_status, user_agent, accept_language,
    request_client_hints_json, client_parse_status, context_source,
    traffic_kind, bot_name
  ) VALUES (?, ?, ?, 'GET', '/', 'https://blog.example.com/', 'ok', 'missing',
    200, 1, '203.0.113.10', 4, 'not_found', 'Mozilla/5.0', '', '{}',
    'unknown', 'server', 'bot', 'Googlebot')
`).run(Number(parent.lastInsertRowid), 'f'.repeat(32), '2026-07-17T00:00:00.000Z'), /traffic classification/);
```

Update `test/runtime-contract.test.js` to expect `LATEST_SCHEMA_VERSION === 2` and verify `migrateDatabase()` applies version 2 idempotently when analytics tables already exist.

- [ ] **Step 2: Run the migration tests and verify RED**

Run:

```bash
node --test test/analytics-context.test.js test/runtime-contract.test.js
```

Expected: FAIL because `traffic_kind`, `bot_name`, version 2, indexes, and triggers do not exist.

- [ ] **Step 3: Implement the shared idempotent migration**

Create `server/analytics/traffic-schema.js` with table guards, column checks, indexes, and insert/update triggers. The core behavior must match:

```js
function migrateAnalyticsTrafficSchema(db) {
  if (tableExists(db, 'access_metrics')) {
    const metricColumns = columnNames(db, 'access_metrics');
    if (!metricColumns.has('traffic_kind')) {
      db.exec("ALTER TABLE access_metrics ADD COLUMN traffic_kind TEXT NOT NULL DEFAULT 'human' CHECK (traffic_kind IN ('human', 'bot'))");
    }
    db.exec(`
      UPDATE access_metrics SET traffic_kind = 'human'
      WHERE traffic_kind IS NULL OR traffic_kind NOT IN ('human', 'bot');
      CREATE INDEX IF NOT EXISTS idx_access_metrics_traffic_bucket
        ON access_metrics(traffic_kind, bucket_utc);
    `);
  }

  if (tableExists(db, 'access_event_details')) {
    const detailColumns = columnNames(db, 'access_event_details');
    if (!detailColumns.has('traffic_kind')) {
      db.exec("ALTER TABLE access_event_details ADD COLUMN traffic_kind TEXT NOT NULL DEFAULT 'human' CHECK (traffic_kind IN ('human', 'bot'))");
    }
    if (!detailColumns.has('bot_name')) {
      db.exec('ALTER TABLE access_event_details ADD COLUMN bot_name TEXT');
    }
    db.exec(`
      UPDATE access_event_details SET traffic_kind = 'human', bot_name = NULL
      WHERE traffic_kind IS NULL OR traffic_kind NOT IN ('human', 'bot');
      CREATE INDEX IF NOT EXISTS idx_event_details_traffic_observed
        ON access_event_details(traffic_kind, observed_at_utc DESC, metric_id DESC);
      CREATE INDEX IF NOT EXISTS idx_event_details_traffic_ip_observed
        ON access_event_details(traffic_kind, observed_at_utc, ip_address);
    `);
  }

  if (tableExists(db, 'access_metrics') && tableExists(db, 'access_event_details')) {
    createTrafficGuardTriggers(db);
  }
}
```

The trigger `WHEN` condition must reject:

```sql
NEW.traffic_kind <> (SELECT traffic_kind FROM access_metrics WHERE id = NEW.metric_id)
OR (NEW.traffic_kind = 'human' AND NEW.bot_name IS NOT NULL)
OR (NEW.traffic_kind = 'bot' AND NULLIF(TRIM(NEW.bot_name), '') IS NULL)
```

Modify the latest `CREATE TABLE` statements in `store.js` and `repository.js` to include the columns for new databases, and invoke `migrateAnalyticsTrafficSchema(db)` during startup initialization.

Add migration 2 to `server/migrations.js`:

```js
const { migrateAnalyticsTrafficSchema } = require('./analytics/traffic-schema');
const LATEST_SCHEMA_VERSION = 2;
// ...
[2, migrateAnalyticsTrafficSchema]
```

If analytics tables do not yet exist, migration 2 is a no-op; later `initializeAnalytics()` creates the latest schema and re-runs the idempotent migration.

- [ ] **Step 4: Make detail aggregation explicitly human-only**

Change `rebuildDetailDimensionMetrics()` to add:

```sql
WHERE d.traffic_kind = 'human'
```

Do not yet change runtime upsert behavior; Task 2 will make bot writes skip `dimensionRows()`.

- [ ] **Step 5: Run focused tests and verify GREEN**

Run:

```bash
node --test test/analytics-context.test.js test/runtime-contract.test.js
```

Expected: PASS with repeat initialization, legacy backfill, version 2, indexes, and triggers proven.

- [ ] **Step 6: Commit Task 1**

```bash
git add server/analytics/traffic-schema.js server/migrations.js server/analytics/store.js server/analytics/repository.js test/analytics-context.test.js test/runtime-contract.test.js
git commit -m "feat(analytics): migrate traffic classification schema"
```

---

### Task 2: Bot Classification, Beijing Visitor Identity, and Collection

**Files:**
- Create: `server/analytics/client-classifier.js`
- Create: `test/analytics-client-classifier.test.js`
- Modify: `server/analytics/middleware.js`
- Modify: `server/analytics/store.js`
- Modify: `server/analytics/repository.js`
- Modify: `test/analytics.test.js`
- Modify: `test/analytics-collector.test.js`
- Modify: `test/analytics-context.test.js`
- Modify: `test/analytics-browser.test.js`

**Interfaces:**
- Produces: `classifyClient(userAgent): Readonly<{ trafficKind: 'human'|'bot', botName: string|null }>`
- Changes: `recordMetric(db, { bucketUtc, path, visitorDayHmac, deviceKind, trafficKind })`
- Changes: `recordAccessEvent(db, event)` requires `event.trafficKind`; bot events require `event.botName`.
- Changes: `visitorDayHmac(clientIp, secret, now)` uses the Beijing calendar date.

- [ ] **Step 1: Write failing classifier tests**

Create `test/analytics-client-classifier.test.js` with exact named and fallback expectations:

```js
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
```

Use bounded generic matches such as `(?:^|[^a-z])(bot|crawler|spider)(?:[^a-z]|$)` so `RoboticsLabBrowser` is not a false positive, while explicit legacy tokens remain recognized.

- [ ] **Step 2: Write failing collection and Beijing-boundary tests**

In `test/analytics.test.js`, change the old “excludes ... bots” test so a bot public HTML request is stored, while admin/API/assets/failed requests remain excluded. Add the Beijing boundary:

```js
const beforeMidnight = Date.parse('2026-07-17T15:59:59.999Z');
const atMidnight = Date.parse('2026-07-17T16:00:00.000Z');
assert.notEqual(
  visitorDayHmac('203.0.113.10', 'test-secret', beforeMidnight),
  visitorDayHmac('203.0.113.10', 'test-secret', atMidnight)
);
assert.equal(
  visitorDayHmac('203.0.113.10', 'test-secret', atMidnight),
  visitorDayHmac('203.0.113.10', 'test-secret', atMidnight + 60_000)
);
```

In `test/analytics-collector.test.js`, add a detailed Googlebot request and assert:

```js
assert.equal(response.locals.analyticsEventId, '...');
assert.equal(response.locals.analyticsEventToken, undefined);
const bot = db.prepare(`
  SELECT m.traffic_kind AS metric_kind, d.traffic_kind AS detail_kind, d.bot_name,
         d.context_collected_at
  FROM access_metrics m JOIN access_event_details d ON d.metric_id = m.id
  WHERE d.event_id = ?
`).get(eventId);
assert.deepEqual(bot, {
  metric_kind: 'bot', detail_kind: 'bot', bot_name: 'Googlebot', context_collected_at: null
});
```

In `test/analytics-browser.test.js`, fetch a public page with a Googlebot User-Agent and assert the HTML contains neither `analytics-event-token` nor `/js/analytics-context.js`, while one bot detail row exists.

- [ ] **Step 3: Run the new tests and verify RED**

Run:

```bash
node --test test/analytics-client-classifier.test.js test/analytics.test.js test/analytics-collector.test.js test/analytics-browser.test.js
```

Expected: FAIL because bots are still excluded, tokens are still unconditional, and the HMAC date is UTC.

- [ ] **Step 4: Implement the classifier and collection flow**

Create `server/analytics/client-classifier.js` with explicit named rules before the generic fallback and return frozen objects.

In `middleware.js`:

- Remove bot matching from `isTrackableRequest()`.
- Capture and classify once after `captureRequestClient()`.
- Generate an event ID for all detailed events.
- Expose/sign the context token only when `trafficKind === 'human'`.
- Pass `trafficKind` and `botName` into the metric/detail event.

The setup must follow this shape:

```js
const classification = classifyClient(capturedClient.userAgent);
let eventId = null;
if (detailsEnabled) {
  eventId = tokenSigner.createEventId();
  res.locals = res.locals || {};
  res.locals.analyticsEventId = eventId;
  if (classification.trafficKind === 'human') {
    res.locals.analyticsEventToken = tokenSigner.sign(eventId, startedAt);
  }
}
```

When a non-success response clears analytics locals, clear both event ID and token.

In `store.js`, add a Beijing date helper implemented without process-local timezone dependence:

```js
const beijingDateFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit'
});
function beijingDateKey(now) {
  return beijingDateFormatter.format(new Date(now));
}
```

Use that key in `visitorDayHmac()`. Update `recordMetric()` to insert `traffic_kind`.

In `repository.js`, append `traffic_kind` and `bot_name` to `DETAIL_COLUMNS` and `detailValues()`. Insert `traffic_kind` into the parent metric in `recordAccessEvent()`. Only upsert dimensions for human events:

```js
if (event.trafficKind === 'human') {
  for (const [dimension, key, label] of dimensionRows(event)) {
    upsertDimension.run(dimension, key, event.bucketUtc, label);
  }
}
```

- [ ] **Step 5: Extend atomicity and retention assertions**

In `test/analytics-context.test.js`, make the event fixture default to `trafficKind: 'human', botName: null`; add one bot event and assert metric/detail consistency, no dimension increment, and cleanup removes expired bot rows through the existing cascade.

- [ ] **Step 6: Run focused tests and verify GREEN**

Run:

```bash
node --test test/analytics-client-classifier.test.js test/analytics.test.js test/analytics-collector.test.js test/analytics-context.test.js test/analytics-browser.test.js
```

Expected: PASS; named bots are stored and labelled, humans still collect browser context, and Beijing-day identity changes at 16:00 UTC.

- [ ] **Step 7: Commit Task 2**

```bash
git add server/analytics/client-classifier.js server/analytics/middleware.js server/analytics/store.js server/analytics/repository.js test/analytics-client-classifier.test.js test/analytics.test.js test/analytics-collector.test.js test/analytics-context.test.js test/analytics-browser.test.js
git commit -m "feat(analytics): record crawlers separately"
```

---

### Task 3: Human-Only Overview Metrics and Detail Coverage

**Files:**
- Modify: `server/analytics/store.js`
- Modify: `server/analytics/query/analytics-query.js`
- Modify: `server/analytics/admin-api.js`
- Modify: `server/analytics/admin-page.js`
- Modify: `server/analytics/module.js`
- Modify: `test/analytics-query.test.js`
- Modify: `test/analytics-browser.test.js`

**Interfaces:**
- Changes: `getOverview(db, now, days, retentionDays, geoData, detailsEnabled)`
- Produces overview fields: `todayActiveVisitors`, `uniqueHumanIps`, `humanPageViews`, `botPageViews`, `detailsAvailable`, `detailsComplete`
- Preserves: `pageViews === humanPageViews`; legacy dimensions are human-only.
- Produces `systemStatus` view model from the admin page router.

- [ ] **Step 1: Add failing mixed-traffic overview tests**

Extend `test/analytics-query.test.js` with human and bot events across Beijing midnight, repeated human IPs, and one legacy metric-only human row. Assert:

```js
const overview = getOverview(db, NOW, 7, 30, geoStatus, true);
assert.equal(overview.humanPageViews, 3);
assert.equal(overview.pageViews, overview.humanPageViews);
assert.equal(overview.botPageViews, 2);
assert.equal(overview.todayActiveVisitors, 2);
assert.equal(overview.uniqueHumanIps, 2);
assert.equal(overview.detailsAvailable, true);
assert.equal(overview.detailsComplete, false);
assert.equal(overview.anonymousVisitors, 3);
assert.ok(overview.byPage.every(row => row.path !== '/bot-only'));
assert.ok(overview.byDevice.every(row => row.deviceKind !== 'other'));
```

Add the disabled state:

```js
const disabled = getOverview(db, NOW, 7, 30, null, false);
assert.equal(disabled.uniqueHumanIps, null);
assert.equal(disabled.detailsAvailable, false);
assert.equal(disabled.detailsComplete, false);
```

Add an API integration assertion that `/api/admin/analytics/events` and `/events/:id` return HTTP 409 with `{ error: 'analytics_details_disabled' }` when the module is configured with details disabled.

- [ ] **Step 2: Run overview tests and verify RED**

Run:

```bash
node --test test/analytics-query.test.js test/analytics-browser.test.js
```

Expected: FAIL because overview fields/filtering/coverage and detail-disabled gates do not exist.

- [ ] **Step 3: Implement strict human overview queries**

In `store.js`:

- Strictly parse `days` through a shared exported `parseAnalyticsDays(value, retentionDays)` that accepts only decimal integer strings/numbers in range.
- Compute the selected range with the existing hour-bucket contract.
- Filter every legacy query with `traffic_kind = 'human'`.
- Compute bot totals separately.
- Compute Beijing today start as a UTC timestamp using the fixed UTC+8 offset; Beijing has no DST.
- Count human details and distinct IPs by joining parent metrics so range semantics match the hourly metric selection.

The overview result must include:

```js
const overview = {
  days: rangeDays,
  todayActiveVisitors: today.anonymousVisitors,
  uniqueHumanIps: detailsEnabled ? detail.uniqueHumanIps : null,
  humanPageViews: total.humanPageViews,
  botPageViews: bots.botPageViews,
  detailsAvailable: Boolean(detailsEnabled),
  detailsComplete: Boolean(detailsEnabled) && detail.humanDetailPageViews === total.humanPageViews,
  pageViews: total.humanPageViews,
  anonymousVisitors: total.anonymousVisitors,
  detailCoverage: {
    pageViews: detail.humanDetailPageViews,
    humanPageViews: detail.humanDetailPageViews,
    complete: Boolean(detailsEnabled) && detail.humanDetailPageViews === total.humanPageViews
  },
  // existing human-only byHour/byPage/byDevice and dimensions
};
```

Update `getOverviewDimensions()` to count only human detail aggregates; Task 2 already prevented bot upserts and rebuilds.

- [ ] **Step 4: Gate retained details when collection is disabled**

In `admin-api.js`, before list/detail queries:

```js
if (!config.detailsEnabled) {
  return res.status(409).json({ error: 'analytics_details_disabled' });
}
```

In `admin-page.js`, do not query retained events when disabled. Render:

```js
{ available: false, items: [], nextCursor: null }
```

Pass `detailsEnabled` to `getOverview()`. Build a separate `systemStatus` object containing `detailsEnabled`, Geo status, and a single warning severity/message for stale/missing/failed Geo data.

Hide time-range links that exceed `config.retentionDays`; pass `rangeOptions` derived from `[1, 7, 30].filter(days => days <= retentionDays)`, always including the configured retention value if none of the presets matches.

- [ ] **Step 5: Extend the 100k performance fixture**

Update bulk inserts in `test/analytics-query.test.js` to include `traffic_kind` in metrics/details and `bot_name` for bot rows. Add a mixed 10% bot distribution and assert the distinct-IP covering index appears in `EXPLAIN QUERY PLAN` for the overview IP query helper.

Keep the existing budgets unchanged.

- [ ] **Step 6: Run focused tests and verify GREEN**

Run:

```bash
node --test test/analytics-query.test.js test/analytics-browser.test.js
```

Expected: PASS with four explicit metrics, human-only legacy fields, partial coverage, strict ranges, and detail-disabled API behavior.

- [ ] **Step 7: Commit Task 3**

```bash
git add server/analytics/store.js server/analytics/query/analytics-query.js server/analytics/admin-api.js server/analytics/admin-page.js server/analytics/module.js test/analytics-query.test.js test/analytics-browser.test.js
git commit -m "feat(analytics): add human and crawler overview metrics"
```

---

### Task 4: Traffic/Search Filters and Page Title Enrichment

**Files:**
- Create: `server/analytics/page-presentation.js`
- Modify: `server/analytics/query/analytics-query.js`
- Modify: `server/analytics/admin-page.js`
- Modify: `server/analytics/admin-api.js`
- Modify: `test/analytics-query.test.js`
- Modify: `test/analytics-browser.test.js`

**Interfaces:**
- Produces: `presentEventPages(db, rows): Map<number, { kind, title, displayPath }>` keyed by `metric_id`
- Produces: `pagePresentationForPath(rawPath, articleTitles): { kind, title, displayPath }`
- Extends list query filters: `traffic: 'all'|'human'|'bot'`, `search: string|null`
- Extends errors: `{ code: 'invalid_filter', field, reason }`
- Extends list/detail item: `trafficKind`, `botName`, `page`

- [ ] **Step 1: Add failing parser and error-shape tests**

Extend `test/analytics-query.test.js`:

```js
assert.equal(parseEventListQuery({ traffic: 'bot' }, 30).filters.traffic, 'bot');
assert.equal(parseEventListQuery({ traffic: '' }, 30).filters.traffic, 'all');
assert.equal(parseEventListQuery({ search: '  部署_%\\  ' }, 30).filters.search, '部署_%\\');
assert.throws(
  () => parseEventListQuery({ traffic: 'robot' }, 30),
  error => error.code === 'invalid_filter' && error.field === 'traffic'
);
assert.throws(
  () => parseEventListQuery({ search: 'x'.repeat(257) }, 30),
  error => error.code === 'invalid_filter' && error.field === 'search'
);
```

Update browser API tests to expect compatibility plus safe details:

```js
assert.deepEqual(await invalid.json(), {
  error: 'invalid_filter', field: 'traffic', reason: 'unsupported_value'
});
```

- [ ] **Step 2: Add failing search, page mapping, and cursor tests**

Create a minimal `articles` table in the analytics query test fixture if it does not exist, then seed published/draft/renamed titles. Add events for `/`, `/about`, `/archive`, `/tag/%E5%B7%A5%E5%85%B7`, known article paths, and a missing article path.

Assert:

```js
const botOnly = listEvents(db, NOW, parseEventListQuery({ traffic: 'bot' }, 30));
assert.ok(botOnly.items.every(item => item.trafficKind === 'bot'));
assert.equal(botOnly.items[0].botName, 'Googlebot');

assert.equal(listEvents(db, NOW, parseEventListQuery({ search: '113.10' }, 30)).items.length, 1);
assert.equal(listEvents(db, NOW, parseEventListQuery({ search: '部署' }, 30)).items[0].page.title, 'Node.js 部署指南（新版）');
assert.equal(listEvents(db, NOW, parseEventListQuery({ search: '/article/node' }, 30)).items.length, 1);
assert.equal(listEvents(db, NOW, parseEventListQuery({ search: '%' }, 30)).items.length, 0);

assert.deepEqual(home.page, { kind: 'home', title: '首页', displayPath: '/' });
assert.equal(tag.page.title, '标签：工具');
assert.equal(missing.page.title, '文章（已删除或未知）');
```

Use `limit: '1'` with `traffic` and `search` to prove the next cursor remains stable within the filtered result set.

- [ ] **Step 3: Run query/API tests and verify RED**

Run:

```bash
node --test test/analytics-query.test.js test/analytics-browser.test.js
```

Expected: FAIL because the filters, structured errors, traffic fields, and page view model are missing.

- [ ] **Step 4: Implement strict filter parsing and LIKE escaping**

Change `invalidFilter()` to accept safe metadata:

```js
function invalidFilter(field, reason = 'invalid_value') {
  throw Object.assign(new Error('invalid_filter'), { code: 'invalid_filter', field, reason });
}
```

Every parser branch must name its field. Add:

```js
function escapeLike(value) {
  return value.replaceAll('\\', '\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_');
}
```

Parse `traffic` and `search`, preserving exact IP filtering separately. In SQL:

```sql
(d.ip_address LIKE ? ESCAPE '\' COLLATE NOCASE
 OR d.request_path LIKE ? ESCAPE '\' COLLATE NOCASE
 OR d.request_path IN (...article paths...))
```

Article-title matching is a prequery against all current `articles` rows:

```sql
SELECT slug FROM articles
WHERE title LIKE ? ESCAPE '\' COLLATE NOCASE
ORDER BY slug
```

Convert each slug to both `/article/${slug}` and `/article/${encodeURIComponent(slug)}` and deduplicate before building bound `IN` parameters. If no `articles` table exists in a minimal test database, title matching yields no paths rather than throwing.

- [ ] **Step 5: Implement one-batch page presentation**

Create `page-presentation.js` that:

- recognizes `/`, `/about`, `/archive`, `/tags`, `/tag/<value>`;
- extracts article slugs only from a single `/article/<slug>` segment;
- safely decodes percent encoding;
- performs one `SELECT slug, title FROM articles WHERE slug IN (...)` for all unique selected slugs;
- resolves draft and published rows;
- returns the missing-article fallback.

`listEvents()` must select raw rows, slice the page, call the batch resolver once, then map rows. `getEventDetail()` uses the same resolver for one row. Add `traffic_kind` and `bot_name` to `LIST_FIELDS`.

- [ ] **Step 6: Preserve filters in SSR and API URLs**

Add `search` and `traffic` to `FILTER_NAMES`, filter view models, and Next URLs. Append `#event-list` to `eventNextUrl`. API errors retain `error: 'invalid_filter'` and add `field`/`reason`.

- [ ] **Step 7: Re-run query plans and performance tests**

Add query-plan cases for `traffic=bot` and `traffic=human` combined with country/browser/path filters. The planner may choose either the traffic index or the existing selective dimension index; assert that it uses an analytics index and does not report an unindexed full detail-table scan.

Run:

```bash
node --test test/analytics-query.test.js test/analytics-browser.test.js
```

Expected: PASS within the existing 100k budgets.

- [ ] **Step 8: Commit Task 4**

```bash
git add server/analytics/page-presentation.js server/analytics/query/analytics-query.js server/analytics/admin-page.js server/analytics/admin-api.js test/analytics-query.test.js test/analytics-browser.test.js
git commit -m "feat(analytics): search visits and resolve article titles"
```

---

### Task 5: Server-Rendered Overview-First Analytics Workspace

**Files:**
- Modify: `views/admin/analytics.ejs`
- Modify: `public/css/custom.css`
- Modify: `server/analytics/admin-page.js`
- Modify: `test/analytics-browser.test.js`
- Modify: `test/helpers/ejs-visual-harness.js`

**Interfaces:**
- Stable workspace root: `#event-list.analytics-event-workspace`
- Stable result summary: `#analytics-event-summary`
- Stable list containers: `#analytics-event-table-body`, `#analytics-event-cards`
- Stable paging controls: `[data-analytics-page="previous"]`, `[data-analytics-page="next"]`
- Stable local status/error: `#analytics-event-status`
- Filter form retains `#analytics-filter-form`.

- [ ] **Step 1: Add failing SSR structure and escaping assertions**

Extend the EJS render test in `test/analytics-browser.test.js` to assert the order and controls:

```js
const overviewIndex = html.indexOf('id="analytics-overview"');
const eventsIndex = html.indexOf('id="event-list"');
const moreIndex = html.indexOf('id="analytics-more"');
const systemIndex = html.indexOf('id="analytics-system-status"');
assert.ok(overviewIndex >= 0 && overviewIndex < eventsIndex);
assert.ok(eventsIndex < moreIndex && moreIndex < systemIndex);
assert.match(html, /今日活跃访客/);
assert.match(html, /独立 IP/);
assert.match(html, /真人访问量/);
assert.match(html, /爬虫访问量/);
assert.match(html, /name="search"/);
assert.match(html, /name="traffic"/);
assert.match(html, /<details[^>]*id="analytics-more"/);
assert.match(html, /href="[^"]*#event-list"/);
assert.match(html, /文章（已删除或未知）/);
assert.match(html, /data-traffic-kind="bot"/);
```

Retain hostile title/path/referrer assertions and the prohibition on unescaped HTML.

Add a details-disabled SSR test asserting the four aggregate cards remain, unique IP says “未启用访问明细”, and no raw IP/event table is rendered.

- [ ] **Step 2: Run SSR tests and verify RED**

Run:

```bash
node --test test/analytics-browser.test.js test/admin-view-security.test.js
```

Expected: FAIL because the current view order, cards, responsive markup, and controls are absent.

- [ ] **Step 3: Rebuild the EJS information hierarchy**

Rewrite `views/admin/analytics.ejs` in this exact order:

1. `<header class="analytics-heading">` with compact copy, allowed range links, and an optional warning link.
2. `<section id="analytics-overview" class="analytics-overview-grid">` with four cards.
3. `<section id="event-list" class="analytics-event-workspace" aria-busy="false">` containing search, traffic shortcuts, `<details>` advanced filters, applied-filter summary, result status, desktop table, mobile cards, and pagination.
4. `<details id="analytics-more">` containing page ranking and seven dimension cards.
5. `<section id="analytics-system-status">` containing detail collection and GeoLite2 status.
6. Existing detail status/panel.

For unique IP:

```ejs
<% if (!overview.detailsAvailable) { %>
  未启用访问明细
<% } else if (!overview.detailsComplete) { %>
  至少 <%= overview.uniqueHumanIps %> 个
<% } else { %>
  <%= overview.uniqueHumanIps %> 个
<% } %>
```

For every event render both a desktop row and mobile card from the same escaped model. The desktop columns are time, page, IP/location, client, action. Referrer appears only in detail.

Bot rows/cards include `data-traffic-kind="bot"`, visible text “爬虫”, and `event.botName`; they must not rely on color alone.

- [ ] **Step 4: Add responsive and accessible CSS**

Replace the analytics summary flex rules with a four/two/one-column grid. Add focused classes for cards, filters, table, mobile event cards, bot labels, loading states, focus outlines, and long-value wrapping.

At `max-width: 767px`:

```css
.analytics-event-table { display: none; }
.analytics-event-cards { display: grid; }
```

Above the breakpoint:

```css
.analytics-event-table { display: table; }
.analytics-event-cards { display: none; }
```

Ensure event card descendants use `min-width: 0`, `overflow-wrap: anywhere`, and no page-level `white-space: nowrap` inheritance.

- [ ] **Step 5: Expand deterministic visual fixtures**

Update `analyticsViewModel()` with:

- `todayActiveVisitors`, `uniqueHumanIps`, `humanPageViews`, `botPageViews`;
- one human article event;
- one Googlebot article event;
- one IPv6 mobile event with a long Unicode article title/path;
- `trafficKind`, `botName`, and `page` structures;
- `events.available`, `filters.search`, `filters.traffic`, `rangeOptions`, and `systemStatus`.

No visual snapshots are updated in this task; Task 7 owns approved evidence regeneration.

- [ ] **Step 6: Run SSR/unit tests and verify GREEN**

Run:

```bash
node --test test/analytics-browser.test.js test/admin-view-security.test.js
npm run lint
npm run typecheck
```

Expected: PASS. Snapshot/hash gates are expected to remain red until Task 7 and must not be updated early.

- [ ] **Step 7: Commit Task 5**

```bash
git add views/admin/analytics.ejs public/css/custom.css server/analytics/admin-page.js test/analytics-browser.test.js test/helpers/ejs-visual-harness.js
git commit -m "feat(analytics): prioritize overview and visit records"
```

---

### Task 6: DOM-Safe AJAX Pagination, Retry, and Browser History

**Files:**
- Modify: `public/js/admin-analytics.js`
- Modify: `test/helpers/ejs-visual-harness.js`
- Create: `test/visual/admin-analytics-browser.spec.js`
- Modify: `playwright.config.js`
- Modify: `package.json`
- Modify: `test/analytics-browser.test.js`

**Interfaces:**
- History state: `{ analytics: { cursor, cursorStack, query } }`
- API list URL: `/api/admin/analytics/events?<current filters and cursor>`
- Local retry button: `[data-analytics-retry]`
- DOM updates use `createElement`, `replaceChildren`, and `textContent` only.

- [ ] **Step 1: Add a deterministic paginated browser harness**

Before changing production JS, extend `test/helpers/ejs-visual-harness.js` with `/api/admin/analytics/events` that:

- returns page 1, 2, or 3 based on fixture cursors;
- echoes filtered `traffic` and `search` states;
- delays a request when `search=slow`;
- returns HTTP 500 once for `search=retry`, then succeeds;
- returns `{ error: 'invalid_filter', field: 'search', reason: 'too_long' }` for `search=invalid`.

Keep response shapes identical to production `listEvents()`.

- [ ] **Step 2: Write failing real-browser interaction tests**

Create `test/visual/admin-analytics-browser.spec.js` with tests for:

```js
test('next page updates only the event workspace and preserves scroll', async ({ page }) => {
  await page.goto('/admin/analytics');
  await page.locator('#event-list').scrollIntoViewIfNeeded();
  const before = await page.evaluate(() => window.scrollY);
  await page.getByRole('button', { name: '下一页' }).click();
  await expect(page.locator('#analytics-event-summary')).toContainText('第 2 页');
  expect(await page.evaluate(() => window.scrollY)).toBe(before);
  await expect(page).toHaveURL(/cursor=fixture-page-2/);
});
```

Also cover:

- enhanced Previous returns page 1;
- browser Back/Forward restores rows and URL without adding history entries;
- filter submit clears the cursor stack;
- delayed old request cannot overwrite a newer request;
- one-time 500 keeps old rows and retry succeeds;
- invalid filter keeps user input and old rows;
- updated detail buttons still work through event delegation;
- result summary receives focus with `preventScroll` behavior;
- JavaScript-disabled Next navigation reloads at `#event-list`.

- [ ] **Step 3: Register the Playwright project and verify RED**

Add a Chromium project named `admin-analytics-browser` matching `/admin-analytics-browser\.spec\.js/` at 1440×900. Add:

```json
"test:analytics-browser-ui": "playwright test admin-analytics-browser.spec.js --project=admin-analytics-browser"
```

Include it in `test:ejs-upgrade-gate` before the snapshot suites.

Run:

```bash
npm run test:analytics-browser-ui
```

Expected: FAIL because current JavaScript performs full-page form/navigation and cannot update dynamic rows/history.

- [ ] **Step 4: Implement stable event delegation and DOM-safe renderers**

Refactor `admin-analytics.js` around the stable `#event-list` root. Use one click handler for:

- dimension shortcut buttons;
- detail buttons in initial or replaced markup;
- Previous/Next;
- retry.

Create element helpers such as:

```js
function element(tagName, className, text) {
  const node = document.createElement(tagName);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}
```

Render desktop rows and mobile cards from the same item without HTML strings. Clear/hide an open detail panel after a successful list replacement.

Keep and extend the source-level security assertion:

```js
assert.doesNotMatch(source, /innerHTML|insertAdjacentHTML|document\.write/);
assert.match(source, /replaceChildren/);
assert.match(source, /textContent/);
```

- [ ] **Step 5: Implement request, retry, and race semantics**

Maintain one active `AbortController` and monotonically increasing request ID. Before fetch:

- leave old rows in place;
- set `aria-busy="true"`;
- disable paging/filter buttons;
- announce loading.

On success:

- replace rows/cards/summary/pagination only;
- update current cursor and next cursor;
- clear local error;
- focus the summary with `summary.focus({ preventScroll: true })`, falling back to focus without scrolling only when needed.

On error:

- keep old rows, URL, cursors, and scroll position;
- render a retry button;
- preserve invalid control values;
- ignore `AbortError` silently.

- [ ] **Step 6: Implement URL and history state**

Serialize all non-empty filters plus the current cursor into the URL. For user actions call `history.pushState`; for initial boot call `replaceState`; on `popstate`, fetch the URL state without another push.

Use:

```js
{
  analytics: {
    cursor: currentCursor,
    cursorStack: [...cursorStack],
    query: params.toString()
  }
}
```

Changing filters removes `cursor`, resets `cursorStack`, and starts page 1. Next pushes the old cursor onto the stack. Previous pops and fetches that cursor. A refresh can restore the current page from the URL; the enhanced Previous stack is session/history state only.

- [ ] **Step 7: Run browser and unit tests and verify GREEN**

Run:

```bash
node --test test/analytics-browser.test.js
npm run test:analytics-browser-ui
npm run lint
npm run typecheck
```

Expected: PASS with no scroll jump, safe dynamic DOM, retry, race protection, and Back/Forward restoration.

- [ ] **Step 8: Commit Task 6**

```bash
git add public/js/admin-analytics.js test/helpers/ejs-visual-harness.js test/visual/admin-analytics-browser.spec.js playwright.config.js package.json test/analytics-browser.test.js
git commit -m "feat(analytics): paginate visit records without reloads"
```

---

### Task 7: Deployment Documentation, Visual Evidence, and Full Verification

**Files:**
- Modify: `README.md`
- Modify: `DEPLOY.md`
- Modify: `test/visual/ejs-visual.spec.js`
- Modify: `test/visual/view-style-manifest.json`
- Modify: `test/visual/__snapshots__/ejs-html.spec.js/html-snapshots/admin-analytics.html`
- Modify: analytics layout/PNG snapshots in all six project directories under `test/visual/__snapshots__/ejs-visual.spec.js/`
- Modify: `test/visual/baseline-manifest.json`
- Modify: `test/visual/baseline-index.html`

**Interfaces:**
- Release evidence remains deterministic under the existing EJS 6.0.1 baseline contract.
- Full verification command remains `npm run test:ejs-upgrade-gate` and now includes analytics browser interactions.

- [ ] **Step 1: Document collection and rollback semantics**

Update `README.md` and `DEPLOY.md` with these exact operational facts:

- known crawlers are retained and labelled but excluded from human metrics;
- range aggregate counts retain hourly bucket precision;
- unique IP may display “至少 N 个” when the selected range includes metric-only history;
- detailed event APIs/UI are unavailable when `ANALYTICS_DETAILS_ENABLED=false`;
- migration command should be run before restart;
- after bot collection begins, rollback to pre-traffic-kind application code requires restoring the pre-release database backup or a compatibility patch that filters `traffic_kind`;
- deployment-day UTC-to-Beijing visitor-HMAC transition can affect at most one Beijing natural day and is not backfilled.

- [ ] **Step 2: Add explicit no-overflow visual assertion**

In `test/visual/ejs-visual.spec.js`, for the `admin-analytics` scenario assert:

```js
expect(await page.evaluate(() => ({
  documentWidth: document.documentElement.scrollWidth,
  viewportWidth: document.documentElement.clientWidth
}))).toEqual(expect.objectContaining({
  documentWidth: expect.any(Number),
  viewportWidth: expect.any(Number)
}));
expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
```

Also assert desktop projects show the table and mobile projects show cards.

- [ ] **Step 3: Run targeted visual tests and inspect failures before approval**

Run without updating snapshots:

```bash
npm run test:html-snapshots -- --grep admin-analytics
npm run test:visual -- --grep admin-analytics
```

Expected: snapshot differences only for the intentionally redesigned analytics page; no runtime error or horizontal-overflow assertion failure.

Inspect the generated diff screenshots under `test-results/ejs-visual/` before replacing baselines.

- [ ] **Step 4: Regenerate only approved analytics snapshots**

Run:

```bash
npx playwright test ejs-html.spec.js --project=html-snapshots --grep admin-analytics --update-snapshots
npx playwright test ejs-visual.spec.js --grep admin-analytics --update-snapshots
```

Verify that only `admin-analytics` HTML/layout/PNG files changed.

- [ ] **Step 5: Refresh frozen hashes and baseline evidence**

Update `test/visual/view-style-manifest.json` hashes for only:

- `views/admin/analytics.ejs`
- `public/css/custom.css`

Use Node’s `crypto.createHash('sha256')` over the exact files, preserving the manifest’s sorted JSON format.

Then run:

```bash
ALLOW_EJS_BASELINE_WRITE=1 npm run visual:evidence
npm run test:view-hashes
npm run test:baseline-manifest
```

Expected: PASS; the baseline manifest/index include the updated analytics artifacts while counts remain 18 HTML, 108 layouts, and 108 PNGs.

- [ ] **Step 6: Run the complete verification gate**

Run fresh:

```bash
npm run lint
npm run typecheck
npm test
npm run test:analytics-browser-ui
npm run test:html-snapshots
npm run test:visual
npm run test:view-hashes
npm run test:baseline-manifest
npm run test:ejs-upgrade-gate
git diff --check
```

Expected: every command exits 0. Record exact test counts and the 100k p95 diagnostics in the task report.

- [ ] **Step 7: Commit Task 7**

```bash
git add README.md DEPLOY.md test/visual/ejs-visual.spec.js test/visual/view-style-manifest.json test/visual/__snapshots__ test/visual/baseline-manifest.json test/visual/baseline-index.html
git commit -m "docs(analytics): document and baseline visitor dashboard"
```

---

## Plan Self-Review

### Spec coverage

- Overview-first layout: Tasks 3 and 5.
- Today DAU, selected-range IP, human views, crawler views: Task 3.
- Crawler storage/labels without contaminating human metrics: Tasks 1–3.
- Article title plus path: Task 4.
- Desktop table/mobile cards: Task 5.
- Search and advanced filters: Tasks 4–5.
- No-reload pagination, Previous, Back/Forward, retry, preserved scroll: Task 6.
- JavaScript-disabled anchored fallback: Tasks 4–6.
- Geo/detail system status and disabled state: Tasks 3 and 5.
- Security, performance, migration, rollback, retention: Tasks 1–4 and 7.
- Visual baselines and full gate: Task 7.

### Type and name consistency

- Traffic values are always `human|bot`; list filter additionally accepts `all`.
- `botName` is `null` for humans and non-empty for bots.
- Overview uses `todayActiveVisitors`, `uniqueHumanIps`, `humanPageViews`, `botPageViews`, `detailsAvailable`, `detailsComplete` in server, EJS, fixtures, and browser renderers.
- Event page model is always `{ kind, title, displayPath }`.
- Cursor remains the existing opaque `{ observedAtUtc, metricId }` base64url value.
- Stable DOM identifiers are defined once in Task 5 and consumed by Task 6.

### Scope

The seven tasks form one testable vertical feature. No external analytics service, identity system, charting framework, or new runtime dependency is introduced.

# Task 3 Report: Human-Only Overview Metrics and Detail Coverage

## Status

Implemented Task 3 on `master`, based on Task 2 commit `3aa7fb7`.

The analytics overview now separates human and bot page views, keeps every legacy overview aggregate human-only, reports Beijing-today active visitors, reports selected-range unique human IPs only when details are enabled, and exposes explicit detail availability/completeness. Retained-detail list/detail APIs and server-rendered detail controls are unavailable when detail collection is disabled.

No search, page-title mapping, or broader analytics UI redesign was implemented.

## RED Evidence

Command:

```bash
node --test test/analytics-query.test.js test/analytics-browser.test.js
```

Result before production implementation: **10 passed, 4 failed**.

Expected failures demonstrated the missing Task 3 behavior:

- Disabled retained-detail API returned HTTP 200 instead of HTTP 409.
- `overview.humanPageViews` was absent.
- `parseAnalyticsDays` was not implemented/exported.
- The overview distinct-IP query-plan helper was not implemented/exported.

Representative output:

```text
✖ admin retained-detail API and SSR are unavailable when details collection is disabled
AssertionError: 200 !== 409

✖ overview reports human metrics, bots, Beijing today, and partial detail coverage
AssertionError: undefined !== 4

✖ analytics day ranges accept only decimal integers within retention
TypeError: parseAnalyticsDays is not a function

✖ 100k event fixture stays within list/overview query and response budgets
TypeError: explainOverviewHumanIps is not a function
```

## Implementation

### Strict selected ranges

Updated `server/analytics/query/analytics-query.js` and `server/analytics/store.js`:

- Added shared exported `parseAnalyticsDays(value, retentionDays)`.
- Accepts only decimal integer strings or safe integer numbers within `1..retentionDays`.
- Uses `min(7, retentionDays)` only when the value is omitted.
- Invalid overview API ranges return HTTP 400 with `invalid_filter` rather than being silently truncated.
- Selected overview lower bounds are rounded up to the next complete hourly metric bucket, preserving the existing hour-bucket precision contract.
- Event-list range parsing now uses the same strict day parser.

### Human-only overview and bot totals

Updated `server/analytics/store.js`:

- All legacy overview queries now filter `access_metrics.traffic_kind = 'human'`:
  - `pageViews`
  - `anonymousVisitors`
  - `byHour`
  - `byPage`
  - `byDevice`
- Added separate `botPageViews` selected-range total.
- Added `humanPageViews` and preserved `pageViews === humanPageViews`.
- Added Beijing-today active visitor counting using a fixed UTC+8 midnight calculation.
- Bot-only paths and bot device categories cannot enter legacy overview dimensions.

### Detail coverage and unique human IPs

Updated `server/analytics/store.js` and `server/analytics/query/analytics-query.js`:

- Human detail coverage joins detail rows to parent metrics and applies the selected hourly metric range.
- `detailsComplete` is true only when details are enabled and detailed human page views equal selected human page views.
- Legacy metric-only human history therefore marks coverage incomplete.
- `uniqueHumanIps` is selected-range, human-only, and `null` when details are disabled.
- Disabled-detail overview cache entries are separated from enabled-detail cache entries.
- Overview output now includes:

```text
humanPageViews
botPageViews
todayActiveVisitors
uniqueHumanIps
detailsAvailable
detailsComplete
detailCoverage.pageViews
detailCoverage.humanPageViews
detailCoverage.complete
```

### Human-only detail dimensions

Updated `getOverviewDimensions()` in `server/analytics/query/analytics-query.js`:

- Uses the already hour-aligned selected lower bound supplied by the overview store.
- Continues querying Task 2's human-only aggregate table.
- Dimension totals remain bounded and reconcile to human detail coverage.

### Disabled retained-detail gates

Updated `server/analytics/admin-api.js`, `server/analytics/admin-page.js`, and `views/admin/analytics.ejs`:

- Authenticated `/api/admin/analytics/events` returns HTTP 409 with:

```json
{ "error": "analytics_details_disabled" }
```

- Authenticated `/api/admin/analytics/events/:eventId` returns the same HTTP 409 response.
- The admin page does not call `listEvents()` while details are disabled.
- The page receives `{ available: false, items: [], nextCursor: null }` for retained details.
- Detail filters, retained event table, detail panel, and detail JavaScript are not server-rendered while unavailable.
- `getOverview()` receives `detailsEnabled` explicitly from both API and page routes.

### Admin page view models

Updated `server/analytics/admin-page.js` and `views/admin/analytics.ejs`:

- Added a separate `systemStatus` view model containing detail availability, Geo status, and at most one warning.
- Warning precedence is stale dataset, missing reader, then failed/unavailable updater state.
- Removed multiple independent Geo warning branches from the template.
- Added `rangeOptions` based on `[1, 7, 30]`, excluding values above retention and including the configured retention value when it is not already a preset.
- Invalid page filters fall back through the shared retention-aware default parser.

## Test Coverage Added

Updated `test/analytics-query.test.js`:

- Mixed human and bot traffic.
- Bot-only page/device exclusion from legacy fields.
- Beijing midnight boundary for today's active visitors.
- Repeated/out-of-range human IP behavior.
- Legacy metric-only human history and incomplete detail coverage.
- Detail-disabled overview state.
- Strict decimal day range validation.
- 100k fixture with 10% bot traffic and `bot_name` population.
- Distinct-IP query-plan assertion for `idx_event_details_traffic_ip_observed`.
- Human-only dimension cardinality expectations.

Updated `test/analytics-browser.test.js`:

- HTTP 409 gates for disabled list/detail APIs.
- Disabled retained-detail SSR does not expose stored detail data or detail controls/scripts.
- Time-range links respect retention and include a non-preset configured retention value.
- Template renders only the single `systemStatus.warning` message.

## GREEN Evidence

Focused command:

```bash
node --test test/analytics-query.test.js test/analytics-browser.test.js
```

Final result:

```text
tests 15
pass 15
fail 0
```

Final focused performance diagnostic:

```text
100k list p95=0.49ms, cold overview+serialize p95=253.20ms, response=122986 bytes
```

All existing budgets remained unchanged and passed:

- Event list p95 budget: 250 ms.
- Cold overview plus serialization p95 budget: 500 ms.
- Overview response budget: 256 KiB.

## Performance Diagnostics

The 100k fixture now stores 90% humans and 10% bots in both parent metrics and detail rows. Bot detail rows include `bot_name`; rebuilt dimension aggregates remain human-only.

`EXPLAIN QUERY PLAN` for the overview IP helper includes:

```text
idx_event_details_traffic_ip_observed
```

A temporary self-review experiment removed the detail timestamp range predicate and relied only on the parent metric range. That caused the focused run to exceed the 120-second command timeout because the covering traffic/IP index could no longer bound the scan effectively. The predicate was restored. The final query keeps both the covering-index range predicate and the authoritative parent metric hourly-range join.

Final full-suite performance diagnostic was:

```text
100k list p95=0.54ms, cold overview+serialize p95=249.39ms, response=122986 bytes
```

## Full-Suite Result

Command:

```bash
npm test
```

Final result:

```text
tests 177
pass 176
fail 0
skipped 1
```

The one skipped test is the existing Linux/flock-only GeoIP updater integration test.

Additional final gates:

```bash
npm run lint
npm run typecheck
git diff --check
```

All passed.

## Self-Review

- Confirmed every legacy overview query in `store.js` filters `traffic_kind = 'human'`.
- Confirmed bot totals are calculated separately and do not affect legacy dimensions.
- Confirmed `pageViews` is assigned directly from `humanPageViews`.
- Confirmed selected range precision is hour-aligned once and reused by totals, detail coverage, dimensions, and distinct-IP parent matching.
- Confirmed Beijing today starts at 16:00 UTC and the fixture places metric-only history immediately before that boundary.
- Confirmed unique IP is `null`, not zero, when details are disabled.
- Confirmed metric-only human rows make `detailsComplete` and `detailCoverage.complete` false.
- Confirmed both retained-detail API endpoints gate before parsing/querying.
- Confirmed SSR does not call `listEvents()` or render retained-detail controls/scripts while disabled.
- Confirmed range links never exceed retention and include a non-preset retention value.
- Confirmed only one Geo warning can be rendered.
- Confirmed no search implementation, page-title mapping, or general UI redesign was added.
- Confirmed no schema or collection behavior from Tasks 1–2 was changed.
- Confirmed the final patch passes lint, typecheck, whitespace validation, focused tests, and the full suite.

## Concerns

- `todayActiveVisitors` uses the metric hour bucket. This intentionally follows the existing aggregate precision contract; an event inside the 15:00 UTC bucket but observed after 16:00 UTC would still belong to the pre-midnight bucket. Exact event-time "today" precision would require a different data contract and was not introduced in Task 3.
- The distinct-IP query retains a redundant-looking detail timestamp predicate to preserve the required covering-index plan and performance. Parent metric bucket matching remains the selected-range authority; the detail predicate uses the same hour-aligned lower bound and does not exclude correctly stored detail rows.
- Aggregate dimension tables contain only human rows because Task 2 guards both live upserts and rebuilds. Task 3 relies on that invariant and verifies mixed bot fixtures after rebuild.
- The template changes are limited to Task 3 availability/status/range behavior. Metric presentation redesign remains deferred.

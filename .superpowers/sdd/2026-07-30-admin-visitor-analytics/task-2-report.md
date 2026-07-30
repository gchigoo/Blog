# Task 2 Report: Bot Classification, Beijing Visitor Identity, and Collection

## Status

Implemented Task 2 on `master`, based on Task 1 commit `900545a`.

Bots are now classified and stored as analytics traffic, detailed bot events receive an event ID but no browser context token/script, human collection remains unchanged, visitor-day HMACs use the Beijing calendar date, and bot events do not increment human detail dimensions.

No overview query behavior, event-list filtering/search, or analytics UI behavior from later tasks was implemented.

## RED Evidence

Command:

```bash
node --test test/analytics-client-classifier.test.js test/analytics.test.js test/analytics-collector.test.js test/analytics-browser.test.js
```

Result: exit code `1`; 17 tests, 12 passed, 5 failed.

Relevant failures:

- `Cannot find module '../server/analytics/client-classifier'`.
- Bot public HTML produced no stored detail row.
- Detailed bot collection produced no event ID because bots were excluded before collection.
- Aggregate bot request produced no metric row.
- Visitor HMAC did not change at `2026-07-17T16:00:00.000Z`, showing the date key was still UTC rather than Beijing time.

Representative output:

```text
Error: Cannot find module '../server/analytics/client-classifier'
...
Expected values to be strictly deep-equal:
+ actual - expected
+ []
- [{ path: '/', traffic_kind: 'bot' }]
...
Expected "actual" to be strictly unequal to:
'4fba1e944641a7c48736dfa435197b2c31a9020d9755c9aaa1ed4f16838b1f44'
```

## Implementation

### Classifier

Created `server/analytics/client-classifier.js`:

- Exports `classifyClient(userAgent)`.
- Returns frozen `{ trafficKind, botName }` objects.
- Recognizes Googlebot, Applebot, Bingbot/bingpreview, Facebook crawler, and TelegramBot before fallback rules.
- Recognizes generic crawler/spider tokens and bounded standalone `bot`, plus legacy `slurp`, as `Other bot`.
- Keeps blank, ordinary browser, and ambiguous `RoboticsLabBrowser` user agents human.

### Collector middleware

Updated `server/analytics/middleware.js`:

- Removed bot exclusion from `isTrackableRequest()` while preserving method, admin/API/auth, asset/audio, internal-IP, successful-response, and HTML-content gates.
- Captures and classifies the request client once.
- Creates event IDs for all detailed events.
- Signs/exposes `analyticsEventToken` only for human traffic.
- Continues clearing both event ID and token for non-success rendering.
- Passes `trafficKind` to aggregate and detailed metrics and `botName` to detailed events.

### Beijing visitor identity

Updated `server/analytics/store.js`:

- Added an `Intl.DateTimeFormat` date key fixed to `Asia/Shanghai`.
- `visitorDayHmac()` now changes at Beijing midnight independently of the process timezone.
- `recordMetric()` now persists `traffic_kind` explicitly.

### Detailed repository collection

Updated `server/analytics/repository.js`:

- Added `traffic_kind` and `bot_name` to detailed insert columns/values.
- Persists the parent metric `traffic_kind` in the same transaction.
- Only increments detail dimension aggregates for human events.
- Existing Task 1 consistency triggers continue enforcing parent/detail classification and bot-name requirements.

### Test fixture compatibility

Updated `test/analytics-query.test.js` event fixtures with the newly required `trafficKind: 'human'` and `botName: null` fields. No overview-query or list-query behavior was changed.

## GREEN Evidence

Command:

```bash
node --test test/analytics-client-classifier.test.js test/analytics.test.js test/analytics-collector.test.js test/analytics-context.test.js test/analytics-browser.test.js
```

Result: exit code `0`; 29 tests passed, 0 failed.

```text
ℹ tests 29
ℹ pass 29
ℹ fail 0
ℹ duration_ms 212.455208
```

Additional query-fixture compatibility command:

```bash
node --test test/analytics-query.test.js
```

Result: exit code `0`; 6 tests passed, 0 failed, including the 100k-event performance fixture.

```text
ℹ tests 6
ℹ pass 6
ℹ fail 0
ℹ 100k list p95=0.41ms, cold overview+serialize p95=207.71ms, response=128759 bytes
```

Static validation:

```bash
npm run typecheck
npm run lint
```

Both commands exited `0` with no errors.

## Full-Suite Result

Command:

```bash
npm test
```

Result: exit code `0`.

```text
ℹ tests 174
ℹ pass 173
ℹ fail 0
ℹ skipped 1
ℹ duration_ms 8671.396125
```

The skipped test is the pre-existing Linux/flock-only GeoIP updater integration test.

## Files

Created:

- `server/analytics/client-classifier.js`
- `test/analytics-client-classifier.test.js`

Modified:

- `server/analytics/middleware.js`
- `server/analytics/store.js`
- `server/analytics/repository.js`
- `test/analytics.test.js`
- `test/analytics-collector.test.js`
- `test/analytics-context.test.js`
- `test/analytics-browser.test.js`
- `test/analytics-query.test.js`

## Self-Review

- Confirmed bots no longer bypass collection solely because of their User-Agent.
- Confirmed all existing public collection security gates remain: only GET/HEAD, public non-admin/non-API/non-auth paths, non-assets/audio, non-internal IPs, successful responses, and HTML content are stored.
- Confirmed detailed bot events receive a server-side event ID but no signed token, so the header partial emits neither the token meta element nor the context script.
- Confirmed human detailed events still receive tokens and attach browser context idempotently.
- Confirmed metric/detail traffic classifications are written atomically and remain protected by Task 1 database triggers.
- Confirmed bot events do not affect human dimension aggregates, including retention/cascade coverage.
- Confirmed Beijing visitor identity changes at 16:00 UTC for the tested July boundary and remains stable within the new Beijing day.
- Confirmed no production overview queries, list filters/search, admin APIs, or UI templates/scripts were changed.
- Ran `git diff --check`; no whitespace errors.

## Concerns

- Bot classification is intentionally User-Agent heuristic classification. Spoofed or novel agents may be classified incorrectly; this is expected for the required bounded rules.
- Generic `crawler` and `spider` matching is substring-based so required agents such as `ExampleCrawler/1.0` are detected, while standalone `bot` matching is bounded to avoid the specified `RoboticsLabBrowser` false positive.
- Aggregate-only mode stores bot metrics with `traffic_kind = 'bot'` but cannot store `bot_name` because that field exists only on detailed rows, matching the current schema and task scope.

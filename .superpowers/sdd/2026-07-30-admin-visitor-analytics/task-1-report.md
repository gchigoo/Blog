# Task 1 Report: Versioned Traffic Schema and Database Invariants

## Status

Completed on `master` in `/Users/steven/Blog` using strict TDD. The implementation is limited to Task 1 schema, migration, invariants, human-only detail rebuild behavior, and the test contract updates required by schema version 2. No classifier, collection, query, API, or UI work from later tasks was implemented.

## Implementation details

### Shared analytics traffic migration

Created `server/analytics/traffic-schema.js` with the exported interface:

- `migrateAnalyticsTrafficSchema(db): void`

The migration:

- Guards every operation by checking whether `access_metrics` and/or `access_event_details` exist.
- Adds `access_metrics.traffic_kind` when missing with default `human` and a `human`/`bot` check constraint.
- Adds `access_event_details.traffic_kind` when missing with the same allowed values and default.
- Adds nullable `access_event_details.bot_name` when missing.
- Backfills invalid or null legacy classifications to `human`; detail rows repaired this way also clear `bot_name`.
- Creates the required indexes idempotently:
  - `idx_access_metrics_traffic_bucket`
  - `idx_event_details_traffic_observed`
  - `idx_event_details_traffic_ip_observed`
- Creates the required insert and update guards idempotently:
  - `analytics_detail_traffic_insert_guard`
  - `analytics_detail_traffic_update_guard`
- Rejects detail rows when parent/detail traffic kinds differ, human rows have any bot name, or bot rows have a blank/missing bot name. Both triggers raise an error containing `traffic classification`.

### Versioned database migration

Updated `server/migrations.js`:

- Raised `LATEST_SCHEMA_VERSION` from `1` to `2`.
- Registered migration 2 as `[2, migrateAnalyticsTrafficSchema]`.
- Preserved migration transaction and idempotency behavior.
- Migration 2 remains a no-op when analytics tables do not exist; startup initialization later creates the latest tables and runs the shared migration.

### Latest startup schema

Updated `server/analytics/store.js`:

- New `access_metrics` tables include `traffic_kind TEXT NOT NULL DEFAULT 'human' CHECK (traffic_kind IN ('human', 'bot'))`.
- `initializeAnalytics()` invokes the shared migration before detail initialization so legacy metric tables receive `traffic_kind` before detail aggregate rebuilding can run.
- It invokes the migration again after detail initialization so newly created or legacy detail tables receive columns, indexes, and triggers.
- Existing runtime inserts are intentionally unchanged and therefore use the `human` default, as required until Task 2.

Updated `server/analytics/repository.js`:

- New `access_event_details` tables include `traffic_kind` and `bot_name`.
- `rebuildDetailDimensionMetrics()` now filters with `WHERE d.traffic_kind = 'human'`.
- Existing runtime upsert behavior was intentionally not changed; Task 2 owns bot-aware writes and dimension upsert suppression.

## Files changed

Required task files:

- Created: `/Users/steven/Blog/server/analytics/traffic-schema.js`
- Modified: `/Users/steven/Blog/server/migrations.js`
- Modified: `/Users/steven/Blog/server/analytics/store.js`
- Modified: `/Users/steven/Blog/server/analytics/repository.js`
- Modified: `/Users/steven/Blog/test/analytics-context.test.js`
- Modified: `/Users/steven/Blog/test/runtime-contract.test.js`

Existing contract tests updated after the full-suite run exposed intentional schema-version changes:

- Modified: `/Users/steven/Blog/test/analytics.test.js`
  - The no-raw-fields schema assertion now expects `traffic_kind` and verifies its legacy/default value is `human`.
- Modified: `/Users/steven/Blog/test/article-workflow.test.js`
  - The migration ledger assertion now expects versions `[1, 2]` and two rows.

## TDD evidence

### RED

Command:

```text
node --test test/analytics-context.test.js test/runtime-contract.test.js
```

Result before implementation:

- Exit code: `1`
- Tests: `6`
- Passed: `4`
- Failed: `2`
- `analytics schema migrates legacy metrics and records metric/detail atomically` failed with `SQLITE_ERROR` because `traffic_kind` was absent.
- `database migration applies analytics traffic schema version 2 idempotently` failed because the actual latest version was `1`, not `2`.

### GREEN: focused tests

Same command after implementation:

```text
node --test test/analytics-context.test.js test/runtime-contract.test.js
```

Result:

- Exit code: `0`
- Tests: `6`
- Passed: `6`
- Failed: `0`
- Duration: approximately `55 ms`

The focused tests prove repeated analytics initialization, legacy `human` backfill, required columns, required indexes, required trigger names, direct-insert mismatch rejection, version 2 registration, and migration idempotency.

### Full suite

Initial full-suite command:

```text
npm test
```

The first full run correctly exposed two stale existing expectations caused by the intentional schema change:

- `test/analytics.test.js` expected the old `access_metrics` column list without `traffic_kind`.
- `test/article-workflow.test.js` expected only migration version 1.

Those contract tests were minimally updated. A focused verification of those two files then passed `9/9` tests.

Final full-suite command:

```text
npm test
```

Final result:

- Exit code: `0`
- Tests: `162`
- Passed: `161`
- Failed: `0`
- Skipped: `1` (`Linux + flock integration only`)
- Duration: approximately `8.98 s`
- The 100k analytics performance test remained within its budgets.

Additional validation:

- `npm run lint` — passed.
- `npm run typecheck` — passed.
- `git diff --check` — passed.
- Manual invariant check — valid bot parent/detail insertion succeeded; attempts to blank `bot_name` or change the detail to `human` were rejected by the update trigger.

## Self-review

- Confirmed exact required column, index, and trigger names.
- Confirmed traffic values are constrained to exactly `human` or `bot` on newly created and altered tables.
- Confirmed both insert and update triggers use the required mismatch/label conditions and an error message matching `/traffic classification/`.
- Confirmed migration 2 safely records as applied when analytics tables do not yet exist and startup initialization subsequently applies the latest analytics schema.
- Confirmed legacy startup ordering avoids rebuilding detail dimensions before legacy detail tables receive `traffic_kind`.
- Confirmed detail dimension rebuilds are explicitly human-only.
- Confirmed runtime write/classifier/query/UI behavior was not broadened into later tasks.
- Confirmed no database files or unrelated generated artifacts are included.

## Concerns

- Existing runtime inserts still rely on the `human` default and do not write bot classifications. This is intentional and belongs to Task 2.
- Existing dimension upserts still run for every runtime event. This is also intentionally deferred to Task 2; only rebuilds are human-filtered in this task.
- SQLite cannot retrofit table-level constraints without rebuilding tables; the migration uses checked added columns plus triggers for parent/detail and bot-name consistency, matching the brief.
- The repository was already two commits ahead of `origin/master` before this task; this task does not alter or squash those prior commits.

## Review fix: parent-update invariant and expanded direct-SQL coverage

A Task 1 review identified that detail insert/update guards alone did not prevent a direct update of `access_metrics.traffic_kind` from making an existing metric/detail pair inconsistent. This follow-up remains limited to Task 1 database invariants and regression tests.

### Implementation

Updated `/Users/steven/Blog/server/analytics/traffic-schema.js` to create a third idempotent trigger:

- `analytics_metric_traffic_update_guard`

The trigger runs `BEFORE UPDATE OF traffic_kind ON access_metrics` and aborts with `traffic classification mismatch` when an existing detail row for the metric has a different `traffic_kind` from the proposed parent value. Parent rows without detail rows remain updateable, while any existing parent/detail pair cannot be made inconsistent through direct SQL.

Updated `/Users/steven/Blog/test/analytics-context.test.js` with direct-SQL coverage for:

- Detail/parent traffic-kind mismatch on insert.
- Human detail insertion with a non-null `bot_name`.
- Bot detail insertion with `NULL`, empty, and whitespace-only `bot_name`.
- Valid matching bot parent/detail insertion with non-empty `bot_name`.
- Detail update attempts setting bot names to `NULL`, empty, and whitespace-only values.
- Detail update attempt changing a bot detail to `human` while its parent remains `bot`.
- Parent update attempt changing the bot parent to `human` while its detail remains `bot`.
- Persistence of the valid bot classification after rejected direct updates.

Updated `/Users/steven/Blog/test/runtime-contract.test.js` to verify the versioned migration creates the new parent-update trigger idempotently.

### TDD RED evidence

Command before implementing the parent trigger:

```text
node --test test/analytics-context.test.js test/runtime-contract.test.js
```

Result:

- Exit code: `1`
- Tests: `6`
- Passed: `5`
- Failed: `1`
- Failure: `analytics schema migrates legacy metrics and records metric/detail atomically` could not find `analytics_metric_traffic_update_guard` in `sqlite_master`.

This demonstrated the reviewed parent-side database invariant was absent before the production change.

### GREEN evidence

Focused command after implementation:

```text
node --test test/analytics-context.test.js test/runtime-contract.test.js
```

Result:

- Exit code: `0`
- Tests: `6`
- Passed: `6`
- Failed: `0`
- Duration: approximately `56 ms`

Required production-code validation:

```text
npm run lint
npm run typecheck
git diff --check
```

All commands exited successfully with no lint, type, or whitespace errors.

### Review-fix self-review and concerns

- Confirmed all three trigger names are asserted after repeated startup initialization and versioned migration.
- Confirmed the new trigger is idempotent through `CREATE TRIGGER IF NOT EXISTS`.
- Confirmed the guard only blocks parent classification changes that would disagree with an existing detail; it does not prohibit classification changes for parent rows with no detail.
- Confirmed direct insert and update tests now cover both valid bot data and every requested invalid bot-name form.
- No later classifier, collection, query, API, or UI task was implemented.
- Existing runtime bot writes and dimension-upsert suppression remain intentionally deferred to Task 2.

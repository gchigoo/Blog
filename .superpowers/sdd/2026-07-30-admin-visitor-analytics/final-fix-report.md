# Visitor Analytics Final Fix Wave Report

**Date:** 2026-07-30

**Branch/worktree:** shared `master`
**Scope:** all three Important findings from `final-review.md`, plus practical adjacent Minor coverage in touched areas

## Status

All three release-blocking findings are resolved in one cohesive change. Focused regressions, the complete Node suite, the 49-case analytics browser suite, all HTML/visual baselines, view hashes, baseline integrity, the full EJS upgrade gate, and `git diff --check` pass.

No migration, persistence, privacy, retention, authentication, hourly-range, Beijing-day, keyset-cursor, or performance contract was changed. No dependency was added. No unrelated article-table refactor was performed.

## Finding mapping

### Important 1 — crawler classifier correctness

Resolved by:

- Preserving ordered brand-specific rules before the generic fallback.
- Adding stable readable names for `GPTBot`, `ClaudeBot`, `AhrefsBot`, `Twitterbot`, `YandexBot`, `Amazonbot`, and `PetalBot` while retaining Googlebot, Applebot, Bingbot/bingpreview, Facebook crawler, and TelegramBot.
- Replacing the inconsistent fallback with intentional ASCII token-ending semantics. A crawler token may be standalone or a compound token ending in `bot`, `crawler`, or `spider`; `slurp` remains an explicit generic token. The rule catches `ExampleBot`, `ExampleCrawler`, and `ExampleSpider`, but does not classify embedded product words such as `RoboticsLabBrowser`, `SpiderMonkey`, or `AcmeCrawlerToolkit`.
- Adding collection and aggregate regressions proving a previously missed `GPTBot` request is stored as bot traffic.
- Adding an adjacent parser-error regression proving a human `RoboticsLabBrowser` request remains human even when client parsing reports `error`.

### Important 2 — dedicated detail presentation

Resolved by:

- Adding dedicated accessible text fields for page title, page path, raw path, traffic type, bot name, referrer, full IP, parsed browser, raw User-Agent, client parse status, and browser-context status.
- Showing the exact approved bot copy `爬虫未提供浏览器上下文` when a bot has no client context.
- Keeping human absence distinct as `真人访问未提供浏览器上下文`, and parse errors distinct as `客户端解析失败`.
- Making raw JSON subordinate inside a collapsed native `<details>` disclosure.
- Populating all dynamic values through `textContent`; the source still contains no `innerHTML`, `insertAdjacentHTML`, or `document.write`.
- Clearing every dedicated detail field and raw JSON during successful list replacement/invalidation.
- Strengthening detail validation from ID-only checking to the production list contract plus raw, screen, viewport, and collection/status fields.
- Adding deterministic browser coverage for hostile title, path, referrer, and User-Agent strings, human and bot details, the exact bot context copy, invalid detail payload rejection, no injection, out-of-order detail sequencing, and list invalidation.

### Important 3 — advanced-filter count and individual removal

Resolved by:

- Rendering the SSR advanced-filter count in the disclosure summary.
- Rendering one escaped/text-only removable chip/link for each active search, non-default traffic filter, and advanced filter.
- Supplying accessible labels such as `移除城市筛选：beijing` and `移除完整 IP 筛选：203.0.113.10`.
- Providing useful no-JavaScript links that preserve unrelated filters and non-form `limit`, remove only one filter, clear the cursor, and return to `#event-list`.
- Routing enhanced removal through the existing delegated request/state machine.
- Building removal attempts from committed params rather than draft form values, preserving unknown/non-form params and `limit`, deleting cursor, resetting the cursor stack, and committing chips/count/form/URL/results only after a successful response.
- Preserving committed chips, URL, rows, and history on failure; retry repeats the exact removal attempt and commits only on success.
- Updating dynamic count/chips from staged committed attempt params.
- Adding browser coverage for count, one-at-a-time removal, URL/history state, cursor reset, preserved limit/other filters, failure/retry, long hostile values, and no-JavaScript fallback.

## Adjacent Minor coverage

Implemented where practical in touched areas:

- Direct HTTP invalid overview `days` regression (`days=7days` returns HTTP 400 and `{ error: 'invalid_filter' }`).
- Malformed and multi-segment article/tag presentation regressions.
- Direct NFKC title search regression using full-width/mixed-case `ｎＯＤＥ．ＪＳ`, plus explicit ASCII case-insensitive path and IP search assertions.
- Public browser fixture no longer serializes `metricId`; the tuple remains internal to fixture rows and opaque cursor encoding.
- Parser-error-human collector regression added as noted above.

Not performed:

- The duplicated article-table availability discovery was not refactored, per the review recommendation and explicit scope constraint.

## Strict TDD evidence

### RED

Focused Node command:

`node --test test/analytics-client-classifier.test.js test/analytics.test.js test/analytics-collector.test.js test/analytics-query.test.js test/analytics-browser.test.js`

Initial result: **42 passed, 11 failed**. Failures demonstrated:

- all requested common compound bots were classified as human;
- generic embedded crawler/spider words were overclassified;
- the aggregate collector stored `GPTBot` as human;
- SSR lacked advanced count/chips/removal links.

Initial browser run also failed on the new dedicated detail fields, bot-context copy, filter count/chips, removal/failure/retry, and no-JS removal scenarios. The browser RED run was intentionally stopped after clear failures; a stale harness process was then terminated before GREEN runs.

### GREEN

Focused Node result: **53/53 passed**.

Focused performance diagnostic from the GREEN run:

- event-list p95: **0.68 ms**
- cold overview + serialization p95: **330.23 ms**
- overview response: **122,986 bytes**

Focused analytics browser result: **49/49 passed**.

## Files changed

Production:

- `server/analytics/client-classifier.js`
- `server/analytics/admin-page.js`
- `views/admin/analytics.ejs`
- `public/js/admin-analytics.js`

Tests/fixtures:

- `test/analytics-client-classifier.test.js`
- `test/analytics.test.js`
- `test/analytics-collector.test.js`
- `test/analytics-query.test.js`
- `test/analytics-browser.test.js`
- `test/helpers/ejs-visual-harness.js`
- `test/visual/admin-analytics-browser.spec.js`

Deterministic evidence:

- analytics HTML snapshot
- analytics layout snapshots in all six projects
- analytics PNG snapshots in the projects whose screenshot bytes changed
- `test/visual/view-style-manifest.json`
- `test/visual/baseline-manifest.json`
- `test/visual/baseline-index.html`

This report is the only new documentation file and was explicitly requested.

## Visual evidence changes

Before baseline replacement, analytics-only HTML and visual tests were run without update and the generated desktop/mobile screenshots were inspected. The observed change was limited to the intended analytics workspace/detail markup; responsive overview/table/card layout and document overflow behavior remained sound.

To avoid unrelated asset-version churn, proposed shared CSS additions were removed. Existing analytics CSS already provided safe wrapping and usable presentation, so `public/css/custom.css` and every unrelated HTML baseline remained unchanged.

Accepted baseline scope:

- **1** analytics HTML snapshot
- **6** analytics layout snapshots
- **5** analytics PNG files with changed bytes (the desktop-4k PNG remained byte-identical)
- deterministic view/baseline manifests and index

Global evidence inventory remains:

- **18 HTML** baselines
- **108 layout** baselines
- **108 PNG** baselines
- **234 immutable baseline files** verified

## Complete verification

Fresh required sequence completed successfully:

- `npm run lint`
- `npm run typecheck`
- `npm test`
- `npm run test:analytics-browser-ui`
- `npm run test:html-snapshots`
- `npm run test:visual`
- `npm run test:view-hashes`
- `npm run test:baseline-manifest`
- `npm run test:ejs-upgrade-gate`
- `git diff --check`

Exact primary counts:

- Node suite: **195 tests, 194 passed, 1 platform skip, 0 failed**
- Analytics browser: **49 passed**
- HTML snapshots: **18 passed**
- Visual suite: **108 passed**
- Baseline integrity: **234 files verified**

Performance diagnostics from the fresh full sequence:

First `npm test`:

- event-list p95: **0.64 ms**
- cold overview + serialization p95: **324.63 ms**
- response: **122,986 bytes**

Nested full EJS upgrade gate:

- event-list p95: **0.70 ms**
- cold overview + serialization p95: **330.31 ms**
- response: **122,986 bytes**

All remain below the unchanged budgets of 250 ms, 500 ms, and 256 KiB.

## Self-review

- Classifier order is specific-before-generic, names are stable, generic semantics are documented, and positive/negative cases cover the requested agents and false-positive examples.
- Removal attempts derive from committed state, preserve non-form params, clear cursor/stack, and do not mutate form/chips/history/results before successful response commit.
- Failed removal leaves the exact committed UI and URL intact and keeps retry intent.
- Detail validation now rejects ID-only payloads and validates the production fields consumed by the UI.
- All hostile dynamic values flow through EJS escaping or `textContent`; prohibited DOM string APIs remain absent.
- Detail invalidation clears all dedicated fields and raw JSON after successful list replacement.
- The fixture exposes no public `metricId`; cursor tuple handling remains internal.
- No schema/query/index/retention/migration/authentication changes were made.
- No dependencies or unrelated article lookup refactors were introduced.
- Only intentional analytics baselines and deterministic evidence changed.

## Concerns / residual notes

- The generic classifier deliberately uses ASCII token-ending semantics. This is conservative for unusual non-ASCII concatenated agent names; known production brands should continue to be added as explicit ordered rules when needed.
- Human missing context and human parser errors are displayed separately. The raw JSON remains available under a collapsed disclosure for deeper diagnostics.
- No release-blocking concern remains from the final review findings.

## Residual geographic dependency fix

The scoped final re-review identified one dependency-ordering defect: a valid committed query may contain `country` together with dependent `subdivision` and `city`, but both removal paths previously deleted only `country`, producing an invalid request. The narrow residual fix applies the safest dependency rule consistently:

- removing `country` removes `country`, `subdivision`, and `city`;
- removing `subdivision` or `city` remains one-at-a-time;
- all unrelated filters, duplicate opaque query parameters, and non-form `limit` are preserved;
- cursor is removed and the enhanced cursor stack is reset;
- no-JavaScript links remain valid and anchored at `#event-list`.

The server now owns each chip's removal-name set and serializes it into the SSR chip metadata used by the enhanced client. The client validates that metadata against supported form filters, clones committed params, applies the complete removal set, and then uses the unchanged staged request/commit machinery. Failed country-cascade requests therefore leave rows, chips, form state, URL, and history untouched; retry replays the exact pending cascade and commits only after success. The deterministic visual fixture mirrors the same dependency rule, and the template-only fallback has the same country cascade for isolated rendering.

### Residual TDD evidence

RED was captured before production changes:

- Direct SSR/Node regression failed because the country removal link still retained `subdivision`/`city` (`true !== false`).
- Enhanced real-browser regression timed out waiting for a valid cascade request because the attempted request retained dependent geography and received HTTP 400.
- JavaScript-disabled browser regression navigated with `subdivision` still present (`Expected false, received true`).

GREEN coverage now includes:

- direct SSR link parsing and navigation with `country+subdivision+city` active, including unrelated filter, duplicate opaque parameter, `limit=1`, cursor absence, HTTP 200 results, and `#event-list`;
- enhanced country cascade after pagination with an unsubmitted draft edit, checking committed-state derivation, chip/count reduction, result replacement, opaque/filter/limit preservation, cursor removal, and Previous-stack reset;
- enhanced failed cascade plus exact retry, checking atomic rows/chips/URL behavior;
- JavaScript-disabled country cascade, valid list navigation, chip/count reduction, result rendering, unrelated filter/limit preservation, and anchor behavior;
- the existing city-removal regression, which continues to prove dependent filters remain individually removable.

### Residual verification

Fresh final verification completed successfully:

- `npm run lint`: pass
- `npm run typecheck`: pass
- `npm test`: **195 tests, 194 passed, 1 platform skip, 0 failed**
- `npm run test:analytics-browser-ui`: **50 passed**
- `npm run test:html-snapshots`: **18 passed**
- `npm run test:visual`: **108 passed**
- `npm run test:view-hashes`: **18 frozen view/style files and 8 pinned assets verified**
- `npm run test:baseline-manifest`: **234 immutable baseline files verified**
- `npm run test:ejs-upgrade-gate`: pass with the same counts
- `git diff --check`: pass

Only deterministic analytics evidence changed: the analytics HTML snapshot, its baseline-manifest hash, and the analytics template hash. Layout and PNG baselines remained byte-identical and unchanged. No schema, query, persistence, authentication, privacy, retention, or dependency changes were introduced.

## Dynamic chip metadata fix

The final residual confirmation exposed that enhanced removal dependencies were frozen from the chips present in initial SSR markup. A successful post-load filter submission rendered new chip buttons, but the previous client map had no entries for filters that were inactive at page load, so those newly activated chips could not initiate removal.

The client now defines a fixed allowlist of removable filter names and a fixed dependency map (`country` removes `country+subdivision+city`). Both initial and dynamically rendered chips use those known semantics. Dynamic chip rendering emits the corresponding metadata for consistency and inspection, while click handling derives removal names only from the fixed map and committed params; it does not trust mutable or arbitrary DOM metadata. The existing request state machine remains unchanged, preserving atomic failure/retry behavior, opaque parameters, `limit`, cursor removal, cursor-stack reset, and text-only DOM construction.

### Dynamic metadata TDD evidence

RED started from an unfiltered enhanced page. After submitting `country=CN`, `subdivision=beijing`, `city=beijing`, and `browser=chrome`, the chips rendered, but the new country chip had no `data-analytics-remove-names` value and could not perform removal. The direct browser assertion received `null` instead of `country,subdivision,city`.

GREEN browser coverage now proves:

- a page with no initial chips can enhanced-submit all three geography filters plus a non-geographic browser filter;
- every newly rendered chip is removable;
- the dynamically created country chip emits dependency metadata and, even after that DOM metadata is deliberately tampered, issues exactly one valid fixed-map cascade request from committed params;
- country, subdivision, and city chips disappear together while browser, opaque params, and `limit=1` remain;
- the newly activated browser chip then removes independently;
- existing SSR-initialized country cascade, city one-at-a-time removal, failed cascade/retry atomicity, and JavaScript-disabled behavior remain green.

### Dynamic metadata verification

Fresh final verification completed successfully:

- focused Node/SSR analytics tests: **14 passed**
- `npm run lint`: pass
- `npm run typecheck`: pass
- `npm test`: **195 tests, 194 passed, 1 platform skip, 0 failed**
- `npm run test:analytics-browser-ui`: **51 passed**
- `npm run test:html-snapshots`: **18 passed**
- `npm run test:visual`: **108 passed**
- `npm run test:view-hashes`: **18 frozen view/style files and 8 pinned assets verified**
- `npm run test:baseline-manifest`: **234 immutable baseline files verified**
- `npm run test:ejs-upgrade-gate`: pass with the same counts
- `git diff --check`: pass

SSR markup and visual output did not change. The only deterministic evidence update is the analytics HTML snapshot's cache-busted client script hash and its baseline-manifest hash; layout, PNG, template hash, and baseline index remain unchanged.

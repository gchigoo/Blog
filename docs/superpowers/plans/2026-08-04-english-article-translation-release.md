# English Article Translation Release Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Translate all four production Chinese articles into natural English, promote their 18 historical tags into stable bilingual taxonomy entries, and deploy the verified English siblings safely to production.

**Architecture:** Keep article content outside Git as the existing runtime model requires. Track taxonomy, a release manifest, validation tooling, publication tooling, tests, and runbook changes in Git; build the four English Markdown files as a SHA-256-verified release bundle. Apply taxonomy through the existing compensated sync operation and publish each English article through the existing protected loopback admin API, never with direct SQL.

**Tech Stack:** Node.js 24, Express 5, EJS 6, better-sqlite3, gray-matter, markdown-it, native `fetch`/`FormData`, Node test runner, PM2, Nginx, SQLite FTS5, SSH.

## Global Constraints

- Translate exactly the four production Chinese articles identified in the approved design.
- Use natural English while preserving the original structure, humor, first-person voice, links, screenshots, code, versions, parameters, and historical claims.
- Do not add a historical note or update old content.
- Use the approved English titles, slugs, descriptions, translation keys, dates, and stable tag sets.
- Preserve each source article’s image URL multiset and external URL multiset exactly.
- Keep `articles/zh/*` and `articles/en/*` Git-ignored.
- Do not add runtime LLM calls or third-party translation APIs.
- Do not directly insert or update article rows with handwritten SQL.
- Production content writes require maintenance mode, a coordinated backup, localhost candidate checks, rollback readiness, and independent content/security/final reviews.
- Preserve production-local `/root/Blog/ecosystem.config.js` exactly.
- Never print or persist passwords, JWT secrets, bearer tokens, cookies, or other credentials.
- No commit may contain AI attribution.

---

## File Structure

### Tracked files

- Modify `content/taxonomy.json` — define the 18 promoted bilingual stable tags and their exact legacy aliases.
- Create `content/releases/english-articles-2026-08-04.json` — immutable release identities, metadata, expected tags, and source slugs.
- Create `scripts/audit-translation-release.js` — release-specific source/bundle/published consistency auditor.
- Create `scripts/publish-translation-release.js` — loopback-only bearer-authenticated client for `POST /api/admin/upload`.
- Modify `package.json` — expose both release commands.
- Modify `test/taxonomy-catalog.test.js` — pin the shipped bilingual tag catalog.
- Modify `test/taxonomy-sync.test.js` — prove all 18 production-shaped legacy tags rewire safely.
- Create `test/translation-release-audit.test.js` — TDD coverage for bundle and sibling invariants.
- Create `test/translation-release-publish.test.js` — TDD coverage for protected publication and secret non-disclosure.
- Modify `DEPLOY.md` — canonical candidate, production, credential-pipe, rollback, and cleanup commands.
- Modify `test/analytics-geoip-update.test.js` — pin the release runbook’s security-critical sequencing.
- Modify `docs/superpowers/specs/2026-08-04-english-article-translation-release-design.md` — record the PM2-before-loopback-publication sequencing correction.

### Untracked release files

- `/private/tmp/blog-english-release-20260804/understanding-fast-charging.md`
- `/private/tmp/blog-english-release-20260804/baidu-netdisk-speed-limit-guide.md`
- `/private/tmp/blog-english-release-20260804/my-essential-iphone-apps.md`
- `/private/tmp/blog-english-release-20260804/migrating-home-assistant-from-nuc9-to-mac-mini.md`
- `/private/tmp/blog-english-release-20260804/SHA256SUMS`

### Isolated candidate

- `/private/tmp/blog-english-candidate-20260804` — detached worktree with a copied production database, articles, images, audio, and empty operation registry.

---

### Task 1: Promote all historical tags into the bilingual catalog

**Files:**
- Modify: `content/taxonomy.json`
- Modify: `test/taxonomy-catalog.test.js`
- Modify: `test/taxonomy-sync.test.js`

**Interfaces:**
- Consumes: `loadTaxonomyCatalog(filePath)`, `planTaxonomySync(db, catalog, options)`, `applyTaxonomySync(db, catalog, options)`.
- Produces: 18 stable tag IDs accepted by English publication and deterministic rewiring from the existing legacy labels.

- [ ] **Step 1: Add a failing shipped-catalog assertion**

Extend `test('ships a taxonomy catalog that validates and contains the required entries', ...)` with this exact expected mapping:

```js
const expectedPromotedTags = {
  productivity: ['life', '效率', 'Productivity', ['效率']],
  app: ['technology', 'App', 'App', ['App']],
  utm: ['technology', 'UTM', 'UTM', ['UTM']],
  'smart-home': ['technology', '智能家居', 'Smart Home', ['智能家居']],
  'home-assistant': ['technology', 'Home Assistant', 'Home Assistant', ['Home Assistant']],
  ios: ['technology', 'iOS', 'iOS', ['iOS']],
  iphone: ['technology', 'iPhone', 'iPhone', ['iPhone']],
  apple: ['technology', '苹果', 'Apple', ['苹果']],
  tools: ['technology', '工具', 'Tools', ['工具']],
  tampermonkey: ['technology', 'Tampermonkey', 'Tampermonkey', ['Tampermonkey']],
  tutorials: ['technology', '教程', 'Tutorials', ['教程']],
  charging: ['technology', '充电', 'Charging', ['充电']],
  explainers: ['technology', '科普', 'Explainers', ['科普']],
  'baidu-netdisk': ['technology', '百度网盘', 'Baidu Netdisk', ['百度网盘']],
  'mac-mini': ['technology', 'Mac mini', 'Mac mini', ['Mac mini']],
  idm: ['technology', 'IDM', 'IDM', ['IDM']],
  'consumer-electronics': ['technology', '数码', 'Consumer Electronics', ['数码']],
  homekit: ['technology', 'HomeKit', 'HomeKit', ['HomeKit']]
};
const actual = Object.fromEntries(catalog.categories.flatMap(category =>
  category.tags.map(tag => [tag.id, [
    category.id,
    tag.labels.zh.name,
    tag.labels.en.name,
    tag.legacyNames
  ]])
));
for (const [id, expected] of Object.entries(expectedPromotedTags)) {
  assert.deepEqual(actual[id], expected, id);
}
```

- [ ] **Step 2: Run the catalog test and confirm RED**

Run:

```bash
node --test test/taxonomy-catalog.test.js
```

Expected: FAIL because the shipped `life` and `technology` tag arrays are still empty.

- [ ] **Step 3: Add the 18 exact catalog entries**

Use these sort orders and localized slugs:

```text
life:
  productivity 10 — zh 效率/效率 — en Productivity/productivity

technology:
  app 10 — zh App/App — en App/app
  utm 20 — zh UTM/UTM — en UTM/utm
  smart-home 30 — zh 智能家居/智能家居 — en Smart Home/smart-home
  home-assistant 40 — zh Home Assistant/Home Assistant — en Home Assistant/home-assistant
  ios 50 — zh iOS/iOS — en iOS/ios
  iphone 60 — zh iPhone/iPhone — en iPhone/iphone
  apple 70 — zh 苹果/苹果 — en Apple/apple
  tools 80 — zh 工具/工具 — en Tools/tools
  tampermonkey 90 — zh Tampermonkey/Tampermonkey — en Tampermonkey/tampermonkey
  tutorials 100 — zh 教程/教程 — en Tutorials/tutorials
  charging 110 — zh 充电/充电 — en Charging/charging
  explainers 120 — zh 科普/科普 — en Explainers/explainers
  baidu-netdisk 130 — zh 百度网盘/百度网盘 — en Baidu Netdisk/baidu-netdisk
  mac-mini 140 — zh Mac mini/Mac mini — en Mac mini/mac-mini
  idm 150 — zh IDM/IDM — en IDM/idm
  consumer-electronics 160 — zh 数码/数码 — en Consumer Electronics/consumer-electronics
  homekit 170 — zh HomeKit/HomeKit — en HomeKit/homekit
```

Each `legacyNames` array contains exactly the approved existing visible label.

- [ ] **Step 4: Run the catalog test and confirm GREEN**

Run:

```bash
node --test test/taxonomy-catalog.test.js
```

Expected: PASS.

- [ ] **Step 5: Add a production-shaped taxonomy sync regression test**

Create a fixture with the four source slugs and these exact legacy label sets:

```js
const sourceTags = {
  '9102': ['数码', '科普', '充电', '苹果'],
  'baiduyun-speed-limit': ['教程', '工具', '百度网盘', 'IDM', 'Tampermonkey'],
  'apps-in-my-iphone-1784032269347': ['App', 'iPhone', 'iOS', '工具', '效率'],
  'home-assistant-nuc9-to-mac-mini-homekit': [
    'Home Assistant', 'HomeKit', 'Mac mini', 'UTM', '智能家居'
  ]
};
const expectedStableTags = {
  '9102': ['consumer-electronics', 'explainers', 'charging', 'apple'],
  'baiduyun-speed-limit': ['tutorials', 'tools', 'baidu-netdisk', 'idm', 'tampermonkey'],
  'apps-in-my-iphone-1784032269347': ['app', 'iphone', 'ios', 'tools', 'productivity'],
  'home-assistant-nuc9-to-mac-mini-homekit': [
    'home-assistant', 'homekit', 'mac-mini', 'utm', 'smart-home'
  ]
};
```

Assert dry-run and apply produce:

```js
assert.equal(plan.legacyRewires.length, 18);
assert.equal(plan.deletedTags.length, 18);
assert.equal(plan.markdownRewrites.length, 4);
assert.equal(plan.affectedArticleIds.length, 4);
assert.deepEqual(plan.conflicts, []);
assert.deepEqual(plan.blockedSlugChanges, []);
assert.deepEqual(plan.blockedDeletions, []);
assert.deepEqual(plan.unmappedLegacyTags, []);
```

After apply, parse every rewritten Markdown file and compare its tag set to `expectedStableTags`; query `tags` and assert no promoted article tag has `origin = 'legacy'`; query `article_fts.taxonomy` and assert the localized stable labels appear.

- [ ] **Step 6: Prove the sync regression test RED, then GREEN**

Before applying the catalog change to the fixture, run:

```bash
node --test test/taxonomy-sync.test.js --test-name-pattern="production historical tags"
```

Expected RED: the labels remain legacy/unmapped. Restore the catalog implementation and rerun the same command; expected GREEN.

- [ ] **Step 7: Run the taxonomy test gate**

```bash
node --test test/taxonomy-catalog.test.js test/taxonomy-sync.test.js
npm run typecheck
npm run lint
```

Expected: all commands exit 0.

- [ ] **Step 8: Commit**

```bash
git add content/taxonomy.json test/taxonomy-catalog.test.js test/taxonomy-sync.test.js
git commit -m "feat(content): promote historical tags"
```

---

### Task 2: Add the release manifest and translation consistency auditor

**Files:**
- Create: `content/releases/english-articles-2026-08-04.json`
- Create: `scripts/audit-translation-release.js`
- Create: `test/translation-release-audit.test.js`
- Modify: `package.json`

**Interfaces:**
- Consumes: `parseMarkdownDocument`, `renderMarkdown`, `extractImages`, SQLite article/post/tag/FTS tables.
- Produces:

```js
auditTranslationRelease({
  dbPath,
  articlesDir,
  bundleDir,
  releasePath,
  mode // 'source' | 'published'
}) => {
  passed: boolean,
  mode: string,
  counts: object,
  checks: object,
  errors: Array<{ check: string, message: string }>
}
```

CLI:

```bash
npm run audit-translation-release -- \
  --release content/releases/english-articles-2026-08-04.json \
  --bundle /private/tmp/blog-english-release-20260804 \
  --mode source
```

- [ ] **Step 1: Create the failing audit tests**

Use temporary databases and `articles/zh`, `articles/en`, and bundle directories. Add one passing fixture plus independent failing tests for:

```text
missing/extra bundle file
SHA256SUMS mismatch or duplicate entry
unsafe symlink or hidden file
wrong title/slug/translationKey/date/status/description/tags
legacy-* English tag
source/English image multiset mismatch
external URL multiset mismatch
fenced code mismatch
Markdown table shape mismatch
technical token mismatch
untranslated CJK prose
published DB/file mismatch
missing or duplicate sibling
wrong posts/articles/FTS counts
raw HTML becoming executable
```

The first happy-path test should call the not-yet-created export:

```js
const report = auditTranslationRelease({
  dbPath: path.join(root, 'blog.db'),
  articlesDir: path.join(root, 'articles'),
  bundleDir: path.join(root, 'bundle'),
  releasePath: path.join(root, 'release.json'),
  mode: 'source'
});
assert.equal(report.passed, true, JSON.stringify(report.errors));
```

- [ ] **Step 2: Run the auditor tests and confirm RED**

```bash
node --test test/translation-release-audit.test.js
```

Expected: FAIL with `Cannot find module '../scripts/audit-translation-release'`.

- [ ] **Step 3: Create the exact tracked release manifest**

The JSON contains these four records and no hashes or secrets:

```json
{
  "version": 1,
  "articles": [
    {
      "translationKey": "9102",
      "zhSlug": "9102",
      "enSlug": "understanding-fast-charging",
      "enTitle": "It’s 2019—Are You Still Using Apple’s 5V/1A Charger?",
      "description": "A practical introduction to fast charging, the electrical principles behind it, and the major charging protocols in use in 2019.",
      "date": "2019-12-15T01:18:00.000Z",
      "tags": ["consumer-electronics", "explainers", "charging", "apple"]
    },
    {
      "translationKey": "baiduyun-speed-limit",
      "zhSlug": "baiduyun-speed-limit",
      "enSlug": "baidu-netdisk-speed-limit-guide",
      "enTitle": "Baidu Netdisk Throttling You? You May Be Downloading the Wrong Way!",
      "description": "A step-by-step guide to downloading Baidu Netdisk files with Chrome, IDM, Tampermonkey, and a download-assistant script.",
      "date": "2019-09-08T09:12:00.000Z",
      "tags": ["tutorials", "tools", "baidu-netdisk", "idm", "tampermonkey"]
    },
    {
      "translationKey": "apps-in-my-iphone-1784032269347",
      "zhSlug": "apps-in-my-iphone-1784032269347",
      "enSlug": "my-essential-iphone-apps",
      "enTitle": "Apps on My iPhone",
      "description": "A personal list of recommended iPhone apps for tools, daily life, media, learning, finance, and productivity.",
      "date": "2019-09-01T16:02:00.000Z",
      "tags": ["app", "iphone", "ios", "tools", "productivity"]
    },
    {
      "translationKey": "home-assistant-nuc9-to-mac-mini-homekit",
      "zhSlug": "home-assistant-nuc9-to-mac-mini-homekit",
      "enSlug": "migrating-home-assistant-from-nuc9-to-mac-mini",
      "enTitle": "I Moved Home Assistant from a NUC9 to a Mac mini—and HomeKit Taught Me a Lesson",
      "description": "Lessons from moving Home Assistant from a NUC9 to a Mac mini with UTM, HAOS, HomeKit Bridge, and bridged networking.",
      "date": "2026-05-10T16:00:00.000Z",
      "tags": ["home-assistant", "homekit", "mac-mini", "utm", "smart-home"]
    }
  ]
}
```

- [ ] **Step 4: Implement the auditor in focused helpers**

Use these exact exports and function contracts:

```js
const ALLOWED_ENGLISH_CJK_LITERALS = Object.freeze([]);

module.exports = {
  ALLOWED_ENGLISH_CJK_LITERALS,
  auditTranslationRelease,
  extractExternalUrls,
  extractFencedCode,
  extractTableShapes,
  extractTechnicalTokens,
  loadReleaseManifest,
  loadShaManifest,
  stripNonProse
};
```

- `loadReleaseManifest(releasePath)` returns a deeply frozen `{ version: 1, articles: [...] }` after rejecting unknown keys, duplicate translation keys/slugs, unsafe slugs, unsupported locales, empty descriptions, legacy tag IDs, and malformed ISO dates.
- `loadShaManifest(bundleDir)` returns a filename-to-hash `Map` after rejecting unsorted lines, duplicates, unsafe basenames, non-Markdown entries, invalid hashes, symlinks, hidden files, subdirectories, and extra files.
- `extractExternalUrls(markdown)` returns an ordered array of absolute HTTP(S) link destinations, excluding images.
- `extractFencedCode(markdown)` returns ordered `{ info, body }` records with fence markers removed and body bytes unchanged.
- `extractTableShapes(markdown)` returns ordered `{ columns, rows }` records for each Markdown table.
- `extractTechnicalTokens(markdown)` returns a sorted multiset of versions, ports, protocol identifiers, voltage/current/power units, percentages, rates, capacities, and numeric parameters.
- `stripNonProse(markdown)` removes fenced code, inline code, image/link destinations, and Markdown punctuation before CJK scanning.
- `auditTranslationRelease(options)` returns the documented report object without throwing for content failures; only usage/filesystem/database-open errors throw.
- CLI `main()` parses the five exact flags, prints one JSON report, and exits 0 on pass, 2 on audit failure, or 1 on usage/runtime error.

Required behavior:

- `SHA256SUMS` has exactly four sorted `64hex  filename.md` records matching the manifest’s English slugs.
- Reject symlinks, hidden files, archives, subdirectories, and extras.
- Parse source and English Markdown with `parseMarkdownDocument`.
- Compare source/English image URL multisets, external HTTP(S) URL multisets, fenced code bytes and info strings, table dimensions, heading-level sequences, and technical-token multisets.
- Strip fenced code, inline code, links/URLs, and Markdown syntax before scanning English prose for `\p{Script=Han}`.
- Render with `renderMarkdown(..., { locale: 'en' })`; assert source raw HTML is escaped rather than executable.
- `source` mode requires 4 posts, 4 published zh articles, zero en articles, and four matching source archives.
- `published` mode requires 4 posts, 8 articles, 8 FTS rows, one zh and one en sibling per translation key, exact DB/file metadata, and exact DB/file tag sets.
- Print JSON only; exit 0 on pass and 2 on audit failure.

- [ ] **Step 5: Add the package command**

```json
"audit-translation-release": "node scripts/audit-translation-release.js"
```

- [ ] **Step 6: Run tests and confirm GREEN**

```bash
node --test test/translation-release-audit.test.js
npm run typecheck
npm run lint
```

Expected: all exit 0.

- [ ] **Step 7: Mutation-check key gates**

Temporarily disable each of these checks one at a time and confirm its named test fails: image equality, URL equality, CJK rejection, SHA validation, and published sibling count. Restore the implementation after each mutation.

- [ ] **Step 8: Commit**

```bash
git add content/releases/english-articles-2026-08-04.json \
  scripts/audit-translation-release.js test/translation-release-audit.test.js package.json
git commit -m "feat(content): add translation release audit"
```

---

### Task 3: Add the protected loopback publication client

**Files:**
- Create: `scripts/publish-translation-release.js`
- Create: `test/translation-release-publish.test.js`
- Modify: `package.json`

**Interfaces:**

```js
publishTranslationRelease({
  baseUrl,
  bundleDir,
  releasePath,
  bearerToken,
  fetchImpl = fetch
}) => Promise<Array<{
  filename: string,
  id: number,
  postId: number,
  slug: string,
  locale: 'en',
  translationKey: string
}>>
```

CLI:

```bash
node scripts/publish-translation-release.js \
  --release content/releases/english-articles-2026-08-04.json \
  --bundle /root/blog-english-release-20260804/incoming \
  --base-url http://127.0.0.1:3000 \
  --token-fd 3
```

- [ ] **Step 1: Write failing publisher tests**

Start a real fixture server and seed four zh posts with the stable tags. Spawn the CLI with an extra anonymous pipe:

```js
const child = spawn(process.execPath, [CLI,
  '--release', releasePath,
  '--bundle', bundleDir,
  '--base-url', baseUrl,
  '--token-fd', '3'
], {
  cwd: root,
  env: { ...process.env, NODE_PATH },
  stdio: ['ignore', 'pipe', 'pipe', 'pipe']
});
child.stdio[3].end(validToken);
```

Cover:

```text
four successful uploads share existing zh post IDs
four files appear under articles/en
FTS and article_tags are correct
non-loopback base URL is rejected before reading the token
missing/invalid token fails without disclosure
bad SHA fails before any HTTP request
unknown tag and identity conflict stop immediately
partial failure leaves earlier successful uploads intact
stdout/stderr contain neither token nor Authorization header
successful output contains only filename, safe status, article ID, slug, translation key
```

- [ ] **Step 2: Run the tests and confirm RED**

```bash
node --test test/translation-release-publish.test.js
```

Expected: FAIL because the script does not exist.

- [ ] **Step 3: Implement the loopback-only client**

Use these exact boundaries:

```js
function validateLoopbackBaseUrl(value) {
  const url = new URL(value);
  if (url.protocol !== 'http:' || !['127.0.0.1', '::1'].includes(url.hostname)) {
    throw new Error('base URL must be loopback HTTP');
  }
  return url.origin;
}

module.exports = {
  parseArguments,
  publishTranslationRelease,
  readTokenFromFd,
  uploadArticle,
  validateLoopbackBaseUrl
};
```

- `readTokenFromFd(fd)` reads at most 16 KiB from the already-open numeric descriptor, trims surrounding whitespace, and rejects empty or oversized input.
- `parseArguments(argv)` accepts exactly `--release`, `--bundle`, `--base-url`, and `--token-fd`, rejecting duplicates, missing values, unknown flags, and non-integer descriptors.
- `uploadArticle({ baseUrl, token, filename, bytes })` performs one multipart POST to `/api/admin/upload` and returns the parsed safe response object.
- `publishTranslationRelease(options)` validates the release/bundle first, reads the token only after validation, uploads in manifest order, verifies every returned identity/tag field, stops on first failure, and clears the token reference in `finally`.
- CLI `main()` prints one safe JSON line per file and exits 0 only after all four uploads succeed.

Behavior:

- Reuse `loadReleaseManifest` and `loadShaManifest` from the auditor.
- Validate bundle hashes before reading the bearer token.
- Read at most 16 KiB from the specified fd, trim once, and reject empty or oversized input.
- Upload in release-manifest order with native `FormData` and `Blob`.
- Send `Authorization: Bearer <token>` only to the validated loopback origin.
- Require HTTP 200 and exact returned `locale`, `translationKey`, `slug`, `status`, and tag set.
- Stop on first failure; never auto-delete earlier successes.
- Overwrite the in-memory token variable with an empty string in `finally`.
- Never print response headers, request headers, token, cookie, or raw server stack traces.

- [ ] **Step 4: Add the package command**

```json
"publish-translation-release": "node scripts/publish-translation-release.js"
```

- [ ] **Step 5: Run publisher and regression tests**

```bash
node --test test/translation-release-publish.test.js \
  test/article-workflow.test.js test/auth-security.test.js
npm run typecheck
npm run lint
```

Expected: all exit 0.

- [ ] **Step 6: Mutation-check secret and loopback gates**

Temporarily allow `https://example.com` and confirm the non-loopback test fails. Temporarily print the token and confirm the disclosure test fails. Restore both mutations.

- [ ] **Step 7: Commit**

```bash
git add scripts/publish-translation-release.js \
  test/translation-release-publish.test.js package.json
git commit -m "feat(content): add protected translation publisher"
```

---

### Task 4: Pin the candidate, production, credential-pipe, and rollback runbook

**Files:**
- Modify: `DEPLOY.md`
- Modify: `test/analytics-geoip-update.test.js`
- Modify: `docs/superpowers/specs/2026-08-04-english-article-translation-release-design.md`

**Interfaces:**
- Consumes: Tasks 1–3 commands and current Nginx/PM2 deployment model.
- Produces: one exact operator sequence that keeps maintenance active during all writes and never persists the release token.

- [ ] **Step 1: Write failing documentation-contract tests**

Add assertions requiring an “英文文章翻译发布” section containing, in order:

```text
maintenance enable -> PM2 stop -> backup -> migrate-db -> taxonomy dry-run ->
taxonomy apply -> PM2 candidate start -> anonymous-pipe publisher -> both audits ->
final PM2 restart -> localhost smoke -> temporary cleanup -> maintenance disable -> public smoke
```

Also assert the runbook:

- forbids direct SQL insertion;
- forbids token arguments, environment variables, files, shell history, and logs;
- requires a five-minute HS256 token passed on fd 3;
- preserves production-local `ecosystem.config.js`;
- restores the whole coordinated backup after partial multi-article publication;
- does not purge unchanged HTML/images;
- distinguishes pre-open rollback from post-open forward-fix/reconciliation.

- [ ] **Step 2: Run the contract test and confirm RED**

```bash
node --test test/analytics-geoip-update.test.js --test-name-pattern="English translation release"
```

Expected: FAIL because the section is absent.

- [ ] **Step 3: Add the canonical runbook section**

Include this exact in-memory production launcher pattern, with no token output:

```js
const fs = require('node:fs');
const { execFileSync, spawn } = require('node:child_process');
const jwt = require('jsonwebtoken');

const pid = execFileSync('pm2', ['pid', 'blog'], { encoding: 'utf8' }).trim();
if (!/^\d+$/.test(pid)) throw new Error('blog PM2 process is not running');
const entries = fs.readFileSync(`/proc/${pid}/environ`).toString('utf8').split('\0');
const env = Object.fromEntries(entries.filter(Boolean).map(entry => {
  const split = entry.indexOf('=');
  return [entry.slice(0, split), entry.slice(split + 1)];
}));
if (!env.JWT_SECRET) throw new Error('JWT_SECRET is unavailable');
let token = jwt.sign(
  { id: 0, username: 'release-operator' },
  env.JWT_SECRET,
  { algorithm: 'HS256', expiresIn: '5m' }
);
const child = spawn(process.execPath, [
  'scripts/publish-translation-release.js',
  '--release', 'content/releases/english-articles-2026-08-04.json',
  '--bundle', '/root/blog-english-release-20260804/incoming',
  '--base-url', 'http://127.0.0.1:3000',
  '--token-fd', '3'
], { stdio: ['ignore', 'inherit', 'inherit', 'pipe'] });
child.stdio[3].end(token);
token = '';
child.once('exit', code => process.exitCode = code ?? 1);
```

Document that the here-doc is single-quoted and the launcher itself is never saved to disk.

- [ ] **Step 4: Correct the design’s PM2 sequencing**

Keep the already-approved scope unchanged, but record that PM2 must be started under maintenance before the loopback API upload, then restarted once more after audit for the final worker generation.

- [ ] **Step 5: Run documentation gates**

```bash
node --test test/analytics-geoip-update.test.js
npm run lint
```

Expected: both exit 0.

- [ ] **Step 6: Commit**

```bash
git add DEPLOY.md test/analytics-geoip-update.test.js \
  docs/superpowers/specs/2026-08-04-english-article-translation-release-design.md
git commit -m "docs(deploy): add English content release runbook"
```

---

### Task 5: Capture a consistent production source snapshot and build the candidate

**Files:**
- Create outside Git: `/root/blog-english-release-20260804/snapshot/*`
- Create outside Git: `/private/tmp/blog-english-candidate-20260804`
- Create outside Git: `/private/tmp/blog-english-release-20260804`

**Interfaces:**
- Consumes: current production DB/articles/images/audio and committed Tasks 1–4.
- Produces: one verified source snapshot, one detached candidate, and an empty four-file release bundle directory.

- [ ] **Step 1: Read the worktree safety skill before creating the candidate**

Read `superpowers:using-git-worktrees` and follow its collision/cleanup checks.

- [ ] **Step 2: Verify production preflight read-only state**

Record:

```bash
ssh rn-us-2.5g 'cd /root/Blog && \
  git rev-parse HEAD && git status --short --untracked-files=no && \
  pm2 ls --no-color && ss -ltnp "sport = :3000" && \
  nginx -t && npm run audit-localized-content'
```

Require production HEAD to equal the current pre-release `origin/master` snapshot (expected `860bfe53e54dff4ab78bbfa2f7e5f644a032b9aa` before the release branch is merged and pushed), PM2 online, loopback-only listener, schema 3, four posts/articles/FTS rows, and no operation residue.

- [ ] **Step 3: Open a short source-snapshot maintenance window**

Enable the existing maintenance include, run `nginx -t`, reload, and verify a public nonce URL returns 503 with no cacheable headers. Then:

```bash
ssh rn-us-2.5g 'cd /root/Blog && pm2 stop blog'
```

- [ ] **Step 4: Create and hash the source snapshot**

On production:

```bash
set -euo pipefail
cd /root/Blog
release=/root/blog-english-release-20260804
mkdir -p "$release/snapshot"
npm run backup-db
backup="$(ls -1t backups/blog_*.db | head -n 1)"
cp -- "$backup" "$release/snapshot/blog.db"
tar -C /root/Blog -cpf "$release/snapshot/runtime.tar" \
  articles public/images public/audio var/operations content/taxonomy.json ecosystem.config.js
cd "$release/snapshot"
sha256sum blog.db runtime.tar | sort -k2 > SHA256SUMS
sha256sum -c SHA256SUMS
```

- [ ] **Step 5: Restore the old public service after the snapshot**

Restart the old PM2 process, run localhost Express/Nginx smoke, disable maintenance, run `nginx -t`, reload, and verify `/zh/` is 200 and not cached. This snapshot window must not include any code/content change.

- [ ] **Step 6: Transfer and verify the snapshot locally**

```bash
rm -rf /private/tmp/blog-english-source-20260804
mkdir -p /private/tmp/blog-english-source-20260804
scp rn-us-2.5g:/root/blog-english-release-20260804/snapshot/{blog.db,runtime.tar,SHA256SUMS} \
  /private/tmp/blog-english-source-20260804/
cd /private/tmp/blog-english-source-20260804
shasum -a 256 -c SHA256SUMS
```

- [ ] **Step 7: Create the detached candidate**

```bash
test ! -e /private/tmp/blog-english-candidate-20260804
git worktree add --detach /private/tmp/blog-english-candidate-20260804 HEAD
cd /private/tmp/blog-english-source-20260804
mkdir runtime
tar -C runtime -xpf runtime.tar
cp blog.db /private/tmp/blog-english-candidate-20260804/blog.db
cp -R runtime/articles /private/tmp/blog-english-candidate-20260804/
cp -R runtime/public/images /private/tmp/blog-english-candidate-20260804/public/
cp -R runtime/public/audio /private/tmp/blog-english-candidate-20260804/public/
rm -rf /private/tmp/blog-english-candidate-20260804/var/operations
mkdir -p /private/tmp/blog-english-candidate-20260804/var/operations
cd /private/tmp/blog-english-candidate-20260804
npm ci
```

Do not copy the snapshot’s old taxonomy over the candidate’s committed taxonomy.

- [ ] **Step 8: Create the empty release bundle directory**

```bash
rm -rf /private/tmp/blog-english-release-20260804
mkdir -m 700 /private/tmp/blog-english-release-20260804
```

- [ ] **Step 9: Run source-mode audit before translation**

The bundle is still incomplete, so first run the general content audit:

```bash
cd /private/tmp/blog-english-candidate-20260804
npm run audit-localized-content
```

Expected: 4 posts, 4 articles, 4 FTS rows, all checks pass.

No Git commit for this task.

---

### Task 6: Translate the fast-charging article

**Files:**
- Read: `/private/tmp/blog-english-candidate-20260804/articles/zh/9102.md`
- Create: `/private/tmp/blog-english-release-20260804/understanding-fast-charging.md`

**Interfaces:**
- Produces one English Markdown file matching the release manifest.

- [ ] **Step 1: Create exact front matter**

```yaml
---
locale: en
translationKey: "9102"
slug: "understanding-fast-charging"
title: "It’s 2019—Are You Still Using Apple’s 5V/1A Charger?"
description: "A practical introduction to fast charging, the electrical principles behind it, and the major charging protocols in use in 2019."
tags: ["consumer-electronics", "explainers", "charging", "apple"]
status: published
date: 2019-12-15T01:18:00.000Z
---
```

- [ ] **Step 2: Translate every visible text block naturally**

Preserve all section levels, both image URLs, the external `21ic.com` image URL, all table rows, protocol names, voltages, currents, wattages, the 200 mV step, and the handshake analogy. Explain the title’s 5V/1A meaning in natural English; do not add 2026 corrections.

- [ ] **Step 3: Run focused structural comparison**

```bash
node - <<'NODE'
const fs = require('node:fs');
const { extractImages, parseMarkdownDocument } = require('./server/utils/markdown');
const zh = fs.readFileSync('/private/tmp/blog-english-candidate-20260804/articles/zh/9102.md', 'utf8');
const en = fs.readFileSync('/private/tmp/blog-english-release-20260804/understanding-fast-charging.md', 'utf8');
const z = parseMarkdownDocument(zh);
const e = parseMarkdownDocument(en);
if (e.data.locale !== 'en' || e.data.translationKey !== '9102') process.exit(1);
if (JSON.stringify(extractImages(z.content)) !== JSON.stringify(extractImages(e.content))) process.exit(1);
NODE
```

Expected: exit 0.

No Git commit; the file remains in the protected bundle.

---

### Task 7: Translate the Baidu Netdisk article

**Files:**
- Read: `/private/tmp/blog-english-candidate-20260804/articles/zh/baiduyun-speed-limit.md`
- Create: `/private/tmp/blog-english-release-20260804/baidu-netdisk-speed-limit-guide.md`

- [ ] **Step 1: Create exact front matter**

```yaml
---
locale: en
translationKey: "baiduyun-speed-limit"
slug: "baidu-netdisk-speed-limit-guide"
title: "Baidu Netdisk Throttling You? You May Be Downloading the Wrong Way!"
description: "A step-by-step guide to downloading Baidu Netdisk files with Chrome, IDM, Tampermonkey, and a download-assistant script."
tags: ["tutorials", "tools", "baidu-netdisk", "idm", "tampermonkey"]
status: published
date: 2019-09-08T09:12:00.000Z
---
```

- [ ] **Step 2: Translate every visible text block naturally**

Preserve all five internal image URLs, all external links, the exact IDM `6.35` version, the exact User-Agent code block, UI labels quoted by the instructions, the public-account ID `runningcheese01`, and the keyword `idm`. Do not modernize or remove any procedure.

- [ ] **Step 3: Run focused structural comparison**

```bash
cd /private/tmp/blog-english-candidate-20260804
node - <<'NODE'
const fs = require('node:fs');
const { extractImages, parseMarkdownDocument } = require('./server/utils/markdown');
const zh = fs.readFileSync('articles/zh/baiduyun-speed-limit.md', 'utf8');
const en = fs.readFileSync('/private/tmp/blog-english-release-20260804/baidu-netdisk-speed-limit-guide.md', 'utf8');
const z = parseMarkdownDocument(zh);
const e = parseMarkdownDocument(en);
if (e.data.locale !== 'en' || e.data.translationKey !== 'baiduyun-speed-limit') process.exit(1);
if (JSON.stringify(extractImages(z.content)) !== JSON.stringify(extractImages(e.content))) process.exit(1);
NODE
```

Expected: exit 0.

No Git commit.

---

### Task 8: Translate the iPhone apps article

**Files:**
- Read: `/private/tmp/blog-english-candidate-20260804/articles/zh/apps-in-my-iphone-1784032269347.md`
- Create: `/private/tmp/blog-english-release-20260804/my-essential-iphone-apps.md`

- [ ] **Step 1: Create exact front matter**

```yaml
---
locale: en
translationKey: "apps-in-my-iphone-1784032269347"
slug: "my-essential-iphone-apps"
title: "Apps on My iPhone"
description: "A personal list of recommended iPhone apps for tools, daily life, media, learning, finance, and productivity."
tags: ["app", "iphone", "ios", "tools", "productivity"]
status: published
date: 2019-09-01T16:02:00.000Z
---
```

- [ ] **Step 2: Translate every visible text block naturally**

Preserve all 14 image URLs, all application names, protocol names, feature names, numeric values, emoji headings, list structure, and closing reader question. Keep “MoNEY Pro” and “DREAMDAYS” capitalization exactly as the source.

- [ ] **Step 3: Run focused structural comparison**

```bash
cd /private/tmp/blog-english-candidate-20260804
node - <<'NODE'
const fs = require('node:fs');
const { extractImages, parseMarkdownDocument } = require('./server/utils/markdown');
const zh = fs.readFileSync('articles/zh/apps-in-my-iphone-1784032269347.md', 'utf8');
const en = fs.readFileSync('/private/tmp/blog-english-release-20260804/my-essential-iphone-apps.md', 'utf8');
const z = parseMarkdownDocument(zh);
const e = parseMarkdownDocument(en);
if (e.data.locale !== 'en' || e.data.translationKey !== 'apps-in-my-iphone-1784032269347') process.exit(1);
if (JSON.stringify(extractImages(z.content)) !== JSON.stringify(extractImages(e.content))) process.exit(1);
NODE
```

Expected: exit 0.

No Git commit.

---

### Task 9: Translate the Home Assistant migration article

**Files:**
- Read: `/private/tmp/blog-english-candidate-20260804/articles/zh/home-assistant-nuc9-to-mac-mini-homekit.md`
- Create: `/private/tmp/blog-english-release-20260804/migrating-home-assistant-from-nuc9-to-mac-mini.md`

- [ ] **Step 1: Create exact front matter**

```yaml
---
locale: en
translationKey: "home-assistant-nuc9-to-mac-mini-homekit"
slug: "migrating-home-assistant-from-nuc9-to-mac-mini"
title: "I Moved Home Assistant from a NUC9 to a Mac mini—and HomeKit Taught Me a Lesson"
description: "Lessons from moving Home Assistant from a NUC9 to a Mac mini with UTM, HAOS, HomeKit Bridge, and bridged networking."
tags: ["home-assistant", "homekit", "mac-mini", "utm", "smart-home"]
status: published
date: 2026-05-10T16:00:00.000Z
---
```

- [ ] **Step 2: Translate every visible text block naturally**

Preserve both text code blocks, all product/platform names, port `8123`, every troubleshooting step, the exact quoted HomeKit error meaning, and the final emphasis. Do not add advice beyond the source.

- [ ] **Step 3: Run focused structural comparison**

```bash
cd /private/tmp/blog-english-candidate-20260804
node - <<'NODE'
const fs = require('node:fs');
const { extractImages, parseMarkdownDocument } = require('./server/utils/markdown');
const zh = fs.readFileSync('articles/zh/home-assistant-nuc9-to-mac-mini-homekit.md', 'utf8');
const en = fs.readFileSync('/private/tmp/blog-english-release-20260804/migrating-home-assistant-from-nuc9-to-mac-mini.md', 'utf8');
const z = parseMarkdownDocument(zh);
const e = parseMarkdownDocument(en);
if (e.data.locale !== 'en' || e.data.translationKey !== 'home-assistant-nuc9-to-mac-mini-homekit') process.exit(1);
if (JSON.stringify(extractImages(z.content)) !== JSON.stringify(extractImages(e.content))) process.exit(1);
NODE
```

Expected: exit 0.

No Git commit.

---

### Task 10: Assemble, validate, review, commit, and push the complete candidate

**Files:**
- Modify only if defects are found: tracked Tasks 1–4 files.
- Create outside Git: release `SHA256SUMS` and candidate runtime state.

**Interfaces:**
- Consumes: complete four-file bundle, candidate, Tasks 1–4 tooling.
- Produces: locally verified Git commit stack on `master`, pushed `origin/master`, and a reviewed immutable bundle ready for production.

- [ ] **Step 1: Generate the sorted bundle hash manifest**

```bash
cd /private/tmp/blog-english-release-20260804
shasum -a 256 *.md | LC_ALL=C sort -k2 > SHA256SUMS
chmod 600 *.md SHA256SUMS
shasum -a 256 -c SHA256SUMS
```

Expected: exactly four `OK` lines.

- [ ] **Step 2: Run source-mode translation audit**

```bash
cd /private/tmp/blog-english-candidate-20260804
npm run audit-translation-release -- \
  --release content/releases/english-articles-2026-08-04.json \
  --bundle /private/tmp/blog-english-release-20260804 \
  --mode source
```

Expected: `passed: true` with 4 source records and 4 bundle records.

- [ ] **Step 3: Run taxonomy dry-run and exact-plan gate**

```bash
npm run migrate-db
npm run sync-taxonomy -- --dry-run > /private/tmp/blog-english-taxonomy-plan.json
```

Use Node to assert 18 rewires/deletions, 4 rewrites/affected articles, and zero blockers. Then run:

```bash
npm run sync-taxonomy
npm run audit-localized-content
```

Expected: all pass, source article tags now use only stable IDs.

- [ ] **Step 4: Start the candidate server under isolated secrets**

```bash
cd /private/tmp/blog-english-candidate-20260804
PORT=3104 \
JWT_SECRET="candidate-only-jwt-secret-with-at-least-32-characters" \
ANALYTICS_HMAC_SECRET="candidate-only-analytics-secret-with-at-least-32-characters" \
BLOG_PUBLIC_ORIGIN=http://127.0.0.1:3104 \
NODE_ENV=production \
node server/index.js > /private/tmp/blog-english-candidate.log 2>&1 &
echo $! > /private/tmp/blog-english-candidate.pid
```

Wait until `curl -fsS http://127.0.0.1:3104/zh/` succeeds.

- [ ] **Step 5: Generate a five-minute candidate token and publish through fd 3**

```bash
cd /private/tmp/blog-english-candidate-20260804
node <<'NODE'
const { spawn } = require('node:child_process');
const jwt = require('jsonwebtoken');
let token = jwt.sign(
  { id: 0, username: 'candidate-release-operator' },
  'candidate-only-jwt-secret-with-at-least-32-characters',
  { algorithm: 'HS256', expiresIn: '5m' }
);
const child = spawn(process.execPath, [
  'scripts/publish-translation-release.js',
  '--release', 'content/releases/english-articles-2026-08-04.json',
  '--bundle', '/private/tmp/blog-english-release-20260804',
  '--base-url', 'http://127.0.0.1:3104',
  '--token-fd', '3'
], { stdio: ['ignore', 'inherit', 'inherit', 'pipe'] });
child.stdio[3].end(token);
token = '';
child.once('exit', code => { process.exitCode = code ?? 1; });
NODE
```

Expected: four safe success records and no secrets in output.

- [ ] **Step 6: Run published-mode audit and full local gates**

```bash
npm run audit-localized-content
npm run audit-translation-release -- \
  --release content/releases/english-articles-2026-08-04.json \
  --bundle /private/tmp/blog-english-release-20260804 \
  --mode published
npm test
npm run typecheck
npm run lint
git diff --check
```

Expected: posts/articles/FTS `4/8/8`; all commands exit 0.

- [ ] **Step 7: Run the candidate HTTP acceptance matrix**

Verify:

```text
/en/
/en/archive
/en/feed.xml
/sitemap.xml
/en/article/understanding-fast-charging
/en/article/baidu-netdisk-speed-limit-guide
/en/article/my-essential-iphone-apps
/en/article/migrating-home-assistant-from-nuc9-to-mac-mini
/en/category/technology
/en/category/life
all non-zero English tag URLs
English title and taxonomy search queries
all source image URLs
one missing /images/*.webp and one missing root *.webp
```

For every article, assert 200, exact canonical, reciprocal zh/en `hreflang`, and exact language-switch target. Assert HTML remains `private, no-store`; all real images are 200 `image/webp`; missing static-looking paths remain no-store.

- [ ] **Step 8: Run independent content review**

Dispatch a reviewer with both source and English files. Require `CONTENT REVIEW PASS` and zero Critical/Important findings. The reviewer must check every paragraph, title, alt text, table, link, code block, number, tone, and omission.

- [ ] **Step 9: Run independent candidate security review**

Require `CANDIDATE SECURITY PASS`. Review the actual diff, auditor, publisher, token pipe, loopback restriction, Markdown safety, bundle path checks, taxonomy compensation, and rollback.

- [ ] **Step 10: Run independent candidate final release review**

Require `CANDIDATE RELEASE PASS`, considering content and security reports plus fresh tests and HTTP evidence.

- [ ] **Step 11: Commit any remaining tracked release changes**

```bash
git status --short
git diff --check
git add DEPLOY.md content scripts test package.json docs/superpowers
if ! git diff --cached --quiet; then
  git commit -m "feat(content): prepare English article release"
fi
```

No ignored article content may enter the commit.

- [ ] **Step 12: Re-run the full gate on the isolated release branch**

```bash
npm test
npm run typecheck
npm run lint
git diff --check
git status --short
```

Expected: clean status and zero failures.

- [ ] **Step 13: Fast-forward the reviewed release branch into local `master`**

From the primary checkout, require a clean `master` and fast-forward only:

```bash
cd /Users/steven/Blog
git status --short
git merge --ff-only english-article-release
```

Then re-run the release-specific tests, typecheck, lint, and `git diff --check` on the merged `master`.

- [ ] **Step 14: Push without force**

```bash
git push origin master
```

Read back:

```bash
test "$(git rev-parse HEAD)" = "$(git rev-parse origin/master)"
```

Expected: equal SHAs.

---

### Task 11: Deploy the English release and obtain production PASS

**Files:**
- Production Git checkout: `/root/Blog`
- Production release bundle: `/root/blog-english-release-20260804/incoming`
- Production backup: `/root/blog-english-release-20260804/pre`

**Interfaces:**
- Consumes: pushed Git commit and reviewed four-file bundle.
- Produces: production state with 4 posts, 8 articles, 8 FTS rows, stable taxonomy, and all English routes public.

- [ ] **Step 1: Transfer and verify the bundle before maintenance**

```bash
ssh rn-us-2.5g 'rm -rf /root/blog-english-release-20260804/incoming && \
  install -d -m 700 /root/blog-english-release-20260804/incoming'
scp /private/tmp/blog-english-release-20260804/*.md \
  /private/tmp/blog-english-release-20260804/SHA256SUMS \
  rn-us-2.5g:/root/blog-english-release-20260804/incoming/
ssh rn-us-2.5g 'cd /root/blog-english-release-20260804/incoming && \
  chmod 600 *.md SHA256SUMS && sha256sum -c SHA256SUMS'
```

Expected: exactly four `OK` lines.

- [ ] **Step 2: Record production preflight**

Record Git SHA/status, PM2 PID/restarts/log sizes, loopback listener, Nginx validity, disk space, DB integrity/FKs/version/counts, article hashes, image hashes, and operation registry. Abort before writes on any unexpected state.

- [ ] **Step 3: Enable maintenance and verify no-store 503**

Enable the documented include, run `nginx -t`, reload, and request a fresh public nonce twice. Require 503, no `HIT`, and no `Age`.

- [ ] **Step 4: Stop PM2 and create the coordinated pre-release backup**

Back up:

```text
Git SHA
SQLite online backup
articles/
public/audio/
var/operations/
content/taxonomy.json
ecosystem.config.js
file SHA-256 manifest
```

Verify SQLite integrity and the backup hash manifest before continuing.

- [ ] **Step 5: Fast-forward code while preserving production-local config**

```bash
cd /root/Blog
cp ecosystem.config.js /root/blog-english-release-20260804/pre/ecosystem.config.js
old_sha="$(git rev-parse HEAD)"
git fetch --prune origin
git merge --ff-only origin/master
cp /root/blog-english-release-20260804/pre/ecosystem.config.js ecosystem.config.js
npm ci
```

Require production HEAD equals `origin/master`; do not clean or overwrite the intentional ecosystem delta.

- [ ] **Step 6: Migrate and apply taxonomy while PM2 is stopped**

```bash
npm run migrate-db
npm run sync-taxonomy -- --dry-run > /root/blog-english-release-20260804/pre/taxonomy-plan.json
```

Assert exact counts, then:

```bash
npm run sync-taxonomy
npm run audit-localized-content
```

Expected: 18 legacy tags promoted, 4 Chinese Markdown files rewritten, 4 source articles/FTS rows remain coherent, no operation residue.

- [ ] **Step 7: Start the candidate PM2 worker under maintenance**

Start/restart `blog`, confirm a new online PID, no new error-log bytes, and only `127.0.0.1:3000`. Run direct Express and Nginx localhost `/zh/` smoke.

- [ ] **Step 8: Publish the bundle with an in-memory five-minute token**

Run the exact single-quoted Node here-doc from `DEPLOY.md`. It reads `JWT_SECRET` from `/proc/<pm2-pid>/environ`, signs an HS256 token with `expiresIn: '5m'`, sends it only through fd 3 to the loopback publisher, clears the local token reference, and exits with the publisher status.

Expected: four safe publication success records; no token, secret, cookie, or header output.

- [ ] **Step 9: Run production audits and exact count gates**

```bash
npm run audit-localized-content
npm run audit-translation-release -- \
  --release content/releases/english-articles-2026-08-04.json \
  --bundle /root/blog-english-release-20260804/incoming \
  --mode published
npm run typecheck
npm run lint
```

Query SQLite read-only and require posts/articles/FTS/comments `4/8/8/<unchanged>`, no foreign-key violations, integrity `ok`, and zero operation residue.

- [ ] **Step 10: Restart the final PM2 worker and run maintenance-window smoke**

Restart once more so the public worker generation is clearly attributable. Record PID, restart count, log offsets, loopback listener, and localhost HTTP matrix for all four English pages, feeds, sitemap, searches, taxonomy pages, and images.

- [ ] **Step 11: Delete temporary credential/material state before opening**

Delete `/root/blog-english-release-20260804/incoming` only after audits and localhost smoke pass. Confirm no token-bearing file exists and the PM2 environment contains no release token.

- [ ] **Step 12: Disable maintenance and run immediate public verification**

Require:

```text
/ -> expected 302 negotiation behavior
/zh/ and /en/ -> 200 private,no-store DYNAMIC no Age
four English article URLs -> 200, exact title/canonical/hreflang/language switch
four Chinese siblings -> 200 and switch back to English
/en/feed.xml and /sitemap.xml -> contain all four English URLs
English search -> expected results
Technology and Life category pages -> expected article counts
every English tag page -> expected article set
all referenced images -> 200 image/webp
one real image unique query -> MISS then HIT
fresh missing image/root/API *.webp twice -> no HIT and no Age
```

- [ ] **Step 13: Run independent production content/security/final reviews**

Require, in separate reviewer contexts:

```text
PRODUCTION CONTENT PASS
PRODUCTION SECURITY PASS
FINAL RELEASE PASS
```

Critical or Important findings require maintenance reactivation and the documented rollback/forward-fix decision.

- [ ] **Step 14: Close the release or roll back**

If all reviews pass, record final Git SHA, PM2 PID, DB counts, public URLs, and cleanup state. If failure occurs before public opening, restore the entire coordinated backup and old Git SHA. If failure occurs after opening, re-enable maintenance and preserve post-open writes; do not blindly overwrite the database without a reviewed reconciliation plan.

---

## Plan Self-Review

- Every approved spec requirement maps to a task.
- The plan does not require Git-tracking runtime articles.
- The publisher uses the existing protected API and never inserts article rows directly.
- The PM2 sequencing contradiction is corrected: candidate PM2 starts before loopback publication and restarts after audit.
- The production token is five-minute HS256, generated in memory, sent on fd 3, and never stored in arguments, environment, files, or logs.
- Candidate isolation accounts for the application’s working-directory-relative database and content paths.
- The four translations are separately reviewable and their exact metadata is fixed.
- Partial four-file publication is handled by full coordinated backup restore rather than unsafe automatic deletes.
- Pre-open rollback and post-open reconciliation are explicitly different.
- No incomplete marker or unspecified test command remains.

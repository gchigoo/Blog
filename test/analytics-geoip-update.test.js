const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { once } = require('node:events');
const { spawn, spawnSync } = require('node:child_process');
const test = require('node:test');
const { verifyGeoIpDatabase } = require('../scripts/verify-geoip-db');

const projectRoot = path.join(__dirname, '..');

test('GeoIP verifier checks City metadata, fixed lookup, epoch, and checksum', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'geoip-verifier-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const databasePath = path.join(root, 'fixture.mmdb');
  const fixture = Buffer.from('verified-city-database');
  await fs.writeFile(databasePath, fixture);

  let lookupIp = null;
  const result = await verifyGeoIpDatabase(databasePath, {
    openBuffer: async buffer => {
      assert.deepEqual(buffer, fixture);
      return {
        mmdbReader: {
          metadata: {
            databaseType: 'GeoLite2-City',
            buildEpoch: new Date(1784246400 * 1000)
          }
        },
        city(ip) {
          lookupIp = ip;
          return { country: { isoCode: 'AU' } };
        }
      };
    }
  });

  assert.equal(lookupIp, '1.1.1.1');
  assert.deepEqual(result, {
    sha256: crypto.createHash('sha256').update(fixture).digest('hex'),
    datasetEpoch: 1784246400
  });

  const invalidPath = path.join(root, 'invalid.mmdb');
  await fs.writeFile(invalidPath, 'not-a-real-mmdb');
  const cli = spawnSync(process.execPath, [path.join(projectRoot, 'scripts/verify-geoip-db.js'), invalidPath], {
    encoding: 'utf8'
  });
  assert.equal(cli.status, 65);
  assert.match(cli.stderr, /^geoip_verification_failed:/);
  assert.doesNotMatch(cli.stderr, /not-a-real-mmdb|geoip-verifier-/);
  assert.equal(cli.stdout, '');
});

test('GeoIP deployment files pin weekly scheduling, hardening, canonical paths, and 16 KiB proxy limit', async () => {
  const [service, timer, updater, nginx] = await Promise.all([
    fs.readFile(path.join(projectRoot, 'deploy/systemd/blog-geoip-update.service'), 'utf8'),
    fs.readFile(path.join(projectRoot, 'deploy/systemd/blog-geoip-update.timer'), 'utf8'),
    fs.readFile(path.join(projectRoot, 'scripts/update-geoip.sh'), 'utf8'),
    fs.readFile(path.join(projectRoot, 'deploy/nginx/blog.conf'), 'utf8')
  ]);

  for (const expected of [
    'WorkingDirectory=/root/Blog',
    'ExecStart=/root/Blog/scripts/update-geoip.sh',
    'RuntimeDirectory=blog-geoip-update',
    'UMask=0022',
    'NoNewPrivileges=true',
    'PrivateTmp=true',
    'ProtectHome=read-only',
    'ProtectSystem=strict',
    'RestrictSUIDSGID=true',
    'ReadWritePaths=/var/lib/blog/geoip /run/blog-geoip-update'
  ]) assert.match(service, new RegExp(expected.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));

  for (const expected of [
    'OnCalendar=Sun *-*-* 03:30:00',
    'RandomizedDelaySec=30m',
    'AccuracySec=5m',
    'Persistent=true',
    'Unit=blog-geoip-update.service',
    'WantedBy=timers.target'
  ]) assert.ok(timer.includes(expected), expected);

  assert.match(updater, /PRODUCTION_PROJECT_ROOT='\/root\/Blog'/);
  assert.match(updater, /PRODUCTION_GEOIP_DIR='\/var\/lib\/blog\/geoip'/);
  assert.match(updater, /PRODUCTION_RUNTIME_DIR='\/run\/blog-geoip-update'/);
  assert.match(updater, /PRODUCTION_CONFIG='\/etc\/GeoIP\.conf'/);
  assert.match(updater, /flock --nonblock 9/);
  assert.match(updater, /mktemp -d "\$STAGING_ROOT\/run-/);
  assert.match(updater, /config_metadata.*0:0 600/s);
  assert.match(updater, /wrapper_metadata.*0:0 755/s);
  assert.match(updater, /fsyncSync/);
  assert.match(updater, /mv -fT/);
  assert.match(updater, /--rollback/);
  assert.match(updater, /BOOTSTRAP_INSTALLED/);
  assert.match(updater, /inject_test_failure 'prepare-previous'/);
  assert.match(updater, /inject_test_failure 'promote-live'/);
  assert.doesNotMatch(updater, /AccountID|LicenseKey/);

  assert.match(nginx, /location = \/api\/analytics\/client-context\s*{/);
  assert.match(nginx, /client_max_body_size 16k;/);
  assert.match(nginx, /proxy_set_header X-Forwarded-For \$remote_addr;/);
});

test('DEPLOY post-open image-cache smoke validates root negotiation and localized dynamic homes', async t => {
  const deploy = await fs.readFile(path.join(projectRoot, 'DEPLOY.md'), 'utf8');
  const smokeBlocks = Array.from(
    deploy.matchAll(/```bash[^\S\r\n]*\r?\n([\s\S]*?)\r?\n```/g),
    match => match[1]
  ).filter(block => block.includes('cf-cache-smoke=') && block.includes('extract_final_headers'));
  assert.equal(smokeBlocks.length, 1, `expected one executable image-cache smoke block, got ${smokeBlocks.length}`);
  const smoke = smokeBlocks[0];

  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'deploy-image-smoke-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const bin = path.join(root, 'bin');
  const scriptPath = path.join(root, 'smoke.sh');
  await fs.mkdir(bin);
  await fs.writeFile(scriptPath, `#!/usr/bin/env bash\n${smoke}\n`, { mode: 0o755 });

  const syntax = spawnSync('bash', ['-n', scriptPath], { encoding: 'utf8' });
  assert.equal(syntax.status, 0, syntax.stderr);

  await fs.writeFile(path.join(bin, 'mktemp'), `#!/usr/bin/env bash
set -euo pipefail
count=0
if [[ -f "$SMOKE_MKTEMP_COUNT" ]]; then count="$(cat "$SMOKE_MKTEMP_COUNT")"; fi
count=$((count + 1))
printf '%s' "$count" > "$SMOKE_MKTEMP_COUNT"
created="$SMOKE_MKTEMP_ROOT/generated-$count"
if [[ "\${1:-}" == '-d' && "$#" -eq 1 ]]; then
  mkdir "$created"
  kind='dir'
elif [[ "$#" -eq 0 ]]; then
  : > "$created"
  kind='file'
else
  exit 95
fi
printf '%s|%s|%s\n' "$kind" "$created" "$*" >> "$SMOKE_MKTEMP_LOG"
printf '%s\n' "$created"
`, { mode: 0o755 });

  await fs.writeFile(path.join(bin, 'sleep'), `#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >> "$SMOKE_SLEEP_LOG"
`, { mode: 0o755 });

  await fs.writeFile(path.join(bin, 'curl'), `#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "\${1:-}" >> "$SMOKE_CURL_FIRST_ARG_LOG"
[[ "\${1:-}" == '-q' ]] || exit 94
headers=''
url=''
protocol=''
globoff='false'
max_time=''
end_options='false'
while [[ "$#" -gt 0 ]]; do
  case "$1" in
    -q|-sS)
      shift
      ;;
    --proto)
      if [[ "$#" -lt 2 ]]; then exit 96; fi
      protocol="$2"
      shift 2
      ;;
    --globoff)
      globoff='true'
      shift
      ;;
    --max-time|-D|-o|-w)
      if [[ "$#" -lt 2 ]]; then exit 96; fi
      option="$1"
      if [[ "$option" == '-D' ]]; then headers="$2"; fi
      if [[ "$option" == '--max-time' ]]; then max_time="$2"; fi
      shift 2
      ;;
    --)
      shift
      if [[ "$#" -ne 1 ]]; then exit 96; fi
      url="$1"
      end_options='true'
      shift
      ;;
    *)
      exit 96
      ;;
  esac
done
[[ "$protocol" == '=https' && "$globoff" == 'true' && "$max_time" == '30' && "$end_options" == 'true' ]] || exit 96
[[ -n "$headers" && -n "$url" ]] || exit 96
printf '%s\n' "$url" >> "$SMOKE_CURL_URL_LOG"
status=''
location=''
vary=''
content_type=''
cache_control=''
cf_status=''
age=''
preliminary=''
extra_headers=''
emit_protocol='true'
case "$url" in
  https://blog.cokedaily.space/images/*)
    image_count=0
    if [[ -f "$SMOKE_IMAGE_COUNT" ]]; then image_count="$(cat "$SMOKE_IMAGE_COUNT")"; fi
    image_count=$((image_count + 1))
    printf '%s' "$image_count" > "$SMOKE_IMAGE_COUNT"
    content_type="\${SMOKE_IMAGE_CONTENT_TYPE:-image/webp}"
    cache_control="\${SMOKE_IMAGE_CACHE_CONTROL:-public, max-age=2592000, immutable}"
    preliminary="\${SMOKE_IMAGE_PRELIMINARY:-}"
    emit_protocol="\${SMOKE_IMAGE_PROTOCOL_BLOCK:-true}"
    if [[ "$image_count" -eq 1 ]]; then
      status="\${SMOKE_FIRST_IMAGE_STATUS:-200}"
      cf_status="\${SMOKE_FIRST_CF_STATUS:-MISS}"
      extra_headers="\${SMOKE_FIRST_IMAGE_EXTRA_HEADERS:-}"
    elif [[ "$image_count" -eq 2 ]]; then
      status="\${SMOKE_SECOND_IMAGE_STATUS:-200}"
      cf_status="\${SMOKE_SECOND_CF_STATUS:-HIT}"
      extra_headers="\${SMOKE_SECOND_IMAGE_EXTRA_HEADERS:-}"
    else
      exit 97
    fi
    ;;
  https://blog.cokedaily.space/)
    status="\${SMOKE_ROOT_STATUS:-302}"
    location="\${SMOKE_ROOT_LOCATION:-/zh/}"
    vary="\${SMOKE_VARY:-Cookie, Accept-Language}"
    cache_control="\${SMOKE_ROOT_CACHE_CONTROL:-private, no-store}"
    cf_status="\${SMOKE_ROOT_CF_STATUS:-DYNAMIC}"
    age="\${SMOKE_ROOT_AGE:-}"
    preliminary="\${SMOKE_ROOT_PRELIMINARY:-}"
    extra_headers="\${SMOKE_ROOT_EXTRA_HEADERS:-}"
    emit_protocol="\${SMOKE_ROOT_PROTOCOL_BLOCK:-true}"
    ;;
  https://blog.cokedaily.space/zh/)
    status="\${SMOKE_ZH_STATUS:-200}"
    cache_control="\${SMOKE_ZH_CACHE_CONTROL:-private, no-store}"
    cf_status="\${SMOKE_ZH_CF_STATUS:-DYNAMIC}"
    age="\${SMOKE_ZH_AGE:-}"
    preliminary="\${SMOKE_ZH_PRELIMINARY:-}"
    extra_headers="\${SMOKE_ZH_EXTRA_HEADERS:-}"
    emit_protocol="\${SMOKE_ZH_PROTOCOL_BLOCK:-true}"
    ;;
  https://blog.cokedaily.space/en/)
    status="\${SMOKE_EN_STATUS:-200}"
    cache_control="\${SMOKE_EN_CACHE_CONTROL:-private, no-store}"
    cf_status="\${SMOKE_EN_CF_STATUS:-DYNAMIC}"
    age="\${SMOKE_EN_AGE:-}"
    preliminary="\${SMOKE_EN_PRELIMINARY:-}"
    extra_headers="\${SMOKE_EN_EXTRA_HEADERS:-}"
    emit_protocol="\${SMOKE_EN_PROTOCOL_BLOCK:-true}"
    ;;
  *)
    exit 98
    ;;
esac
: > "$headers"
case "$preliminary" in
  safe-root)
    {
      printf 'HTTP/1.1 103 Early Hints\\r\\n'
      printf 'location: /zh/\\r\\n'
      printf 'vary: Cookie, Accept-Language\\r\\n'
      printf 'cache-control: private, no-store\\r\\n'
      printf 'cf-cache-status: DYNAMIC\\r\\n'
      printf '\\r\\n'
    } >> "$headers"
    ;;
  safe-localized)
    {
      printf 'HTTP/1.1 103 Early Hints\\r\\n'
      printf 'cache-control: private, no-store\\r\\n'
      printf 'cf-cache-status: DYNAMIC\\r\\n'
      printf '\\r\\n'
    } >> "$headers"
    ;;
  safe-image)
    preliminary_cf_status='MISS'
    if [[ "$image_count" -eq 2 ]]; then preliminary_cf_status='HIT'; fi
    {
      printf 'HTTP/1.1 103 Early Hints\\r\\n'
      printf 'content-type: image/webp\\r\\n'
      printf 'cache-control: public, max-age=2592000, immutable\\r\\n'
      printf 'cf-cache-status: %s\\r\\n' "$preliminary_cf_status"
      printf '\\r\\n'
    } >> "$headers"
    ;;
esac
{
  if [[ "$emit_protocol" == 'true' ]]; then printf 'HTTP/2 %s\\r\\n' "$status"; fi
  if [[ -n "$location" ]]; then printf 'location: %s\\r\\n' "$location"; fi
  if [[ -n "$vary" ]]; then printf 'vary: %s\\r\\n' "$vary"; fi
  if [[ -n "$content_type" ]]; then printf 'content-type: %s\\r\\n' "$content_type"; fi
  if [[ -n "$cache_control" ]]; then printf 'cache-control: %s\\r\\n' "$cache_control"; fi
  if [[ -n "$cf_status" ]]; then printf 'cf-cache-status: %s\\r\\n' "$cf_status"; fi
  if [[ -n "$age" ]]; then printf 'age: %s\\r\\n' "$age"; fi
  if [[ -n "$extra_headers" ]]; then printf '%b' "$extra_headers"; fi
  printf '\\r\\n'
} >> "$headers"
printf '%s' "$status"
`, { mode: 0o755 });

  async function readLines(file) {
    try {
      const value = await fs.readFile(file, 'utf8');
      return value.split('\n').filter(Boolean);
    } catch (error) {
      if (error.code === 'ENOENT') return [];
      throw error;
    }
  }

  const behaviorDefaults = Object.freeze({
    SMOKE_FIRST_IMAGE_STATUS: '200',
    SMOKE_SECOND_IMAGE_STATUS: '200',
    SMOKE_IMAGE_CONTENT_TYPE: 'image/webp',
    SMOKE_IMAGE_CACHE_CONTROL: 'public, max-age=2592000, immutable',
    SMOKE_FIRST_CF_STATUS: 'MISS',
    SMOKE_SECOND_CF_STATUS: 'HIT',
    SMOKE_IMAGE_PRELIMINARY: '',
    SMOKE_IMAGE_PROTOCOL_BLOCK: 'true',
    SMOKE_FIRST_IMAGE_EXTRA_HEADERS: '',
    SMOKE_SECOND_IMAGE_EXTRA_HEADERS: '',
    SMOKE_ROOT_STATUS: '302',
    SMOKE_ROOT_LOCATION: '/zh/',
    SMOKE_VARY: 'Cookie, Accept-Language',
    SMOKE_ROOT_CACHE_CONTROL: 'private, no-store',
    SMOKE_ROOT_CF_STATUS: 'DYNAMIC',
    SMOKE_ROOT_AGE: '',
    SMOKE_ROOT_PRELIMINARY: '',
    SMOKE_ROOT_EXTRA_HEADERS: '',
    SMOKE_ROOT_PROTOCOL_BLOCK: 'true',
    SMOKE_ZH_STATUS: '200',
    SMOKE_ZH_CACHE_CONTROL: 'private, no-store',
    SMOKE_ZH_CF_STATUS: 'DYNAMIC',
    SMOKE_ZH_AGE: '',
    SMOKE_ZH_PRELIMINARY: '',
    SMOKE_ZH_EXTRA_HEADERS: '',
    SMOKE_ZH_PROTOCOL_BLOCK: 'true',
    SMOKE_EN_STATUS: '200',
    SMOKE_EN_CACHE_CONTROL: 'private, no-store',
    SMOKE_EN_CF_STATUS: 'DYNAMIC',
    SMOKE_EN_AGE: '',
    SMOKE_EN_PRELIMINARY: '',
    SMOKE_EN_EXTRA_HEADERS: '',
    SMOKE_EN_PROTOCOL_BLOCK: 'true'
  });

  async function runScenario(
    name,
    overrides = {},
    imageUrl = 'https://blog.cokedaily.space/images/existing.webp'
  ) {
    const scenarioRoot = path.join(root, name);
    await fs.mkdir(scenarioRoot);
    const files = {
      mktempLog: path.join(scenarioRoot, 'mktemp.log'),
      mktempCount: path.join(scenarioRoot, 'mktemp-count'),
      curlFirstArgLog: path.join(scenarioRoot, 'curl-first-arg.log'),
      curlUrlLog: path.join(scenarioRoot, 'curl-url.log'),
      imageCount: path.join(scenarioRoot, 'image-count'),
      sleepLog: path.join(scenarioRoot, 'sleep.log')
    };
    const result = spawnSync('bash', [scriptPath, imageUrl], {
      encoding: 'utf8',
      env: {
        PATH: `${bin}:${process.env.PATH || '/usr/bin:/bin'}`,
        HOME: scenarioRoot,
        TMPDIR: process.env.TMPDIR || os.tmpdir(),
        LANG: 'C',
        LC_ALL: 'C',
        ...behaviorDefaults,
        ...overrides,
        SMOKE_MKTEMP_ROOT: scenarioRoot,
        SMOKE_MKTEMP_LOG: files.mktempLog,
        SMOKE_MKTEMP_COUNT: files.mktempCount,
        SMOKE_CURL_FIRST_ARG_LOG: files.curlFirstArgLog,
        SMOKE_CURL_URL_LOG: files.curlUrlLog,
        SMOKE_IMAGE_COUNT: files.imageCount,
        SMOKE_SLEEP_LOG: files.sleepLog
      }
    });
    return {
      ...result,
      mktempEntries: await readLines(files.mktempLog),
      curlFirstArgs: await readLines(files.curlFirstArgLog),
      curlUrls: await readLines(files.curlUrlLog),
      sleepCalls: await readLines(files.sleepLog)
    };
  }

  async function assertOneCleanTempDirectory(run, label) {
    assert.equal(run.mktempEntries.length, 1, `${label} must allocate exactly one temporary path`);
    const [kind, createdPath, args] = run.mktempEntries[0].split('|');
    assert.equal(kind, 'dir', `${label} temporary path must be a directory`);
    assert.equal(args, '-d', `${label} must invoke mktemp -d`);
    await assert.rejects(
      fs.access(createdPath),
      error => error.code === 'ENOENT',
      `${label} temporary directory must be removed by the EXIT trap`
    );
  }

  const valid = await runScenario('valid');
  assert.equal(valid.status, 0, `valid fixture failed:\n${valid.stderr}`);

  const invalidImageUrls = new Map([
    ['option-shaped-input', '--help'],
    ['option-shaped-filename', 'https://blog.cokedaily.space/images/-evil.webp'],
    ['alternate-host', 'https://evil.example/images/existing.webp'],
    ['http-scheme', 'http://blog.cokedaily.space/images/existing.webp'],
    ['userinfo', 'https://operator@blog.cokedaily.space/images/existing.webp'],
    ['unexpected-port', 'https://blog.cokedaily.space:443/images/existing.webp'],
    ['query', 'https://blog.cokedaily.space/images/existing.webp?source=test'],
    ['fragment', 'https://blog.cokedaily.space/images/existing.webp#fragment'],
    ['extra-path-segment', 'https://blog.cokedaily.space/images/nested/existing.webp'],
    ['path-traversal', 'https://blog.cokedaily.space/images/../existing.webp'],
    ['percent-syntax', 'https://blog.cokedaily.space/images/existing%2Ewebp'],
    ['control-character', 'https://blog.cokedaily.space/images/control\nname.webp'],
    ['glob-brackets', 'https://blog.cokedaily.space/images/image[1].webp'],
    ['glob-braces', 'https://blog.cokedaily.space/images/{one,two}.webp']
  ]);
  const invalidUrlRuns = new Map();
  for (const [name, imageUrl] of invalidImageUrls) {
    const run = await runScenario(`invalid-url-${name}`, {}, imageUrl);
    assert.equal(run.status, 64, `${name} IMAGE_URL must be rejected with usage status 64`);
    assert.equal(run.curlFirstArgs.length, 0, `${name} IMAGE_URL reached the curl stub`);
    assert.equal(run.curlUrls.length, 0, `${name} IMAGE_URL produced a curl URL`);
    assert.equal(run.mktempEntries.length, 0, `${name} IMAGE_URL must be rejected before mktemp`);
    invalidUrlRuns.set(name, run);
  }

  const rootPreliminaryExpectedFinalUnsafe = await runScenario('root-preliminary-expected-final-unsafe', {
    SMOKE_ROOT_PRELIMINARY: 'safe-root',
    SMOKE_ROOT_LOCATION: '/unsafe/'
  });
  assert.notEqual(rootPreliminaryExpectedFinalUnsafe.status, 0,
    'root assertions must ignore expected headers from a preliminary response block');

  const localizedPreliminaryExpectedFinalUnsafe = await runScenario(
    'localized-preliminary-expected-final-unsafe',
    {
      SMOKE_ZH_PRELIMINARY: 'safe-localized',
      SMOKE_ZH_CACHE_CONTROL: 'public, no-store'
    }
  );
  assert.notEqual(localizedPreliminaryExpectedFinalUnsafe.status, 0,
    'localized assertions must ignore expected headers from a preliminary response block');

  const imagePreliminaryExpectedFinalUnsafe = await runScenario('image-preliminary-expected-final-unsafe', {
    SMOKE_IMAGE_PRELIMINARY: 'safe-image',
    SMOKE_IMAGE_CONTENT_TYPE: 'image/png'
  });
  assert.notEqual(imagePreliminaryExpectedFinalUnsafe.status, 0,
    'image assertions must ignore expected headers from a preliminary response block');

  const validSplitListHeaders = await runScenario('valid-split-list-headers', {
    SMOKE_IMAGE_CACHE_CONTROL: 'public',
    SMOKE_FIRST_IMAGE_EXTRA_HEADERS: 'cache-control: immutable, max-age=2592000\\r\\n',
    SMOKE_SECOND_IMAGE_EXTRA_HEADERS: 'cache-control: immutable, max-age=2592000\\r\\n',
    SMOKE_VARY: 'Cookie',
    SMOKE_ROOT_CACHE_CONTROL: 'private',
    SMOKE_ROOT_EXTRA_HEADERS: 'vary: Accept-Language, Accept-Encoding\\r\\ncache-control: no-store\\r\\n',
    SMOKE_ZH_CACHE_CONTROL: 'private',
    SMOKE_ZH_EXTRA_HEADERS: 'cache-control: no-store\\r\\n',
    SMOKE_EN_CACHE_CONTROL: 'private',
    SMOKE_EN_EXTRA_HEADERS: 'cache-control: no-store\\r\\n'
  });
  assert.equal(validSplitListHeaders.status, 0,
    `valid split list-valued headers failed:\n${validSplitListHeaders.stderr}`);

  const missingProtocolBlock = await runScenario('missing-protocol-block', {
    SMOKE_ROOT_PROTOCOL_BLOCK: 'false'
  });
  assert.notEqual(missingProtocolBlock.status, 0, 'headers without an HTTP protocol response block must fail');

  const rootSharedCache = await runScenario('root-shared-cache', {
    SMOKE_ROOT_CACHE_CONTROL: 'public, no-store'
  });
  assert.notEqual(rootSharedCache.status, 0, 'root redirect must require private, no-store');

  const rootNotDynamic = await runScenario('root-not-dynamic', { SMOKE_ROOT_CF_STATUS: 'HIT' });
  assert.notEqual(rootNotDynamic.status, 0, 'root redirect must require Cloudflare DYNAMIC');

  const rootWithAge = await runScenario('root-with-age', { SMOKE_ROOT_AGE: '60' });
  assert.notEqual(rootWithAge.status, 0, 'root redirect must reject an Age header');

  const duplicateRootLocation = await runScenario('duplicate-root-location', {
    SMOKE_ROOT_EXTRA_HEADERS: 'location: /en/\\r\\n'
  });
  assert.notEqual(duplicateRootLocation.status, 0, 'root redirect must reject duplicate Location fields');

  const duplicateRootCacheStatus = await runScenario('duplicate-root-cache-status', {
    SMOKE_ROOT_EXTRA_HEADERS: 'cf-cache-status: HIT\\r\\n'
  });
  assert.notEqual(duplicateRootCacheStatus.status, 0,
    'root redirect must reject duplicate CF-Cache-Status fields');

  const contradictoryRootCacheControl = await runScenario('contradictory-root-cache-control', {
    SMOKE_ROOT_EXTRA_HEADERS: 'cache-control: public\\r\\n'
  });
  assert.notEqual(contradictoryRootCacheControl.status, 0,
    'root redirect must reject contradictory Cache-Control directives');

  const duplicateRequiredVaryToken = await runScenario('duplicate-required-vary-token', {
    SMOKE_ROOT_EXTRA_HEADERS: 'vary: Cookie\\r\\n'
  });
  assert.notEqual(duplicateRequiredVaryToken.status, 0, 'root Vary must reject duplicate Cookie tokens');

  const wildcardVary = await runScenario('wildcard-vary', {
    SMOKE_VARY: 'Cookie, Accept-Language, *'
  });
  assert.notEqual(wildcardVary.status, 0, 'root Vary must reject wildcard tokens');

  const wrongRootStatus = await runScenario('wrong-root-status', { SMOKE_ROOT_STATUS: '200' });
  assert.notEqual(wrongRootStatus.status, 0, 'root smoke must require HTTP 302');

  const wrongZhStatus = await runScenario('wrong-zh-status', { SMOKE_ZH_STATUS: '503' });
  assert.notEqual(wrongZhStatus.status, 0, '/zh/ smoke must require HTTP 200');

  const wrongEnStatus = await runScenario('wrong-en-status', { SMOKE_EN_STATUS: '503' });
  assert.notEqual(wrongEnStatus.status, 0, '/en/ smoke must require HTTP 200');

  const wrongDefault = await runScenario('wrong-default', { SMOKE_ROOT_LOCATION: '/en/' });
  assert.notEqual(wrongDefault.status, 0, 'root without preferences must reject /en/ instead of accepting either locale');

  const invalidCookieToken = await runScenario('invalid-cookie-token', {
    SMOKE_VARY: 'X-Cookie, Accept-Language'
  });
  assert.notEqual(invalidCookieToken.status, 0, 'Vary must reject X-Cookie as a substitute for Cookie');

  const invalidLanguageToken = await runScenario('invalid-language-token', {
    SMOKE_VARY: 'Cookie, X-Accept-Language'
  });
  assert.notEqual(invalidLanguageToken.status, 0, 'Vary must reject X-Accept-Language as a substitute for Accept-Language');

  const zhSharedCache = await runScenario('zh-shared-cache', {
    SMOKE_ZH_CACHE_CONTROL: 'public, no-store'
  });
  assert.notEqual(zhSharedCache.status, 0, '/zh/ must require private, no-store');

  const enSharedCache = await runScenario('en-shared-cache', {
    SMOKE_EN_CACHE_CONTROL: 'public, no-store'
  });
  assert.notEqual(enSharedCache.status, 0, '/en/ must require private, no-store');

  const zhNotDynamic = await runScenario('zh-not-dynamic', { SMOKE_ZH_CF_STATUS: 'HIT' });
  assert.notEqual(zhNotDynamic.status, 0, '/zh/ must require Cloudflare DYNAMIC');

  const enNotDynamic = await runScenario('en-not-dynamic', { SMOKE_EN_CF_STATUS: 'HIT' });
  assert.notEqual(enNotDynamic.status, 0, '/en/ must require Cloudflare DYNAMIC');

  const zhHomeWithAge = await runScenario('zh-home-with-age', { SMOKE_ZH_AGE: '60' });
  assert.notEqual(zhHomeWithAge.status, 0, '/zh/ must reject an Age header');

  const enHomeWithAge = await runScenario('en-home-with-age', { SMOKE_EN_AGE: '60' });
  assert.notEqual(enHomeWithAge.status, 0, '/en/ must reject an Age header');

  const duplicateLocalizedCacheStatus = await runScenario('duplicate-localized-cache-status', {
    SMOKE_ZH_EXTRA_HEADERS: 'cf-cache-status: HIT\\r\\n'
  });
  assert.notEqual(duplicateLocalizedCacheStatus.status, 0,
    'localized HTML must reject duplicate CF-Cache-Status fields');

  const contradictoryLocalizedCacheControl = await runScenario('contradictory-localized-cache-control', {
    SMOKE_EN_EXTRA_HEADERS: 'cache-control: public\\r\\n'
  });
  assert.notEqual(contradictoryLocalizedCacheControl.status, 0,
    'localized HTML must reject contradictory Cache-Control directives');

  const wrongFirstImageStatus = await runScenario('wrong-first-image-status', {
    SMOKE_FIRST_IMAGE_STATUS: '503'
  });
  assert.notEqual(wrongFirstImageStatus.status, 0, 'first image request must require HTTP 200');

  const wrongSecondImageStatus = await runScenario('wrong-second-image-status', {
    SMOKE_SECOND_IMAGE_STATUS: '503'
  });
  assert.notEqual(wrongSecondImageStatus.status, 0, 'second image request must require HTTP 200');

  const wrongImageContentType = await runScenario('wrong-image-content-type', {
    SMOKE_IMAGE_CONTENT_TYPE: 'image/png'
  });
  assert.notEqual(wrongImageContentType.status, 0, 'image response must require image/webp');

  const duplicateImageContentType = await runScenario('duplicate-image-content-type', {
    SMOKE_FIRST_IMAGE_EXTRA_HEADERS: 'content-type: image/png\\r\\n'
  });
  assert.notEqual(duplicateImageContentType.status, 0, 'image response must reject duplicate Content-Type fields');

  const duplicateImageCacheStatus = await runScenario('duplicate-image-cache-status', {
    SMOKE_FIRST_IMAGE_EXTRA_HEADERS: 'cf-cache-status: HIT\\r\\n'
  });
  assert.notEqual(duplicateImageCacheStatus.status, 0,
    'image response must reject duplicate CF-Cache-Status fields');

  const duplicateImageCacheDirective = await runScenario('duplicate-image-cache-directive', {
    SMOKE_FIRST_IMAGE_EXTRA_HEADERS: 'cache-control: public\\r\\n'
  });
  assert.notEqual(duplicateImageCacheDirective.status, 0,
    'image response must reject duplicate Cache-Control directives');

  const wrongImageMaxAge = await runScenario('wrong-image-max-age', {
    SMOKE_IMAGE_CACHE_CONTROL: 'public, max-age=2592001, immutable'
  });
  assert.notEqual(wrongImageMaxAge.status, 0, 'image response must require exact max-age=2592000');

  const imageNotPublic = await runScenario('image-not-public', {
    SMOKE_IMAGE_CACHE_CONTROL: 'private, max-age=2592000, immutable'
  });
  assert.notEqual(imageNotPublic.status, 0, 'image response must require public cacheability');

  const imageNotImmutable = await runScenario('image-not-immutable', {
    SMOKE_IMAGE_CACHE_CONTROL: 'public, max-age=2592000, must-revalidate'
  });
  assert.notEqual(imageNotImmutable.status, 0, 'image response must require immutable caching');

  const firstImageNotMiss = await runScenario('first-image-not-miss', { SMOKE_FIRST_CF_STATUS: 'HIT' });
  assert.notEqual(firstImageNotMiss.status, 0, 'first image request must require Cloudflare MISS');

  const secondImageNotHit = await runScenario('second-image-not-hit', { SMOKE_SECOND_CF_STATUS: 'MISS' });
  assert.notEqual(secondImageNotHit.status, 0, 'second image request must require Cloudflare HIT');

  const imageWithUpstreamMaxAgeZero = await runScenario('image-with-upstream-max-age-zero', {
    SMOKE_IMAGE_CACHE_CONTROL: 'public, max-age=2592000, max-age=0, immutable'
  });
  assert.notEqual(imageWithUpstreamMaxAgeZero.status, 0, 'image response must reject upstream max-age=0');

  assert.equal(valid.curlUrls.length, 5, 'valid smoke must make two image, root, zh, and en requests');
  assert.equal(valid.curlUrls[0], valid.curlUrls[1], 'both image requests must use the same cache-busted URL');
  assert.match(valid.curlUrls[0], /\/images\/existing\.webp\?cf-cache-smoke=\d+$/);
  assert.deepEqual(valid.curlUrls.slice(2), [
    'https://blog.cokedaily.space/',
    'https://blog.cokedaily.space/zh/',
    'https://blog.cokedaily.space/en/'
  ]);
  assert.equal(valid.sleepCalls.length, 1, 'the local sleep stub must service the inter-request pause');
  assert.equal(valid.curlFirstArgs.every(argument => argument === '-q'), true,
    'every curl invocation must use -q as its first option');

  const executableLines = smoke.split(/\r?\n/).map(line => line.trim()).filter(line => line && !line.startsWith('#'));
  assert.equal(executableLines[0], 'set -euo pipefail', 'smoke must begin in Bash strict mode');
  const tempAllocation = executableLines.findIndex(line => /mktemp\s+-d/.test(line));
  assert.notEqual(tempAllocation, -1, 'smoke must allocate one temporary directory');
  assert.match(executableLines[tempAllocation + 1] || '', /^trap\b/, 'cleanup trap must immediately follow temp allocation');

  await assertOneCleanTempDirectory(valid, 'successful smoke');
  await assertOneCleanTempDirectory(enHomeWithAge, 'late /en/ Age assertion failure');

  const rejectedFixtures = new Map([
    ['root-preliminary-expected-final-unsafe', rootPreliminaryExpectedFinalUnsafe],
    ['localized-preliminary-expected-final-unsafe', localizedPreliminaryExpectedFinalUnsafe],
    ['image-preliminary-expected-final-unsafe', imagePreliminaryExpectedFinalUnsafe],
    ['missing-protocol-block', missingProtocolBlock],
    ['root-shared-cache', rootSharedCache],
    ['root-not-dynamic', rootNotDynamic],
    ['root-with-age', rootWithAge],
    ['duplicate-root-location', duplicateRootLocation],
    ['duplicate-root-cache-status', duplicateRootCacheStatus],
    ['contradictory-root-cache-control', contradictoryRootCacheControl],
    ['duplicate-required-vary-token', duplicateRequiredVaryToken],
    ['wildcard-vary', wildcardVary],
    ['wrong-root-status', wrongRootStatus],
    ['wrong-zh-status', wrongZhStatus],
    ['wrong-en-status', wrongEnStatus],
    ['wrong-default', wrongDefault],
    ['invalid-cookie-token', invalidCookieToken],
    ['invalid-language-token', invalidLanguageToken],
    ['zh-shared-cache', zhSharedCache],
    ['en-shared-cache', enSharedCache],
    ['zh-not-dynamic', zhNotDynamic],
    ['en-not-dynamic', enNotDynamic],
    ['zh-home-with-age', zhHomeWithAge],
    ['en-home-with-age', enHomeWithAge],
    ['duplicate-localized-cache-status', duplicateLocalizedCacheStatus],
    ['contradictory-localized-cache-control', contradictoryLocalizedCacheControl],
    ['wrong-first-image-status', wrongFirstImageStatus],
    ['wrong-second-image-status', wrongSecondImageStatus],
    ['wrong-image-content-type', wrongImageContentType],
    ['duplicate-image-content-type', duplicateImageContentType],
    ['duplicate-image-cache-status', duplicateImageCacheStatus],
    ['duplicate-image-cache-directive', duplicateImageCacheDirective],
    ['wrong-image-max-age', wrongImageMaxAge],
    ['image-not-public', imageNotPublic],
    ['image-not-immutable', imageNotImmutable],
    ['first-image-not-miss', firstImageNotMiss],
    ['second-image-not-hit', secondImageNotHit],
    ['image-with-upstream-max-age-zero', imageWithUpstreamMaxAgeZero]
  ]);
  const rejectedSummary = Array.from(
    rejectedFixtures,
    ([name, run]) => `${name}=${run.status}`
  ).join(', ');
  t.diagnostic(`failure fixtures rejected: ${rejectedSummary}`);
  t.diagnostic(`invalid IMAGE_URL fixtures rejected before curl: ${invalidUrlRuns.size}; total curl calls=0`);
  t.diagnostic('valid split Cache-Control/Vary field lines were combined successfully');
  t.diagnostic('cleanup verified on success and a late assertion failure: one mktemp -d directory removed by the EXIT trap');
  t.diagnostic('network-free curl stub handled all five valid requests and enforced -q first, HTTPS-only protocol, globoff, max-time 30, no redirect option, and -- before URL');
});

test('Nginx caches static assets only by explicit prefixes and gates public traffic during maintenance', async () => {
  const [nginx, maintenance] = await Promise.all([
    fs.readFile(path.join(projectRoot, 'deploy/nginx/blog.conf'), 'utf8'),
    fs.readFile(path.join(projectRoot, 'deploy/nginx/blog-maintenance.conf'), 'utf8')
  ]);

  // No extension-wide cache regex: a dot-containing taxonomy HTML route such as
  // /zh/tag/Node.js must keep flowing through the dynamic proxy instead of
  // being captured by an extension cache location.
  assert.doesNotMatch(nginx, /location\s+~\*\s*\.\(/, 'extension-wide regex location present');
  assert.doesNotMatch(nginx, /location\s+~/, 'any regex location present');

  // Explicit static path prefixes and the exact favicon route.
  for (const prefix of ['/css/', '/js/', '/vendor/', '/fonts/', '/images/']) {
    const escaped = prefix.replaceAll('/', '\\/');
    assert.match(nginx, new RegExp(`location\\s+${escaped}\\s*\\{`), `static prefix ${prefix} missing`);
  }
  assert.match(nginx, /location\s+=\s*\/favicon\.ico\s*\{/, 'exact favicon route missing');

  // Images must preserve the public URI when proxying to Express. Nginx owns
  // the 30-day success cache headers and must suppress Express's max-age=0.
  const imagesBlock = extractLocationBlock(nginx, '/images/');
  assert.match(imagesBlock, /proxy_pass\s+http:\/\/127\.0\.0\.1:3000;/, 'images must proxy to Express without a URI suffix');
  assert.doesNotMatch(imagesBlock, /proxy_pass\s+http:\/\/127\.0\.0\.1:3000\//, 'images proxy_pass must not rewrite the URI');
  assert.doesNotMatch(imagesBlock, /\balias\b/, 'images must not use a filesystem alias');
  assert.doesNotMatch(imagesBlock, /\/root\/Blog/, 'images must not depend on traversing /root');
  assert.match(imagesBlock, /proxy_hide_header\s+Cache-Control;/, 'upstream Cache-Control must be hidden');
  assert.match(imagesBlock, /proxy_hide_header\s+Expires;/, 'upstream Expires must be hidden');
  assert.match(imagesBlock, /expires\s+30d;/, 'images must retain 30-day success caching');
  assert.match(imagesBlock, /add_header\s+Cache-Control\s+"public, immutable";/, 'images must retain public immutable caching');
  assert.doesNotMatch(imagesBlock, /\balways\b/, 'image cache headers must not be added to error responses');

  // The catch-all dynamic proxy is the only location able to serve
  // /zh/tag/Node.js (no static prefix shadows it and no regex captures it).
  assert.match(nginx, /location\s+(\/\s*\{|\{\s*$)/, 'dynamic proxy catch-all missing');
  assert.match(nginx, /proxy_pass\s+http:\/\/127\.0\.0\.1:3000;/);
  assert.match(nginx, /Node\.js/, 'the /zh/tag/Node.js dynamic contract must be documented');

  // Public maintenance gate: 503 for public traffic with loopback and a
  // documented operator allowlist bypass for candidate-app smoke tests.
  assert.match(maintenance, /return\s+503/, 'maintenance gate must return 503');
  assert.match(maintenance, /127\.0\.0\.1/, 'loopback bypass missing');
  assert.match(maintenance, /::1/, 'IPv6 loopback bypass missing');
  assert.match(maintenance, /allowlist/i, 'operator allowlist must be documented');
  assert.match(nginx, /nginx -t/, 'nginx -t before reload must be documented');

  // The enable include must be pinned as an inert, commented line INSIDE the
  // HTTPS server block: uncommenting it gates the 443 listener. It must never
  // be a top-level line (invalid nginx) or a line inside the port-80 redirect
  // block (which would leave HTTPS ungated), and it must ship commented so
  // public traffic is open by default.
  const blocks = extractServerBlocks(nginx);
  assert.equal(blocks.length, 2, `expected HTTP redirect + HTTPS server blocks, got ${blocks.length}`);
  const redirectBlock = blocks.find(block => /listen\s+80/.test(block));
  const httpsBlock = blocks.find(block => /listen\s+443\s+ssl/.test(block));
  assert.ok(redirectBlock, 'port-80 redirect server block missing');
  assert.ok(httpsBlock, '443 ssl server block missing');

  const commentedInclude = /^\s*#\s*include\s+\S*blog-maintenance\.conf\s*;?\s*$/m;
  const activeInclude = /^\s*include\s+\S*blog-maintenance\.conf\s*;?\s*$/m;
  assert.match(httpsBlock, commentedInclude, 'maintenance gate include must be a commented line inside the 443 server block');
  assert.doesNotMatch(httpsBlock, activeInclude, 'maintenance gate include must ship inert (commented)');
  assert.doesNotMatch(redirectBlock, /blog-maintenance\.conf/, 'maintenance gate must not be referenced in the port-80 redirect block');
  const topLevel = nginx.slice(0, nginx.indexOf('server {'));
  assert.doesNotMatch(
    topLevel,
    /^\s*(#\s*)?include\s+\S*blog-maintenance\.conf\s*;?\s*$/m,
    'maintenance gate include line must not appear at the top level outside server blocks'
  );
});

// Split a server block out of the config by brace matching so placement
// assertions are structural rather than a bare filename search.
function extractServerBlocks(nginx) {
  const blocks = [];
  let cursor = 0;
  while (true) {
    const start = nginx.indexOf('server {', cursor);
    if (start === -1) break;
    let depth = 0;
    let end = -1;
    for (let index = start; index < nginx.length; index += 1) {
      if (nginx[index] === '{') depth += 1;
      else if (nginx[index] === '}') {
        depth -= 1;
        if (depth === 0) {
          end = index;
          break;
        }
      }
    }
    if (end === -1) throw new Error('unbalanced server block in blog.conf');
    blocks.push(nginx.slice(start, end + 1));
    cursor = end + 1;
  }
  return blocks;
}

function extractLocationBlock(nginx, location) {
  const escaped = location.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(`location\\s+${escaped}\\s*\\{`).exec(nginx);
  if (!match) throw new Error(`location ${location} missing from blog.conf`);

  let depth = 0;
  for (let index = match.index; index < nginx.length; index += 1) {
    if (nginx[index] === '{') depth += 1;
    else if (nginx[index] === '}') {
      depth -= 1;
      if (depth === 0) return nginx.slice(match.index, index + 1);
    }
  }
  throw new Error(`unbalanced location ${location} block in blog.conf`);
}

test('Linux updater covers lock, bootstrap, no-op, failure preservation, promotion, and rollback', {
  skip: process.platform !== 'linux' ? 'Linux + flock integration only' : false
}, async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'geoip-updater-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));

  const project = path.join(root, 'root/Blog');
  const bin = path.join(root, 'bin');
  const config = path.join(root, 'etc/GeoIP.conf');
  const fakeUpdater = path.join(bin, 'geoipupdate');
  const fakeVerifier = path.join(project, 'scripts/verify-fixture.js');
  await fs.mkdir(path.dirname(config), { recursive: true });
  await fs.mkdir(bin, { recursive: true });
  await fs.mkdir(path.dirname(fakeVerifier), { recursive: true });
  await fs.writeFile(config, 'fixture only\n', { mode: 0o600 });
  await fs.writeFile(fakeUpdater, `#!/usr/bin/env bash
set -euo pipefail
if [[ "\${FAKE_DOWNLOAD_FAIL:-}" == 'true' ]]; then exit 68; fi
destination=''
while [[ $# -gt 0 ]]; do
  case "$1" in
    -d) destination="$2"; shift 2 ;;
    -f) shift 2 ;;
    *) exit 64 ;;
  esac
done
mkdir -p "$destination"
printf '%s' "$FAKE_DATABASE_CONTENT" > "$destination/GeoLite2-City.mmdb"
`, { mode: 0o755 });
  await fs.writeFile(fakeVerifier, `const crypto=require('node:crypto');
const fs=require('node:fs');
const value=fs.readFileSync(process.argv[2]);
const match=/^(\\d+):/.exec(value.toString('utf8'));
if(!match)process.exit(65);
process.stdout.write(JSON.stringify({sha256:crypto.createHash('sha256').update(value).digest('hex'),datasetEpoch:Number(match[1])}));
`, { mode: 0o644 });

  const script = path.join(projectRoot, 'scripts/update-geoip.sh');
  const baseEnvironment = {
    ...process.env,
    NODE_ENV: 'test',
    BLOG_GEOIP_UPDATE_TEST_ROOT: root,
    BLOG_GEOIP_UPDATE_TEST_PROJECT_ROOT: project,
    BLOG_GEOIP_UPDATE_TEST_CONFIG: config,
    BLOG_GEOIP_UPDATE_TEST_BIN: fakeUpdater,
    BLOG_GEOIP_UPDATE_TEST_NODE_BIN: process.execPath,
    BLOG_GEOIP_UPDATE_TEST_VERIFY_SCRIPT: fakeVerifier
  };
  const run = (content, extra = {}, args = []) => spawnSync('bash', [script, ...args], {
    env: { ...baseEnvironment, FAKE_DATABASE_CONTENT: content, ...extra },
    encoding: 'utf8'
  });
  const live = path.join(root, 'var/lib/blog/geoip/GeoLite2-City.mmdb');
  const previous = `${live}.previous`;
  const statusPath = path.join(root, 'var/lib/blog/geoip/update-status.json');

  const bootstrap = run('1784246400:first');
  assert.equal(bootstrap.status, 0, bootstrap.stderr);
  assert.equal(await fs.readFile(live, 'utf8'), '1784246400:first');
  assert.equal((await fs.stat(live)).mode & 0o777, 0o644);
  assert.equal(JSON.parse(await fs.readFile(statusPath, 'utf8')).result, 'bootstrap');
  await assert.rejects(fs.access(previous));

  const noOp = run('1784246400:first');
  assert.equal(noOp.status, 0, noOp.stderr);
  assert.equal(JSON.parse(await fs.readFile(statusPath, 'utf8')).result, 'no-op');

  const promoted = run('1784851200:second');
  assert.equal(promoted.status, 0, promoted.stderr);
  assert.equal(await fs.readFile(live, 'utf8'), '1784851200:second');
  assert.equal(await fs.readFile(previous, 'utf8'), '1784246400:first');
  assert.equal(JSON.parse(await fs.readFile(statusPath, 'utf8')).result, 'updated');

  const beforeFailure = crypto.createHash('sha256').update(await fs.readFile(live)).digest('hex');
  const failed = run('1785456000:third', { FAKE_DOWNLOAD_FAIL: 'true' });
  assert.notEqual(failed.status, 0);
  const afterFailure = crypto.createHash('sha256').update(await fs.readFile(live)).digest('hex');
  assert.equal(afterFailure, beforeFailure);
  const failedStatus = JSON.parse(await fs.readFile(statusPath, 'utf8'));
  assert.equal(failedStatus.result, 'failed');
  assert.equal(failedStatus.errorCategory, 'download_failed');

  const lockPath = path.join(root, 'run/blog-geoip-update/update.lock');
  const holder = spawn('bash', ['-c', 'exec 9>"$LOCK_PATH"; flock --nonblock 9; printf ready; sleep 30'], {
    env: { ...process.env, LOCK_PATH: lockPath },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  t.after(() => holder.kill('SIGTERM'));
  const [ready] = await once(holder.stdout, 'data');
  assert.match(ready.toString(), /ready/);
  const locked = run('1785456000:third');
  assert.equal(locked.status, 75);
  assert.match(locked.stderr, /already_running/);
  holder.kill('SIGTERM');

  const rollback = run('', {}, ['--rollback']);
  assert.equal(rollback.status, 0, rollback.stderr);
  assert.equal(await fs.readFile(live, 'utf8'), '1784246400:first');
  assert.equal(await fs.readFile(previous, 'utf8'), '1784246400:first');
  assert.equal(JSON.parse(await fs.readFile(statusPath, 'utf8')).datasetEpoch, 1784246400);

  for (const stage of ['prepare-previous', 'promote-live']) {
    const beforeInjectedFailure = await fs.readFile(live, 'utf8');
    const injected = run('1785456000:third', { BLOG_GEOIP_UPDATE_TEST_FAIL_STAGE: stage });
    assert.notEqual(injected.status, 0);
    assert.equal(await fs.readFile(live, 'utf8'), beforeInjectedFailure);
    const injectedStatus = JSON.parse(await fs.readFile(statusPath, 'utf8'));
    assert.equal(injectedStatus.result, 'failed');
    assert.equal(injectedStatus.errorCategory, `${stage.replaceAll('-', '_')}_failed`);
  }

  await fs.rm(live);
  await fs.rm(previous, { force: true });
  const failedBootstrap = run('1785456000:third', {
    BLOG_GEOIP_UPDATE_TEST_FAIL_STAGE: 'bootstrap-after-promote'
  });
  assert.notEqual(failedBootstrap.status, 0);
  await assert.rejects(fs.access(live));
  assert.equal(JSON.parse(await fs.readFile(statusPath, 'utf8')).errorCategory, 'bootstrap_after_promote_failed');

  const stagingEntries = await fs.readdir(path.join(root, 'var/lib/blog/geoip/staging'));
  assert.deepEqual(stagingEntries, []);
});

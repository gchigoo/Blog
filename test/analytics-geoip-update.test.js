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

test('DEPLOY prevents Cloudflare from caching any HTTP error response', async () => {
  const deploy = await fs.readFile(path.join(projectRoot, 'DEPLOY.md'), 'utf8');

  function extractRequiredSection(text, startMarker, endMarker, label) {
    const start = text.indexOf(startMarker);
    assert.notEqual(start, -1, `${label} start marker missing`);
    const end = text.indexOf(endMarker, start + startMarker.length);
    assert.notEqual(end, -1, `${label} end marker missing`);
    return text.slice(start, end);
  }

  function assertOrdered(text, markers, label) {
    let cursor = -1;
    for (const marker of markers) {
      const index = text.indexOf(marker, cursor + 1);
      assert.ok(index > cursor, `${label} marker missing or out of order: ${marker}`);
      cursor = index;
    }
  }

  function validateErrorCacheContract(text) {
    const section = extractRequiredSection(
      text,
      '#### Cloudflare 错误响应缓存防护',
      '#### Cloudflare 图片缓存确定性回滚',
      'Cloudflare error-response cache protection section'
    );
    const ruleContract = extractRequiredSection(
      section,
      '##### 规则写入契约（不可放宽）',
      '##### 控制面回读与冲突审计（强制）',
      'Cloudflare error-response rule contract'
    );
    const readback = extractRequiredSection(
      section,
      '##### 控制面回读与冲突审计（强制）',
      '##### Cloudflare Trace 终态验证（强制）',
      'Cloudflare error-response control-plane readback'
    );
    const trace = extractRequiredSection(
      section,
      '##### Cloudflare Trace 终态验证（强制）',
      '##### Purge 与公网验证',
      'Cloudflare error-response Trace verification'
    );
    const publicVerification = section.slice(section.indexOf('##### Purge 与公网验证'));

    assert.match(section, /HTML 4xx\/5xx[\s\S]*真实 HTML\/API 500/);
    assert.match(section, /private, no-store/);
    assert.match(ruleContract, /- 规则名：`Do not cache error responses`/);
    assert.match(ruleContract, /- Phase：`http_response_cache_settings`/);
    const enabled = /- 状态：`([^`\r\n]+)`/.exec(ruleContract);
    assert.ok(enabled, 'error-response rule enabled state missing');
    assert.equal(enabled[1], 'enabled: true', 'error-response rule must be explicitly enabled');
    const expression = /- 匹配表达式：`([^`\r\n]+)`/.exec(ruleContract);
    assert.ok(expression, 'error-response rule expression missing');
    assert.equal(expression[1], '(http.response.code ge 400)');
    assert.match(ruleContract, /- Action：`set_cache_control`/);
    assert.match(ruleContract, /"no-store"\s*:\s*\{\s*"operation"\s*:\s*"set"\s*,\s*"cloudflare_only"\s*:\s*true\s*\}/);
    assert.match(ruleContract, /最后一条 Enabled 的 `set_cache_control` 规则/,
      'target rule must be the final enabled cache-control modifier');
    assert.match(ruleContract, /目标规则之后还存在任何 Enabled 的 `set_cache_control` 规则[^\n]*停止发布/,
      'a later cache-control modifier must block release');

    assert.match(readback, /GET \/zones\/\$ZONE_ID\/rulesets\/phases\/http_response_cache_settings\/entrypoint/);
    assertOrdered(readback, [
      '恰好出现一次',
      '`enabled` 严格等于 `true`',
      '逐字一致',
      '最大下标',
      '规则 Disabled'
    ], 'Cloudflare error-response readback');
    assert.match(readback, /enabled == true && action == "set_cache_control"/);
    assert.match(readback, /它之后没有 Enabled 的 `set_cache_control` 规则/,
      'readback must prove no later enabled cache-control modifier exists');
    assert.match(readback, /不得把写入请求的响应当作回读/);

    assert.match(trace, /POST \/accounts\/\$ACCOUNT_ID\/request-tracer\/trace/);
    assert.match(trace, /`skip_response` 必须为 `false`/);
    assert.match(trace, /"skip_response":false/);
    assert.match(trace, /result\.status_code >= 400/);
    assert.match(trace, /description == "Do not cache error responses"/);
    assert.match(trace, /matched == true/);
    assert.match(trace, /action == "set_cache_control"/);
    assert.match(trace, /action_parameters\.no-store\.operation == "set"/);
    assert.match(trace, /cloudflare_only == true/);
    assert.match(trace, /Inactive\/Disabled 规则不会进入 Trace/);
    assert.match(trace, /它之后出现任何 matched 的 `set_cache_control` 记录[^\n]*停止发布/);

    assert.match(publicVerification, /\/images\/<nonce>\.webp/);
    assert.match(publicVerification, /\/imagesx\/<nonce>\.webp/);
    assert.match(publicVerification, /\/<nonce>\.webp/);
    assert.match(publicVerification, /非目标 hostname/);
    assert.match(publicVerification, /不得出现[^\n]*CF-Cache-Status: HIT[^\n]*Age/);
    assert.match(publicVerification, /不能替代上面的控制面回读和 Trace/);
    assert.match(publicVerification, /purge/);
  }

  validateErrorCacheContract(deploy);

  const disabled = deploy.replace('- 状态：`enabled: true`', '- 状态：`enabled: false`');
  assert.notEqual(disabled, deploy, 'disabled-rule fixture must change the document');
  assert.throws(() => validateErrorCacheContract(disabled), /explicitly enabled/);

  const laterConflictAllowed = deploy.replace(
    '即它之后没有 Enabled 的 `set_cache_control` 规则',
    '但允许它之后存在 Enabled 的 `set_cache_control` 规则'
  );
  assert.notEqual(laterConflictAllowed, deploy, 'later-conflict fixture must change the document');
  assert.throws(() => validateErrorCacheContract(laterConflictAllowed), /no later enabled cache-control modifier/);

  const writeResponseAccepted = deploy.replace(
    '不得把写入请求的响应当作回读',
    '可以把写入请求的响应当作回读'
  );
  assert.notEqual(writeResponseAccepted, deploy, 'write-response fixture must change the document');
  assert.throws(() => validateErrorCacheContract(writeResponseAccepted), /写入请求的响应/);

  const skippedOrigin = deploy.replace('`skip_response` 必须为 `false`', '`skip_response` 必须为 `true`');
  assert.notEqual(skippedOrigin, deploy, 'Trace skip-response fixture must change the document');
  assert.throws(() => validateErrorCacheContract(skippedOrigin), /skip_response/);

  const unmatchedTrace = deploy.replace('`matched == true`', '`matched == false`');
  assert.notEqual(unmatchedTrace, deploy, 'unmatched Trace fixture must change the document');
  assert.throws(() => validateErrorCacheContract(unmatchedTrace), /matched == true/);
});

test('DEPLOY defines a later-priority image bypass and prefix purge for deterministic rollback', async () => {
  const deploy = await fs.readFile(path.join(projectRoot, 'DEPLOY.md'), 'utf8');
  const exactExpression = '(http.host eq "blog.cokedaily.space" and http.request.uri.path wildcard r"/images/*")';

  function extractRequiredSection(text, startMarker, endMarker, label) {
    const start = text.indexOf(startMarker);
    assert.notEqual(start, -1, `${label} start marker missing`);
    const end = text.indexOf(endMarker, start + startMarker.length);
    assert.notEqual(end, -1, `${label} end marker missing`);
    return text.slice(start, end);
  }

  function assertOrdered(text, markers, label) {
    let cursor = -1;
    for (const marker of markers) {
      const index = text.indexOf(marker, cursor + 1);
      assert.ok(index > cursor, `${label} marker missing or out of order: ${marker}`);
      cursor = index;
    }
  }

  function validateRollbackContract(text) {
    const rollback = extractRequiredSection(
      text,
      '#### Cloudflare 图片缓存确定性回滚',
      '\n---',
      'deterministic Cloudflare image rollback section'
    );
    const ruleContract = extractRequiredSection(
      rollback,
      '图片缓存必须保留两条范围完全相同、顺序固定的 Cache Rule：',
      '发布前必须在 Nginx 维护门仍开启时完成一次演练：',
      'Cloudflare rule contract'
    );
    const rehearsal = extractRequiredSection(
      rollback,
      '发布前必须在 Nginx 维护门仍开启时完成一次演练：',
      '正式开放顺序：',
      'Cloudflare rollback rehearsal'
    );
    const cutover = extractRequiredSection(
      rollback,
      '正式开放顺序：',
      '若开放后的任一门禁失败，按以下顺序回滚，不得调换：',
      'Cloudflare public cutover'
    );
    const failureRollback = extractRequiredSection(
      rollback,
      '若开放后的任一门禁失败，按以下顺序回滚，不得调换：',
      '正常稳定状态下',
      'Cloudflare failed-cutover rollback'
    );
    const steadyState = rollback.slice(rollback.indexOf('正常稳定状态下'));

    assert.match(ruleContract, /Cache blog images at Cloudflare edge/);
    assert.match(ruleContract, /Emergency bypass blog image cache/);
    assert.match(ruleContract, /Bypass cache[^\n]*CF-Cache-Status: DYNAMIC/);
    assert.match(ruleContract, /正常状态[^\n]*Disabled/);
    assert.match(ruleContract, /必须排在[^\n]*Cache blog images at Cloudflare edge[^\n]*之后/);
    const expressionMatch = /两条规则都只能匹配 `([^`\r\n]+)`。/.exec(ruleContract);
    assert.ok(expressionMatch, 'shared Cloudflare rule expression missing');
    assert.equal(expressionMatch[1], exactExpression, 'both rules must use only the exact host and /images/* expression');
    assert.doesNotMatch(ruleContract, /禁用 `Cache blog images at Cloudflare edge`/,
      'rollback must not disable the primary image cache rule');

    assertOrdered(rehearsal, [
      '确认 Bypass 规则 Disabled',
      '`MISS → HIT`',
      '启用 `Emergency bypass blog image cache`',
      '`enabled=true`',
      'purge `/images/*` 前缀',
      '`HIT → DYNAMIC → 503`',
      '保持 Bypass Enabled'
    ], 'rehearsal');
    assert.match(rehearsal, /"prefixes"\s*:\s*\[\s*"blog\.cokedaily\.space\/images"\s*\]/);

    assertOrdered(cutover, [
      '将 `Emergency bypass blog image cache` 设为 Disabled',
      '从 API 读回确认',
      '注释 Nginx 的 maintenance include',
      '`nginx -t`',
      'reload',
      '完整 post-open smoke'
    ], 'public cutover');

    assertOrdered(failureRollback, [
      '启用 `Emergency bypass blog image cache`',
      '读回确认',
      'purge `/images/*` 前缀',
      'Cloudflare API 返回成功',
      '启用 Nginx 维护门',
      '`nginx -t`',
      'reload',
      '确认 `/` 与现有图片均为 503',
      '`CF-Cache-Status: DYNAMIC`',
      '没有 `Age`'
    ], 'failed-cutover rollback');

    assert.match(steadyState, /主缓存规则保持 Enabled[^\n]*后置 Bypass 规则保持 Disabled/);
  }

  validateRollbackContract(deploy);

  const broadenedScope = deploy.replaceAll(exactExpression, '(http.host eq "blog.cokedaily.space")');
  assert.notEqual(broadenedScope, deploy, 'scope mutation fixture must change the document');
  assert.throws(() => validateRollbackContract(broadenedScope), /exact host and \/images\/\* expression/);

  const additivelyBroadenedScope = deploy.replaceAll(
    exactExpression,
    `${exactExpression} or http.host eq "admin.cokedaily.space"`
  );
  assert.notEqual(additivelyBroadenedScope, deploy, 'additive-scope mutation fixture must change the document');
  assert.throws(() => validateRollbackContract(additivelyBroadenedScope), /exact host and \/images\/\* expression/);

  const cutoverRemoved = deploy.replace(
    /正式开放顺序：[\s\S]*?(?=若开放后的任一门禁失败)/,
    '正式开放顺序：\n\n'
  );
  assert.notEqual(cutoverRemoved, deploy, 'cutover-removal fixture must change the document');
  assert.throws(() => validateRollbackContract(cutoverRemoved), /public cutover marker missing or out of order/);

  const unsafeRollbackOrder = deploy.replace(
    '1. 启用 `Emergency bypass blog image cache` 并读回确认。\n2. purge `/images/*` 前缀，并确认 Cloudflare API 返回成功。\n3. 启用 Nginx 维护门，执行 `nginx -t` 后 reload。',
    '1. 启用 Nginx 维护门，执行 `nginx -t` 后 reload。\n2. 启用 `Emergency bypass blog image cache` 并读回确认。\n3. purge `/images/*` 前缀，并确认 Cloudflare API 返回成功。'
  );
  assert.notEqual(unsafeRollbackOrder, deploy, 'rollback-order fixture must change the document');
  assert.throws(() => validateRollbackContract(unsafeRollbackOrder), /failed-cutover rollback marker missing or out of order/);
});

test('English translation release runbook pins candidate publication, fd-3 credentials, audits, and rollback boundaries', async t => {
  const [deploy, design] = await Promise.all([
    fs.readFile(path.join(projectRoot, 'DEPLOY.md'), 'utf8'),
    fs.readFile(
      path.join(projectRoot, 'docs/superpowers/specs/2026-08-04-english-article-translation-release-design.md'),
      'utf8'
    )
  ]);
  const stepMarkers = [
    '#### 生产步骤 1：启用 maintenance',
    '#### 生产步骤 2：停止 PM2',
    '#### 生产步骤 3：创建协调备份',
    '#### 生产步骤 4：更新代码并恢复 production-local ecosystem',
    '#### 生产步骤 5：执行 migrate-db',
    '#### 生产步骤 6：执行 taxonomy dry-run 与 apply',
    '#### 生产步骤 7：启动 PM2 candidate',
    '#### 生产步骤 8：通过 anonymous pipe 发布',
    '#### 生产步骤 9：执行 published 与 localized 两项 audit',
    '#### 生产步骤 10：重启最终 PM2 worker',
    '#### 生产步骤 11：执行 localhost smoke',
    '#### 生产步骤 12：清理 temporary bundle',
    '#### 生产步骤 13：关闭 maintenance',
    '#### 生产步骤 14：执行 public smoke'
  ];
  const exactLauncher = [
    "const fs = require('node:fs');",
    "const { execFileSync, spawn } = require('node:child_process');",
    "const jwt = require('jsonwebtoken');",
    '',
    "const pid = execFileSync('pm2', ['pid', 'blog'], { encoding: 'utf8' }).trim();",
    "if (!/^\\d+$/.test(pid)) throw new Error('blog PM2 process is not running');",
    "const entries = fs.readFileSync(`/proc/${pid}/environ`).toString('utf8').split('\\0');",
    'const env = Object.fromEntries(entries.filter(Boolean).map(entry => {',
    "  const split = entry.indexOf('=');",
    '  return [entry.slice(0, split), entry.slice(split + 1)];',
    '}));',
    "if (!env.JWT_SECRET) throw new Error('JWT_SECRET is unavailable');",
    'let token = jwt.sign(',
    "  { id: 0, username: 'release-operator' },",
    '  env.JWT_SECRET,',
    "  { algorithm: 'HS256', expiresIn: '5m' }",
    ');',
    'const child = spawn(process.execPath, [',
    "  'scripts/publish-translation-release.js',",
    "  '--release', 'content/releases/english-articles-2026-08-04.json',",
    "  '--bundle', '/root/blog-english-release-20260804/incoming',",
    "  '--base-url', 'http://127.0.0.1:3000',",
    "  '--token-fd', '3'",
    "], { stdio: ['ignore', 'inherit', 'inherit', 'pipe'] });",
    'child.stdio[3].end(token);',
    "token = '';",
    'child.once(\'exit\', code => process.exitCode = code ?? 1);'
  ].join('\n');

  function extractRequiredSection(text, startMarker, endMarker, label) {
    const start = text.indexOf(startMarker);
    assert.notEqual(start, -1, `${label} start marker missing`);
    const end = text.indexOf(endMarker, start + startMarker.length);
    assert.notEqual(end, -1, `${label} end marker missing`);
    return text.slice(start, end);
  }

  function assertOrdered(text, markers, label) {
    let cursor = -1;
    for (const marker of markers) {
      const index = text.indexOf(marker, cursor + 1);
      assert.ok(index > cursor, `${label} marker missing or out of order: ${marker}`);
      cursor = index;
    }
  }

  function swapOnce(text, left, right) {
    const sentinel = '__ENGLISH_RELEASE_CONTRACT_SWAP__';
    assert.equal(text.includes(sentinel), false, 'swap sentinel unexpectedly exists in document');
    const leftIndex = text.indexOf(left);
    const rightIndex = text.indexOf(right);
    assert.notEqual(leftIndex, -1, `left swap marker missing: ${left}`);
    assert.notEqual(rightIndex, -1, `right swap marker missing: ${right}`);
    return text.replace(left, sentinel).replace(right, left).replace(sentinel, right);
  }

  function validateEnglishReleaseContract(text) {
    const section = extractRequiredSection(
      text,
      '### 英文文章翻译发布',
      '\n## Google 登录评论配置',
      'English translation release runbook'
    );
    assertOrdered(section, stepMarkers, 'critical production sequence');

    const bashBlocks = Array.from(
      section.matchAll(/```bash[^\S\r\n]*\r?\n([\s\S]*?)\r?\n```/g),
      match => match[1]
    );
    assert.equal(bashBlocks.length, 3, 'expected candidate, production, and pre-open rollback Bash blocks');
    for (const [index, block] of bashBlocks.entries()) {
      const syntax = spawnSync('bash', ['-n'], { input: block, encoding: 'utf8' });
      assert.equal(syntax.status, 0, `English release Bash block ${index + 1} is invalid: ${syntax.stderr}`);
    }
    const productionBlocks = bashBlocks.filter(block => block.includes('# english-translation-release-runbook'));
    assert.equal(productionBlocks.length, 1, 'expected one canonical executable production runbook block');

    assert.ok(
      section.includes(`node <<'NODE'\n${exactLauncher}\nNODE`),
      'exact five-minute HS256 fd-3 launcher missing'
    );
    assert.ok(
      section.includes('下面的 here-doc 必须保持单引号定界（`<<\'NODE\'`）；launcher 本身只从 shell 标准输入交给 Node，绝不保存到磁盘。'),
      'single-quoted in-memory launcher contract missing'
    );
    assert.ok(
      section.includes('发布 token 的值禁止出现在命令行参数、环境变量、文件、shell history、stdout/stderr 或任何应用、PM2、Nginx 日志中。'),
      'credential non-persistence contract missing'
    );
    assert.ok(
      section.includes('禁止直接 SQL INSERT、UPDATE 或逐篇 DELETE；四篇文章只能由受保护的 loopback publisher 顺序写入。'),
      'direct-SQL publication prohibition missing'
    );
    assert.doesNotMatch(section, /--token(?:[ =]|$)/, 'a bearer token argument must never be documented');
    assert.doesNotMatch(section, /(?:export\s+)?(?:JWT_)?TOKEN=/, 'a bearer token environment variable must never be documented');

    assert.match(section, /cp --archive -- ecosystem\.config\.js "\$BACKUP_DIR\/ecosystem\.config\.js"/);
    assert.match(section, /cmp -s -- "\$BACKUP_DIR\/ecosystem\.config\.js" ecosystem\.config\.js/);
    assert.ok(
      section.includes('生产本地 `/root/Blog/ecosystem.config.js` 必须在代码更新前用 `cp --archive` 快照，并在代码更新后与开放前回滚时逐字节、权限、owner/group 和 mtime 原样恢复；不得用仓库版本重建。'),
      'production-local ecosystem preservation contract missing'
    );

    const preOpenRollback = extractRequiredSection(
      section,
      '##### 开放前 rollback',
      '##### 开放后 forward-fix/reconciliation',
      'pre-open rollback contract'
    );
    const postOpenRecovery = section.slice(section.indexOf('##### 开放后 forward-fix/reconciliation'));
    assert.ok(
      preOpenRollback.includes('如果 publisher 在第 2、3 或 4 篇发生部分发布失败，必须在 maintenance 仍启用时恢复整个协调备份集'),
      'whole coordinated backup restoration after partial publication missing'
    );
    assert.match(preOpenRollback, /禁止逐篇删除或只恢复其中一个组件/);
    assertOrdered(preOpenRollback, [
      'pm2 stop blog',
      'sha256sum -c SHA256SUMS',
      'mv -- articles "$FAILED_STATE_DIR/articles"',
      'mv -- var/operations "$FAILED_STATE_DIR/operations"',
      'git reset --hard "$PRE_RELEASE_COMMIT"',
      'cp --archive -- "$BACKUP_DIR/blog.db" blog.db',
      'tar --extract --preserve-permissions --file "$BACKUP_DIR/content-state.tar"',
      'cp --archive --remove-destination -- "$BACKUP_DIR/ecosystem.config.js" ecosystem.config.js',
      'pm2 start ecosystem.config.js --only blog --update-env'
    ], 'whole coordinated pre-open restore');
    assert.match(
      postOpenRecovery,
      /maintenance 一旦关闭（包括 public smoke 开始前后的整个 post-open 阶段），绝不能恢复发布前协调备份集；[\s\S]*优先前向修复（forward-fix）与逐项对账（reconciliation）/,
      'post-open recovery must require forward-fix and reconciliation instead of a pre-release restore'
    );
    assert.ok(
      section.includes('本次发布不改变图片文件，HTML 仍为 `private, no-store`；不得 purge 未变化的 HTML 或 `/images/*`，也不得修改现有 Cache Rule。'),
      'unchanged HTML/image no-purge contract missing'
    );
    return section;
  }

  validateEnglishReleaseContract(deploy);
  assertOrdered(design, [
    '在维护门保持启用时启动 PM2 候选进程',
    '通过 loopback 管理发布接口依次导入 4 篇英文文章',
    '运行数据库迁移、taxonomy/content audit',
    '随后重启最终 PM2 worker'
  ], 'approved design PM2 publication sequence');

  const reordered = swapOnce(deploy, stepMarkers[5], stepMarkers[6]);
  assert.throws(() => validateEnglishReleaseContract(reordered), /critical production sequence/);

  for (const [label, from, to] of [
    ['HS256', "algorithm: 'HS256'", "algorithm: 'HS384'"],
    [
      'five-minute expiry',
      "{ algorithm: 'HS256', expiresIn: '5m' }",
      "{ algorithm: 'HS256', expiresIn: '15m' }"
    ],
    ['fd 3', "'--token-fd', '3'", "'--token-fd', '4'"]
  ]) {
    const mutated = deploy.replace(from, to);
    assert.notEqual(mutated, deploy, `${label} mutation fixture must change the document`);
    assert.throws(() => validateEnglishReleaseContract(mutated), /five-minute HS256 fd-3 launcher/);
  }

  const partialRestoreWeakened = deploy.replace(
    '恢复整个协调备份集',
    '只删除已经发布的英文文章'
  );
  assert.notEqual(partialRestoreWeakened, deploy, 'partial-publication rollback mutation must change the document');
  assert.throws(() => validateEnglishReleaseContract(partialRestoreWeakened), /whole coordinated backup/);

  const ecosystemRegenerated = deploy.replace(
    '逐字节、权限、owner/group 和 mtime 原样恢复；不得用仓库版本重建',
    '按仓库模板重新生成'
  );
  assert.notEqual(ecosystemRegenerated, deploy, 'ecosystem mutation fixture must change the document');
  assert.throws(() => validateEnglishReleaseContract(ecosystemRegenerated), /production-local ecosystem/);

  const postOpenRestoreAllowed = deploy.replace(
    '绝不能恢复发布前协调备份集',
    '可以直接恢复发布前协调备份集'
  );
  assert.notEqual(postOpenRestoreAllowed, deploy, 'post-open rollback mutation must change the document');
  assert.throws(() => validateEnglishReleaseContract(postOpenRestoreAllowed), /post-open recovery/);

  t.diagnostic('killed critical-order, HS256, five-minute, fd-3, whole-backup, ecosystem, and post-open rollback mutations');
});

test('Nginx caches static assets only by explicit prefixes and gates public traffic during maintenance', async () => {
  const [nginx, maintenance, deploy] = await Promise.all([
    fs.readFile(path.join(projectRoot, 'deploy/nginx/blog.conf'), 'utf8'),
    fs.readFile(path.join(projectRoot, 'deploy/nginx/blog-maintenance.conf'), 'utf8'),
    fs.readFile(path.join(projectRoot, 'DEPLOY.md'), 'utf8')
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
  assert.match(nginx, /map\s+\$upstream_status\s+\$blog_image_expires\s*\{[\s\S]*~\^\(200\|206\|304\)\$\s+30d;[\s\S]*default\s+off;[\s\S]*\}/,
    'image Expires map must enable 30 days only for successful/cache-validation responses');
  assert.match(nginx, /map\s+\$upstream_status\s+\$blog_image_cache_control\s*\{[\s\S]*~\^\(200\|206\|304\)\$\s+"public, immutable";[\s\S]*default\s+"private, no-store";[\s\S]*\}/,
    'image Cache-Control map must make every non-success response private and no-store');
  assert.match(imagesBlock, /expires\s+\$blog_image_expires;/,
    'images must select Expires by upstream status');
  assert.match(imagesBlock, /add_header\s+Cache-Control\s+\$blog_image_cache_control\s+always;/,
    'images must emit success caching or error no-store on every status');

  const troubleshootingStart = deploy.indexOf('#### Nginx `/images/*` 返回 403');
  const troubleshootingEnd = deploy.indexOf('### 问题 4: Nginx 502 Bad Gateway', troubleshootingStart);
  assert.notEqual(troubleshootingStart, -1, 'image 403 troubleshooting section missing');
  assert.notEqual(troubleshootingEnd, -1, 'image 403 troubleshooting section must end before problem 4');
  const imageTroubleshooting = deploy.slice(troubleshootingStart, troubleshootingEnd);
  assert.match(imageTroubleshooting,
    /状态映射的 `add_header Cache-Control \$blog_image_cache_control always;` 必须保留 `always`/,
    'troubleshooting must preserve always for the status-dependent cache header');
  assert.match(imageTroubleshooting,
    /禁止的是固定成功值 `add_header Cache-Control "public, immutable" always;`/,
    'troubleshooting must distinguish the unsafe constant-success always pattern');
  assert.doesNotMatch(imageTroubleshooting, /缓存头也不得使用 `always`/,
    'troubleshooting must not repeat the obsolete no-always guidance');

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

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

#!/usr/bin/env bash
set -Eeuo pipefail

PRODUCTION_PROJECT_ROOT='/root/Blog'
PRODUCTION_GEOIP_DIR='/var/lib/blog/geoip'
PRODUCTION_RUNTIME_DIR='/run/blog-geoip-update'
PRODUCTION_CONFIG='/etc/GeoIP.conf'

TEST_MODE=false
if [[ -n "${BLOG_GEOIP_UPDATE_TEST_ROOT:-}" ]]; then
  if [[ "${NODE_ENV:-}" != 'test' ]]; then
    printf '%s\n' '[geoip-update] test_root_requires_NODE_ENV_test' >&2
    exit 64
  fi
  TEST_MODE=true
  TEST_ROOT="${BLOG_GEOIP_UPDATE_TEST_ROOT%/}"
  PROJECT_ROOT="${BLOG_GEOIP_UPDATE_TEST_PROJECT_ROOT:-$TEST_ROOT/root/Blog}"
  GEOIP_DIR="$TEST_ROOT/var/lib/blog/geoip"
  RUNTIME_DIR="$TEST_ROOT/run/blog-geoip-update"
  GEOIP_CONFIG="${BLOG_GEOIP_UPDATE_TEST_CONFIG:-$TEST_ROOT/etc/GeoIP.conf}"
  GEOIPUPDATE_BIN="${BLOG_GEOIP_UPDATE_TEST_BIN:-geoipupdate}"
  NODE_BIN="${BLOG_GEOIP_UPDATE_TEST_NODE_BIN:-node}"
  VERIFY_SCRIPT="${BLOG_GEOIP_UPDATE_TEST_VERIFY_SCRIPT:-$PROJECT_ROOT/scripts/verify-geoip-db.js}"
else
  PROJECT_ROOT="$PRODUCTION_PROJECT_ROOT"
  GEOIP_DIR="$PRODUCTION_GEOIP_DIR"
  RUNTIME_DIR="$PRODUCTION_RUNTIME_DIR"
  GEOIP_CONFIG="$PRODUCTION_CONFIG"
  GEOIPUPDATE_BIN='geoipupdate'
  NODE_BIN='node'
  VERIFY_SCRIPT="$PROJECT_ROOT/scripts/verify-geoip-db.js"
fi

LIVE="$GEOIP_DIR/GeoLite2-City.mmdb"
PREVIOUS="$GEOIP_DIR/GeoLite2-City.mmdb.previous"
STAGING_ROOT="$GEOIP_DIR/staging"
STATUS="$GEOIP_DIR/update-status.json"
LOCK="$RUNTIME_DIR/update.lock"
ATTEMPT_AT="$($NODE_BIN -e "process.stdout.write(new Date().toISOString())")"
STATUS_WRITTEN=0
ERROR_CATEGORY='unexpected_error'
STAGING_DIR=''
TEMP_FILE=''
DATASET_EPOCH=''
BOOTSTRAP_INSTALLED=0

mkdir -p -- "$GEOIP_DIR" "$STAGING_ROOT" "$RUNTIME_DIR"
chmod 0755 "$GEOIP_DIR" "$STAGING_ROOT" "$RUNTIME_DIR"
if [[ "$TEST_MODE" == false ]]; then
  chown root:root "$GEOIP_DIR" "$STAGING_ROOT" "$RUNTIME_DIR"
fi

exec 9>"$LOCK"
if ! flock --nonblock 9; then
  printf '%s\n' '[geoip-update] already_running' >&2
  exit 75
fi

write_status() {
  local result="$1"
  local error_category="$2"
  local dataset_epoch="${3:-}"
  "$NODE_BIN" - "$STATUS" "$ATTEMPT_AT" "$result" "$error_category" "$dataset_epoch" <<'NODE'
const fs = require('node:fs');
const path = require('node:path');
const [statusPath, attemptAt, result, errorCategory, epochText] = process.argv.slice(2);
let previous = {};
try {
  const stat = fs.lstatSync(statusPath);
  if (stat.isFile() && !stat.isSymbolicLink() && stat.size <= 4096) {
    previous = JSON.parse(fs.readFileSync(statusPath, 'utf8'));
  }
} catch {}
const successful = result !== 'failed';
const parsedEpoch = /^\d+$/.test(epochText) ? Number(epochText) : null;
const status = {
  lastAttemptAt: attemptAt,
  lastSuccessAt: successful ? attemptAt : (previous.lastSuccessAt ?? null),
  result,
  errorCategory: errorCategory || null,
  datasetEpoch: parsedEpoch || (successful ? null : (previous.datasetEpoch ?? null))
};
const directory = path.dirname(statusPath);
const temporary = path.join(directory, `.update-status.${process.pid}.${Date.now()}.tmp`);
let descriptor;
try {
  descriptor = fs.openSync(temporary, 'wx', 0o644);
  fs.writeFileSync(descriptor, `${JSON.stringify(status)}\n`, 'utf8');
  fs.fsyncSync(descriptor);
  fs.closeSync(descriptor);
  descriptor = undefined;
  fs.renameSync(temporary, statusPath);
  fs.chmodSync(statusPath, 0o644);
  const directoryDescriptor = fs.openSync(directory, 'r');
  try { fs.fsyncSync(directoryDescriptor); } finally { fs.closeSync(directoryDescriptor); }
} finally {
  if (descriptor !== undefined) fs.closeSync(descriptor);
  try { fs.unlinkSync(temporary); } catch {}
}
NODE
  if [[ "$TEST_MODE" == false ]]; then chown root:root "$STATUS"; fi
  STATUS_WRITTEN=1
}

fsync_path() {
  "$NODE_BIN" -e "const fs=require('node:fs');const fd=fs.openSync(process.argv[1],'r');try{fs.fsyncSync(fd)}finally{fs.closeSync(fd)}" "$1"
}

secure_file() {
  chmod 0644 "$1"
  if [[ "$TEST_MODE" == false ]]; then chown root:root "$1"; fi
}

verify_file() {
  local file="$1"
  local output
  output="$($NODE_BIN "$VERIFY_SCRIPT" "$file")" || return 1
  "$NODE_BIN" -e '
const value=JSON.parse(process.argv[1]);
if(!/^[a-f0-9]{64}$/.test(value.sha256)||!Number.isInteger(value.datasetEpoch)||value.datasetEpoch<=0)process.exit(65);
process.stdout.write(`${value.sha256} ${value.datasetEpoch}\n`);
' "$output"
}

finish_error() {
  local exit_code=$?
  trap - EXIT
  if [[ -n "$STAGING_DIR" && -d "$STAGING_DIR" ]]; then rm -rf -- "$STAGING_DIR"; fi
  if [[ -n "$TEMP_FILE" && -f "$TEMP_FILE" ]]; then rm -f -- "$TEMP_FILE"; fi
  if [[ $exit_code -ne 0 && $BOOTSTRAP_INSTALLED -eq 1 ]]; then
    rm -f -- "$LIVE"
    fsync_path "$GEOIP_DIR" || true
  fi
  if [[ $exit_code -ne 0 && $STATUS_WRITTEN -eq 0 ]]; then
    write_status 'failed' "$ERROR_CATEGORY" "$DATASET_EPOCH" || true
  fi
  exit "$exit_code"
}
trap finish_error EXIT

fail() {
  ERROR_CATEGORY="$1"
  return "${2:-1}"
}

inject_test_failure() {
  local stage="$1"
  if [[ "$TEST_MODE" == true && "${BLOG_GEOIP_UPDATE_TEST_FAIL_STAGE:-}" == "$stage" ]]; then
    fail "${stage//-/_}_failed"
  fi
}

if [[ ! -r "$GEOIP_CONFIG" ]]; then fail 'config_unreadable'; fi
if [[ ! -r "$VERIFY_SCRIPT" ]]; then fail 'verifier_unreadable'; fi
if [[ "$TEST_MODE" == false ]]; then
  if [[ ! -f "$GEOIP_CONFIG" || -L "$GEOIP_CONFIG" ]]; then fail 'config_invalid'; fi
  config_metadata="$(stat -c '%u:%g %a' "$GEOIP_CONFIG")"
  if [[ "$config_metadata" != '0:0 600' ]]; then fail 'config_permissions'; fi
  if [[ ! -f "$0" || -L "$0" ]]; then fail 'wrapper_invalid'; fi
  wrapper_metadata="$(stat -c '%u:%g %a' "$0")"
  if [[ "$wrapper_metadata" != '0:0 755' ]]; then fail 'wrapper_permissions'; fi
fi

if [[ "${1:-}" == '--rollback' ]]; then
  if [[ $# -ne 1 ]]; then fail 'invalid_arguments' 64; fi
  if [[ ! -f "$PREVIOUS" || -L "$PREVIOUS" ]]; then fail 'previous_missing'; fi
  read -r _ DATASET_EPOCH < <(verify_file "$PREVIOUS") || fail 'previous_verification_failed'
  TEMP_FILE="$(mktemp "$GEOIP_DIR/.rollback.XXXXXXXX.tmp")"
  cat -- "$PREVIOUS" > "$TEMP_FILE"
  secure_file "$TEMP_FILE"
  fsync_path "$TEMP_FILE"
  mv -fT -- "$TEMP_FILE" "$LIVE"
  TEMP_FILE=''
  secure_file "$LIVE"
  fsync_path "$GEOIP_DIR"
  write_status 'updated' '' "$DATASET_EPOCH"
  printf '%s\n' '[geoip-update] rollback_complete'
  exit 0
fi
if [[ $# -ne 0 ]]; then fail 'invalid_arguments' 64; fi

STAGING_DIR="$(mktemp -d "$STAGING_ROOT/run-XXXXXXXX")"
chmod 0700 "$STAGING_DIR"
if ! "$GEOIPUPDATE_BIN" -f "$GEOIP_CONFIG" -d "$STAGING_DIR"; then fail 'download_failed'; fi

mapfile -d '' candidates < <(find "$STAGING_DIR" -maxdepth 2 -type f -name 'GeoLite2-City.mmdb' -print0)
if [[ ${#candidates[@]} -ne 1 ]]; then fail 'candidate_missing_or_ambiguous'; fi
CANDIDATE="${candidates[0]}"
read -r candidate_sha DATASET_EPOCH < <(verify_file "$CANDIDATE") || fail 'candidate_verification_failed'

if [[ ! -e "$LIVE" ]]; then
  secure_file "$CANDIDATE"
  fsync_path "$CANDIDATE"
  mv -fT -- "$CANDIDATE" "$LIVE"
  BOOTSTRAP_INSTALLED=1
  secure_file "$LIVE"
  fsync_path "$GEOIP_DIR"
  inject_test_failure 'bootstrap-after-promote'
  write_status 'bootstrap' '' "$DATASET_EPOCH"
  BOOTSTRAP_INSTALLED=0
  printf '%s\n' '[geoip-update] bootstrap_complete'
  exit 0
fi

if [[ ! -f "$LIVE" || -L "$LIVE" ]]; then fail 'live_invalid'; fi
read -r live_sha live_epoch < <(verify_file "$LIVE") || fail 'live_verification_failed'
if [[ "$candidate_sha" == "$live_sha" && "$DATASET_EPOCH" == "$live_epoch" ]]; then
  write_status 'no-op' '' "$DATASET_EPOCH"
  printf '%s\n' '[geoip-update] no_change'
  exit 0
fi

TEMP_FILE="$(mktemp "$GEOIP_DIR/.previous.XXXXXXXX.tmp")"
cat -- "$LIVE" > "$TEMP_FILE"
secure_file "$TEMP_FILE"
fsync_path "$TEMP_FILE"
inject_test_failure 'prepare-previous'
mv -fT -- "$TEMP_FILE" "$PREVIOUS"
TEMP_FILE=''
secure_file "$PREVIOUS"
fsync_path "$GEOIP_DIR"

secure_file "$CANDIDATE"
fsync_path "$CANDIDATE"
inject_test_failure 'promote-live'
mv -fT -- "$CANDIDATE" "$LIVE"
secure_file "$LIVE"
fsync_path "$GEOIP_DIR"
write_status 'updated' '' "$DATASET_EPOCH"
printf '%s\n' '[geoip-update] update_complete'

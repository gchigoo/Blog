const crypto = require('node:crypto');
const fs = require('node:fs/promises');

const FIXED_LOOKUP_IP = '1.1.1.1';
const MAX_DATABASE_BYTES = 512 * 1024 * 1024;

function readerMetadata(reader) {
  return reader.metadata || reader.mmdbReader?.metadata || null;
}

function datasetEpochFromMetadata(metadata) {
  const buildDate = metadata?.buildEpoch instanceof Date
    ? metadata.buildEpoch
    : new Date(Number(metadata?.buildEpoch) * 1000);
  if (!Number.isFinite(buildDate.getTime()) || buildDate.getTime() <= 0) {
    throw new Error('invalid_build_epoch');
  }
  return Math.floor(buildDate.getTime() / 1000);
}

async function verifyGeoIpDatabase(databasePath, { openBuffer } = {}) {
  const stat = await fs.lstat(databasePath);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size <= 0 || stat.size > MAX_DATABASE_BYTES) {
    throw new Error('invalid_database_file');
  }

  const buffer = await fs.readFile(databasePath);
  const readerFactory = openBuffer || (async value => {
    const { Reader } = await import('@maxmind/geoip2-node');
    return Reader.openBuffer(value);
  });
  const reader = await readerFactory(buffer);
  const metadata = readerMetadata(reader);
  if (!metadata || !String(metadata.databaseType).includes('City')) {
    throw new Error('not_city_database');
  }

  const datasetEpoch = datasetEpochFromMetadata(metadata);
  const fixture = reader.city(FIXED_LOOKUP_IP);
  if (!fixture || typeof fixture !== 'object') throw new Error('fixed_lookup_failed');

  return {
    sha256: crypto.createHash('sha256').update(buffer).digest('hex'),
    datasetEpoch
  };
}

function errorCategory(error) {
  const known = new Set([
    'invalid_database_file',
    'invalid_build_epoch',
    'not_city_database',
    'fixed_lookup_failed'
  ]);
  return known.has(error?.message) ? error.message : 'database_open_failed';
}

async function main() {
  if (process.argv.length !== 3) {
    process.stderr.write('geoip_verification_failed:invalid_arguments\n');
    process.exitCode = 64;
    return;
  }
  try {
    const result = await verifyGeoIpDatabase(process.argv[2]);
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    process.stderr.write(`geoip_verification_failed:${errorCategory(error)}\n`);
    process.exitCode = 65;
  }
}

if (require.main === module) main();

module.exports = { verifyGeoIpDatabase };

const { createHash } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const manifest = require('./baseline-manifest.json');

const visualRoot = __dirname;
const snapshotsRoot = path.join(visualRoot, '__snapshots__');

function sha256(filePath) {
  return createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function collectBaselineFiles(directory, result = []) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) collectBaselineFiles(entryPath, result);
    if (entry.isFile() && (entry.name.endsWith('.html')
      || entry.name.endsWith('.png')
      || entry.name.endsWith('-layout.json'))) {
      result.push(path.relative(visualRoot, entryPath).replaceAll('\\', '/'));
    }
  }
  return result;
}

if (manifest.baselineEngine !== 'ejs@6.0.1') {
  throw new Error(`Unexpected baseline engine: ${manifest.baselineEngine}`);
}
if (manifest.htmlSnapshotCount !== 18
  || manifest.layoutSnapshotCount !== 108
  || manifest.imageSnapshotCount !== 108) {
  throw new Error('Baseline manifest counts do not match the approved matrix.');
}

for (const [relativePath, expectedHash] of Object.entries(manifest.files)) {
  const filePath = path.join(visualRoot, relativePath);
  if (!fs.existsSync(filePath)) throw new Error(`Missing baseline: ${relativePath}`);
  const actualHash = sha256(filePath);
  if (actualHash !== expectedHash) {
    throw new Error(`Baseline changed: ${relativePath}`);
  }
}

const expectedTotal = 18 + 108 + 108;
if (Object.keys(manifest.files).length !== expectedTotal) {
  throw new Error(`Expected ${expectedTotal} immutable baseline files.`);
}

const expectedPaths = Object.keys(manifest.files).sort();
const actualPaths = collectBaselineFiles(snapshotsRoot).sort();
if (JSON.stringify(actualPaths) !== JSON.stringify(expectedPaths)) {
  throw new Error('Baseline file set changed without an approved manifest update.');
}

console.log(`Verified ${expectedTotal} immutable EJS 6.0.1 baseline files.`);

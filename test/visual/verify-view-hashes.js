const { createHash } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..', '..');
const expected = require('./view-style-manifest.json');
const assets = require('./assets/asset-manifest.json');
const assetsDir = path.join(__dirname, 'assets');

function sha256(filePath) {
  return createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function collectEjs(directory, result = []) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) collectEjs(entryPath, result);
    if (entry.isFile() && entry.name.endsWith('.ejs')) result.push(entryPath);
  }
  return result;
}

const actualPaths = [
  path.join(root, 'public', 'css', 'custom.css'),
  ...collectEjs(path.join(root, 'views'))
].map(filePath => path.relative(root, filePath).replaceAll('\\', '/')).sort();
const expectedPaths = Object.keys(expected).sort();

if (JSON.stringify(actualPaths) !== JSON.stringify(expectedPaths)) {
  throw new Error(`View/style file set changed. Expected ${expectedPaths.length}, got ${actualPaths.length}.`);
}

for (const [relativePath, expectedHash] of Object.entries(expected)) {
  const actualHash = sha256(path.join(root, relativePath));
  if (actualHash !== expectedHash) {
    throw new Error(`${relativePath} changed: expected ${expectedHash}, got ${actualHash}`);
  }
}

for (const [fileName, expectedHash] of Object.entries(assets)) {
  const actualHash = sha256(path.join(assetsDir, fileName));
  if (actualHash !== expectedHash) {
    throw new Error(`Pinned asset ${fileName} changed: expected ${expectedHash}, got ${actualHash}`);
  }
}

const actualAssetPaths = fs.readdirSync(assetsDir)
  .filter(fileName => fileName.endsWith('.css') || fileName.endsWith('.woff2'))
  .sort();
const expectedAssetPaths = Object.keys(assets).sort();
if (JSON.stringify(actualAssetPaths) !== JSON.stringify(expectedAssetPaths)) {
  throw new Error('Pinned CSS/font asset set changed without updating asset-manifest.json.');
}

console.log(`Verified ${expectedPaths.length} frozen view/style files and ${Object.keys(assets).length} pinned assets.`);

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '..');

test('project declares the Node 24 runtime and built-in test runner', () => {
  const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const nvmrc = fs.readFileSync(path.join(root, '.nvmrc'), 'utf8').trim();

  assert.equal(packageJson.engines.node, '>=24 <25');
  assert.equal(packageJson.scripts.test, 'node --test test/*.test.js');
  assert.equal(nvmrc, '24');
  assert.equal(Number(process.versions.node.split('.')[0]), 24);
});

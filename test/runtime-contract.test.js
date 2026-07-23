const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const test = require('node:test');

const { validateRuntimePaths } = require('../server/utils/runtime-paths');

const root = path.resolve(__dirname, '..');

test('project declares the Node 24 runtime and built-in test runner', () => {
  const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const nvmrc = fs.readFileSync(path.join(root, '.nvmrc'), 'utf8').trim();

  assert.equal(packageJson.engines.node, '>=24 <25');
  assert.equal(packageJson.scripts.test, 'node --test test/*.test.js');
  assert.equal(nvmrc, '24');
  assert.equal(Number(process.versions.node.split('.')[0]), 24);
});

test('runtime path validation creates writable data directories and requires About content', t => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'blog-runtime-paths-'));
  t.after(() => fs.rmSync(fixture, { recursive: true, force: true }));
  fs.mkdirSync(path.join(fixture, 'content'));
  fs.writeFileSync(path.join(fixture, 'content/about.md'), '# About');
  const config = {
    uploadDir: 'uploads/temp', imagesDir: 'public/images', audioDir: 'public/audio',
    articlesDir: 'articles', aboutPath: 'content/about.md'
  };
  assert.equal(validateRuntimePaths(config, fixture), true);
  for (const directory of ['uploads/temp', 'public/images', 'public/audio', 'articles']) {
    assert.equal(fs.statSync(path.join(fixture, directory)).isDirectory(), true);
  }
  fs.rmSync(path.join(fixture, 'content/about.md'));
  assert.throws(() => validateRuntimePaths(config, fixture), /ENOENT/);
});

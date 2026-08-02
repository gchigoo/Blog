const fs = require('node:fs');
const path = require('node:path');

/**
 * Validate every data directory the server needs at startup.
 *
 * Writable directories are created recursively and then read/write checked:
 * uploads, images, the base audio/articles roots, the locale-scoped
 * `articles/zh|en` and `public/audio/zh|en` trees, and the durable
 * `var/operations` journal registry. The operations registry must live on the
 * same persistent volume as the database and content (both anchored at `cwd`),
 * so a tmpfs or secondary-mount override is rejected instead of silently
 * stranding recovery journals.
 *
 * Readable content is required before serving: both localized About files and
 * the taxonomy catalog. Image/upload roots stay unchanged.
 */
function validateRuntimePaths(config, cwd = process.cwd()) {
  const writableDirectories = [
    config.uploadDir,
    config.imagesDir,
    config.audioDir,
    config.articlesDir,
    path.join(config.articlesDir, 'zh'),
    path.join(config.articlesDir, 'en'),
    path.join(config.audioDir, 'zh'),
    path.join(config.audioDir, 'en'),
    config.operationsDir
  ];
  for (const directory of writableDirectories) {
    const resolved = path.resolve(cwd, directory);
    fs.mkdirSync(resolved, { recursive: true });
    fs.accessSync(resolved, fs.constants.R_OK | fs.constants.W_OK);
  }

  const operationsStat = fs.statSync(path.resolve(cwd, config.operationsDir));
  const projectStat = fs.statSync(path.resolve(cwd));
  if (operationsStat.dev !== projectStat.dev) {
    throw new Error('operations directory must be on the same persistent volume as the database and content');
  }

  for (const relativePath of [config.aboutPaths.zh, config.aboutPaths.en, config.taxonomyPath]) {
    fs.accessSync(path.resolve(cwd, relativePath), fs.constants.R_OK);
  }
  return true;
}

module.exports = { validateRuntimePaths };

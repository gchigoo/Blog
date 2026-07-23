const fs = require('node:fs');
const path = require('node:path');

function validateRuntimePaths(config, cwd = process.cwd()) {
  const writableDirectories = [
    config.uploadDir,
    config.imagesDir,
    config.audioDir,
    config.articlesDir
  ];
  for (const directory of writableDirectories) {
    const resolved = path.resolve(cwd, directory);
    fs.mkdirSync(resolved, { recursive: true });
    fs.accessSync(resolved, fs.constants.R_OK | fs.constants.W_OK);
  }
  const aboutPath = path.resolve(cwd, config.aboutPath);
  fs.accessSync(aboutPath, fs.constants.R_OK);
  return true;
}

module.exports = { validateRuntimePaths };

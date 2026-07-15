const path = require('path');

const SAFE_SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function isSafeSlug(slug) {
  return typeof slug === 'string' && SAFE_SLUG_PATTERN.test(slug);
}

function resolveOwnedPath(root, relativePath) {
  if (typeof relativePath !== 'string' || relativePath.length === 0) {
    throw new Error('路径不能为空');
  }

  const resolvedRoot = path.resolve(root);
  const resolvedPath = path.resolve(resolvedRoot, relativePath);
  if (!resolvedPath.startsWith(`${resolvedRoot}${path.sep}`)) {
    throw new Error('路径不属于指定根目录');
  }

  return resolvedPath;
}

function isSafeZipEntryName(entryName) {
  if (typeof entryName !== 'string' || entryName.length === 0) return false;
  if (entryName.includes('\\') || entryName.includes('\0')) return false;
  if (path.posix.isAbsolute(entryName) || path.win32.isAbsolute(entryName)) return false;
  return !entryName.split('/').includes('..');
}

function resolveZipEntryPath(root, entryName) {
  if (!isSafeZipEntryName(entryName)) {
    throw new Error('ZIP 包含不安全路径');
  }
  return resolveOwnedPath(root, entryName);
}

function resolveArticlePath(root, slug) {
  if (!isSafeSlug(slug)) {
    throw new Error('slug 格式不安全');
  }
  return resolveOwnedPath(root, `${slug}.md`);
}

module.exports = {
  SAFE_SLUG_PATTERN,
  isSafeSlug,
  isSafeZipEntryName,
  resolveArticlePath,
  resolveOwnedPath,
  resolveZipEntryPath
};

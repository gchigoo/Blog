#!/usr/bin/env node
'use strict';

const { createHash } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const {
  loadReleaseManifest,
  loadShaManifest
} = require('./audit-translation-release');

const EXPECTED_ARTICLE_COUNT = 4;
const MAX_TOKEN_BYTES = 16 * 1024;

function validateLoopbackBaseUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error('base URL must be loopback HTTP');
  }
  const hostname = url.hostname === '[::1]' ? '::1' : url.hostname;
  if (url.protocol !== 'http:' || !['127.0.0.1', '::1'].includes(hostname)) {
    throw new Error('base URL must be loopback HTTP');
  }
  return url.origin;
}

function parseArguments(argv) {
  if (!Array.isArray(argv)) throw new TypeError('arguments must be an array');
  const allowed = new Set(['--release', '--bundle', '--base-url', '--token-fd']);
  const values = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (!allowed.has(flag)) throw new TypeError(`unknown flag: ${flag || '(missing)'}`);
    if (values.has(flag)) throw new TypeError(`duplicate flag: ${flag}`);
    const value = argv[index + 1];
    if (value === undefined || value === '' || value.startsWith('--')) {
      throw new TypeError(`missing value for ${flag}`);
    }
    values.set(flag, value);
    index += 1;
  }

  for (const flag of allowed) {
    if (!values.has(flag)) throw new TypeError(`${flag} is required`);
  }
  const descriptor = values.get('--token-fd');
  if (!/^(?:0|[1-9]\d*)$/.test(descriptor)) {
    throw new TypeError('--token-fd must be a non-negative integer');
  }
  const tokenFd = Number(descriptor);
  if (!Number.isSafeInteger(tokenFd)) {
    throw new TypeError('--token-fd must be a non-negative integer');
  }

  return {
    releasePath: path.resolve(values.get('--release')),
    bundleDir: path.resolve(values.get('--bundle')),
    baseUrl: values.get('--base-url'),
    tokenFd
  };
}

function readTokenFromFd(fd) {
  if (!Number.isSafeInteger(fd) || fd < 0) {
    throw new TypeError('token descriptor must be a non-negative integer');
  }
  const bytes = Buffer.allocUnsafe(MAX_TOKEN_BYTES + 1);
  let length = 0;
  while (length < bytes.length) {
    const count = fs.readSync(fd, bytes, length, bytes.length - length, null);
    if (count === 0) break;
    length += count;
  }
  if (length > MAX_TOKEN_BYTES) {
    throw new Error('bearer token exceeds 16 KiB');
  }
  const token = bytes.subarray(0, length).toString('utf8').trim();
  if (token === '') throw new Error('bearer token is empty');
  return token;
}

function normalizeBearerToken(value) {
  if (typeof value !== 'string') throw new Error('bearer token is missing');
  if (Buffer.byteLength(value) > MAX_TOKEN_BYTES) {
    throw new Error('bearer token exceeds 16 KiB');
  }
  const token = value.trim();
  if (token === '') throw new Error('bearer token is empty');
  return token;
}

function safeArticleResponse(payload, filename) {
  if (!payload || typeof payload !== 'object' || !payload.article || typeof payload.article !== 'object') {
    throw new Error(`upload returned an invalid response for ${filename}`);
  }
  const article = payload.article;
  return {
    id: article.id,
    postId: article.postId,
    slug: article.slug,
    locale: article.locale,
    translationKey: article.translationKey,
    status: article.status,
    tags: Array.isArray(article.tags) ? [...article.tags] : article.tags
  };
}

async function uploadArticle(options) {
  if (!options || typeof options !== 'object') throw new TypeError('options must be an object');
  const baseUrl = validateLoopbackBaseUrl(options.baseUrl);
  const token = options.token;
  const filename = options.filename;
  const bytes = options.bytes;
  const fetchImpl = options.fetchImpl === undefined ? fetch : options.fetchImpl;
  const form = new FormData();
  form.append('file', new Blob([bytes], { type: 'text/markdown; charset=utf-8' }), filename);

  let response;
  try {
    response = await fetchImpl(`${baseUrl}/api/admin/upload`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      body: form,
      redirect: 'error'
    });
  } catch {
    throw new Error(`upload request failed for ${filename}`);
  }
  if (!response || response.status !== 200) {
    const status = Number.isInteger(response?.status) ? response.status : 'unknown';
    throw new Error(`upload failed for ${filename} with HTTP ${status}`);
  }

  let payload;
  try {
    payload = await response.json();
  } catch {
    throw new Error(`upload returned invalid JSON for ${filename}`);
  }
  return safeArticleResponse(payload, filename);
}

function exactTagSet(actual, expected) {
  if (!Array.isArray(actual) || actual.length !== expected.length) return false;
  const actualSet = new Set(actual);
  if (actualSet.size !== actual.length) return false;
  return expected.every(tag => actualSet.has(tag));
}

function assertUploadIdentity(article, record, filename) {
  const mismatches = [];
  if (!Number.isSafeInteger(article.id) || article.id <= 0) mismatches.push('id');
  if (!Number.isSafeInteger(article.postId) || article.postId <= 0) mismatches.push('postId');
  if (article.locale !== 'en') mismatches.push('locale');
  if (article.translationKey !== record.translationKey) mismatches.push('translationKey');
  if (article.slug !== record.enSlug) mismatches.push('slug');
  if (article.status !== 'published') mismatches.push('status');
  if (!exactTagSet(article.tags, record.tags)) mismatches.push('tags');
  if (mismatches.length > 0) {
    throw new Error(`upload identity mismatch for ${filename}: ${mismatches.join(', ')}`);
  }
}

function readSignedArticleBytes(bundleDir, filename, expectedHash) {
  const filePath = path.join(bundleDir, filename);
  const noFollow = typeof fs.constants.O_NOFOLLOW === 'number' ? fs.constants.O_NOFOLLOW : 0;
  let fd;
  try {
    fd = fs.openSync(filePath, fs.constants.O_RDONLY | noFollow);
  } catch {
    throw new Error(`signed bundle entry could not be opened safely: ${filename}`);
  }
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) {
      throw new Error(`signed bundle entry is not a regular file: ${filename}`);
    }
    const bytes = fs.readFileSync(fd);
    const actualHash = createHash('sha256').update(bytes).digest('hex');
    if (actualHash !== expectedHash) {
      throw new Error(`SHA256SUMS mismatch for ${filename}`);
    }
    return bytes;
  } finally {
    fs.closeSync(fd);
  }
}

function validateBundleFileSet(manifest, hashes) {
  if (manifest.articles.length !== EXPECTED_ARTICLE_COUNT) {
    throw new Error(`release must contain exactly ${EXPECTED_ARTICLE_COUNT} articles`);
  }
  const expected = manifest.articles.map(record => `${record.enSlug}.md`);
  if (hashes.size !== EXPECTED_ARTICLE_COUNT || expected.some(filename => !hashes.has(filename))) {
    throw new Error('bundle filenames do not exactly match the release manifest');
  }
  return expected;
}

async function publishTranslationRelease(options) {
  if (!options || typeof options !== 'object') throw new TypeError('options must be an object');
  const baseUrl = validateLoopbackBaseUrl(options.baseUrl);
  if (typeof options.releasePath !== 'string' || options.releasePath.trim() === '') {
    throw new TypeError('releasePath must be a non-empty path');
  }
  if (typeof options.bundleDir !== 'string' || options.bundleDir.trim() === '') {
    throw new TypeError('bundleDir must be a non-empty path');
  }
  const releasePath = path.resolve(options.releasePath);
  const bundleDir = path.resolve(options.bundleDir);
  const manifest = loadReleaseManifest(releasePath);
  const hashes = loadShaManifest(bundleDir);
  const filenames = validateBundleFileSet(manifest, hashes);
  const uploads = filenames.map((filename, index) => ({
    filename,
    record: manifest.articles[index],
    bytes: readSignedArticleBytes(bundleDir, filename, hashes.get(filename))
  }));
  const fetchImpl = options.fetchImpl === undefined ? fetch : options.fetchImpl;
  if (typeof fetchImpl !== 'function') throw new TypeError('fetchImpl must be a function');

  let token;
  try {
    token = normalizeBearerToken(options.bearerToken);
    const results = [];
    for (const { filename, record, bytes } of uploads) {
      const article = await uploadArticle({
        baseUrl,
        token,
        filename,
        bytes,
        fetchImpl
      });
      assertUploadIdentity(article, record, filename);
      results.push({
        filename,
        id: article.id,
        postId: article.postId,
        slug: article.slug,
        locale: article.locale,
        translationKey: article.translationKey
      });
    }
    return results;
  } finally {
    // Intentional defense-in-depth overwrite of the only local token reference.
    // eslint-disable-next-line no-useless-assignment
    token = '';
  }
}

function writeJsonLine(stream, value) {
  stream.write(`${JSON.stringify(value)}\n`);
}

function safeErrorMessage(error) {
  if (!(error instanceof Error) || typeof error.message !== 'string' || error.message === '') {
    return 'publication failed';
  }
  return error.message.split(/\r?\n/, 1)[0].slice(0, 500);
}

async function main() {
  let parsed;
  try {
    parsed = parseArguments(process.argv.slice(2));
    const options = {
      baseUrl: parsed.baseUrl,
      bundleDir: parsed.bundleDir,
      releasePath: parsed.releasePath
    };
    Object.defineProperty(options, 'bearerToken', {
      enumerable: true,
      get() {
        return readTokenFromFd(parsed.tokenFd);
      }
    });
    const results = await publishTranslationRelease(options);
    for (const result of results) {
      writeJsonLine(process.stdout, {
        filename: result.filename,
        status: 'published',
        articleId: result.id,
        slug: result.slug,
        translationKey: result.translationKey
      });
    }
  } catch (error) {
    writeJsonLine(process.stderr, {
      status: 'failed',
      error: safeErrorMessage(error)
    });
    process.exitCode = 1;
  }
}

if (require.main === module) {
  main().catch(() => {
    writeJsonLine(process.stderr, { status: 'failed', error: 'publication failed' });
    process.exitCode = 1;
  });
}

module.exports = {
  parseArguments,
  publishTranslationRelease,
  readTokenFromFd,
  uploadArticle,
  validateLoopbackBaseUrl
};

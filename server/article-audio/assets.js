const path = require('node:path');
const crypto = require('node:crypto');
const fsSync = require('node:fs');
const fs = require('node:fs/promises');
const { isSafeSlug } = require('../utils/path-security');
const { articleAudioError, isArticleAudioInputError } = require('./errors');
const { AUDIO_FORMATS, MAX_AUDIO_BYTES, validateMp3Buffer } = require('./formats');

const MAX_ARCHIVE_EXPANDED_BYTES = 100 * 1024 * 1024;

function invalidAudioPath() {
  return articleAudioError(400, 'audio_path_invalid', '音频路径无效');
}

function normalizeArchiveEntryName(entryName) {
  if (
    typeof entryName !== 'string' ||
    !entryName ||
    entryName.includes('\\') ||
    entryName.includes('\0') ||
    path.posix.isAbsolute(entryName)
  ) {
    throw invalidAudioPath();
  }

  const normalized = path.posix.normalize(entryName);
  if (normalized === '.' || normalized === '..' || normalized.startsWith('../')) {
    throw invalidAudioPath();
  }
  return normalized;
}

function buildArchiveEntryIndex(entries, maxExpandedBytes = MAX_ARCHIVE_EXPANDED_BYTES) {
  const index = new Map();
  let expandedBytes = 0;

  for (const entry of entries) {
    const declaredSize = Number(entry.header?.size ?? 0);
    if (!Number.isSafeInteger(declaredSize) || declaredSize < 0) {
      throw articleAudioError(400, 'audio_archive_ambiguous', 'ZIP 条目大小无效');
    }
    expandedBytes += declaredSize;
    if (expandedBytes > maxExpandedBytes) {
      throw articleAudioError(413, 'archive_expanded_too_large', 'ZIP 解压后总大小超过限制');
    }

    const normalized = normalizeArchiveEntryName(entry.entryName);
    if (index.has(normalized)) {
      throw articleAudioError(400, 'audio_archive_ambiguous', 'ZIP 包含重复路径');
    }
    index.set(normalized, entry);
  }

  return index;
}

function resolveAudioEntryName(markdownEntryName, source) {
  if (
    typeof source !== 'string' ||
    !source ||
    source.includes('\\') ||
    source.includes('\0') ||
    source.includes('?') ||
    source.includes('#') ||
    path.posix.isAbsolute(source) ||
    /^[A-Za-z][A-Za-z0-9+.-]*:/.test(source)
  ) {
    throw invalidAudioPath();
  }

  const normalizedMarkdown = normalizeArchiveEntryName(markdownEntryName);
  const baseDirectory = path.posix.dirname(normalizedMarkdown);
  const resolved = path.posix.normalize(path.posix.join(baseDirectory, source));
  if (
    resolved === '.' ||
    resolved === '..' ||
    resolved.startsWith('../') ||
    resolved.endsWith('/')
  ) {
    throw invalidAudioPath();
  }
  return resolved;
}

function audioAssetEntry(index, markdownEntryName, source) {
  const resolvedEntryName = resolveAudioEntryName(markdownEntryName, source);
  const extension = path.posix.extname(resolvedEntryName);
  const format = AUDIO_FORMATS[extension];
  if (!format) {
    throw articleAudioError(400, 'audio_format_unsupported', '仅支持 .mp3、.aac、.m4a 或 .flac 音频');
  }
  const entry = index.get(resolvedEntryName);
  if (!entry || entry.isDirectory) {
    throw articleAudioError(400, 'audio_asset_missing', '音频块引用的文件不存在');
  }
  if (Number(entry.header?.size ?? 0) > format.maxBytes) {
    throw articleAudioError(413, 'audio_asset_too_large', '单个音频文件超过格式限制');
  }
  return { entry, extension, format, resolvedEntryName };
}

async function hashPublishedFile(filePath) {
  const digest = crypto.createHash('sha256');
  let size = 0;
  for await (const chunk of fsSync.createReadStream(filePath)) {
    size += chunk.length;
    digest.update(chunk);
  }
  return { hash: digest.digest('hex'), size };
}

function resolveArticleAudioDirectory(publicAudioRoot, articleSlug) {
  if (!isSafeSlug(articleSlug)) {
    throw articleAudioError(400, 'audio_path_invalid', '文章 slug 格式不安全');
  }
  const resolvedRoot = path.resolve(publicAudioRoot);
  const resolvedDirectory = path.resolve(resolvedRoot, articleSlug);
  if (!resolvedDirectory.startsWith(`${resolvedRoot}${path.sep}`)) {
    throw articleAudioError(400, 'audio_path_invalid', '文章 slug 格式不安全');
  }
  return resolvedDirectory;
}

async function prepareArticleAudioAssets({
  articleSlug,
  markdownEntryName,
  audioBlocks,
  archiveEntries,
  stagingRoot,
  publicAudioRoot
}) {
  if (!isSafeSlug(articleSlug)) {
    throw articleAudioError(400, 'audio_path_invalid', '文章 slug 格式不安全');
  }

  const index = buildArchiveEntryIndex(archiveEntries);
  const assetsByEntry = new Map();
  const assetsByExtension = new Map();
  const stagedAssets = [];
  const resolvedBlocks = [];
  const stageDirectory = path.resolve(stagingRoot, 'article-audio');

  try {
    for (const block of audioBlocks) {
      const reference = audioAssetEntry(index, markdownEntryName, block.src);
      let asset = assetsByEntry.get(reference.resolvedEntryName);
      if (!asset) {
        let buffer;
        try {
          const data = reference.entry.getData();
          buffer = Buffer.isBuffer(data) ? data : Buffer.from(data);
        } catch {
          throw articleAudioError(400, 'audio_content_invalid', '音频文件内容无效');
        }

        try {
          if (buffer.length > reference.format.maxBytes) {
            throw articleAudioError(413, 'audio_asset_too_large', '单个音频文件超过格式限制');
          }
          reference.format.validate(buffer);
          const hash = crypto.createHash('sha256').update(buffer).digest('hex');
          let assetsForExtension = assetsByExtension.get(reference.extension);
          if (!assetsForExtension) {
            assetsForExtension = new Map();
            assetsByExtension.set(reference.extension, assetsForExtension);
          }
          asset = assetsForExtension.get(hash);
          if (!asset) {
            await fs.mkdir(stageDirectory, { recursive: true });
            await fs.writeFile(
              path.join(stageDirectory, `${hash}${reference.extension}`),
              buffer,
              { flag: 'wx' }
            );
            asset = {
              extension: reference.extension,
              hash,
              mimeType: reference.format.mimeType,
              size: buffer.length
            };
            assetsForExtension.set(hash, asset);
            stagedAssets.push(asset);
          }
          assetsByEntry.set(reference.resolvedEntryName, asset);
        } finally {
          buffer = null;
        }
      }

      resolvedBlocks.push({
        ...block,
        src: `/audio/${articleSlug}/${asset.hash}${asset.extension}`,
        mimeType: asset.mimeType
      });
    }
  } catch (error) {
    await fs.rm(stageDirectory, { recursive: true, force: true }).catch(() => {});
    if (isArticleAudioInputError(error)) throw error;
    throw articleAudioError(500, 'audio_publish_failed', '音频暂存失败');
  }

  const finalDirectory = resolveArticleAudioDirectory(publicAudioRoot, articleSlug);
  let promotionComplete = false;
  let ownsFinalDirectory = false;

  return {
    resolvedBlocks,
    publishedCount: stagedAssets.length,
    async promote() {
      if (promotionComplete || stagedAssets.length === 0) return;
      try {
        await fs.mkdir(path.dirname(finalDirectory), { recursive: true });
        let finalExists = false;
        try {
          const stat = await fs.stat(finalDirectory);
          finalExists = stat.isDirectory();
        } catch (error) {
          if (error.code !== 'ENOENT') throw error;
        }

        if (!finalExists) {
          try {
            await fs.rename(stageDirectory, finalDirectory);
            ownsFinalDirectory = true;
            promotionComplete = true;
            return;
          } catch (error) {
            if (error.code === 'ENOENT') throw error;
            const stat = await fs.stat(finalDirectory);
            if (!stat.isDirectory()) throw error;
          }
        }

        for (const asset of stagedAssets) {
          const publishedPath = path.join(finalDirectory, `${asset.hash}${asset.extension}`);
          const published = await hashPublishedFile(publishedPath);
          if (published.size !== asset.size || published.hash !== asset.hash) {
            throw new Error('published audio hash conflict');
          }
        }
        await fs.rm(stageDirectory, { recursive: true, force: true });
        promotionComplete = true;
      } catch {
        throw articleAudioError(500, 'audio_publish_failed', '音频发布失败');
      }
    },
    async rollback() {
      try {
        await fs.rm(stageDirectory, { recursive: true, force: true });
        if (ownsFinalDirectory) {
          await fs.rm(finalDirectory, { recursive: true, force: true });
          ownsFinalDirectory = false;
          promotionComplete = false;
        }
      } catch {
        throw articleAudioError(500, 'article_publish_rollback_failed', '文章发布补偿失败');
      }
    }
  };
}

module.exports = {
  MAX_AUDIO_BYTES,
  MAX_ARCHIVE_EXPANDED_BYTES,
  buildArchiveEntryIndex,
  normalizeArchiveEntryName,
  prepareArticleAudioAssets,
  resolveArticleAudioDirectory,
  validateMp3Buffer,
  resolveAudioEntryName
};

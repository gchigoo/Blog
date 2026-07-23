const fs = require('node:fs/promises');
const crypto = require('node:crypto');
const path = require('node:path');
const { resolveArticlePath } = require('../utils/path-security');
const { resolveArticleAudioDirectory } = require('./assets');
const { articleAudioError, isArticleAudioInputError } = require('./errors');

let publicationTail = Promise.resolve();

async function serializeArticlePublication(action) {
  const previous = publicationTail;
  let release = () => {};
  publicationTail = new Promise(resolve => { release = resolve; });
  await previous;
  try {
    return await action();
  } finally {
    release();
  }
}

function publicationFailure(error) {
  if (isArticleAudioInputError(error)) return error;
  return articleAudioError(500, 'audio_publish_failed', '文章音频发布失败');
}

function deletionFailure(error) {
  if (isArticleAudioInputError(error)) return error;
  return articleAudioError(500, 'article_delete_failed', '文章删除失败');
}

async function moveIfPresent(fileSystem, source, destination) {
  try {
    await fileSystem.rename(source, destination);
    return true;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    try {
      await fileSystem.lstat(source);
    } catch (sourceError) {
      if (sourceError.code === 'ENOENT') return false;
      throw sourceError;
    }
    throw error;
  }
}

async function deleteArticlePublication({
  articleSlug,
  articlesRoot,
  publicAudioRoot,
  commitDatabase,
  fileSystem = fs,
  tombstoneId = crypto.randomUUID()
}) {
  if (!/^[A-Za-z0-9-]+$/.test(tombstoneId)) {
    throw articleAudioError(500, 'article_delete_failed', '文章删除失败');
  }

  const markdownPath = resolveArticlePath(articlesRoot, articleSlug);
  const audioDirectory = resolveArticleAudioDirectory(publicAudioRoot, articleSlug);
  const resources = [
    {
      source: markdownPath,
      tombstone: path.join(path.dirname(markdownPath), `.deleting-${tombstoneId}.md`),
      recursive: false
    },
    {
      source: audioDirectory,
      tombstone: path.join(path.dirname(audioDirectory), `.deleting-${tombstoneId}`),
      recursive: true
    }
  ];
  const moved = [];
  let databaseResult;

  try {
    for (const resource of resources) {
      if (await moveIfPresent(fileSystem, resource.source, resource.tombstone)) {
        moved.push(resource);
      }
    }

    databaseResult = await commitDatabase();
    if (databaseResult?.changes === 0) throw new Error('article delete did not change a row');
  } catch (error) {
    let rollbackFailed = false;
    for (const resource of [...moved].reverse()) {
      try {
        await fileSystem.rename(resource.tombstone, resource.source);
      } catch {
        rollbackFailed = true;
      }
    }
    if (rollbackFailed) {
      throw articleAudioError(500, 'article_delete_rollback_failed', '文章删除补偿失败');
    }
    throw deletionFailure(error);
  }

  const cleanupResults = await Promise.allSettled(moved.map(resource => (
    fileSystem.rm(resource.tombstone, { recursive: resource.recursive, force: true })
  )));
  return {
    ...databaseResult,
    cleanupFailed: cleanupResults.some(result => result.status === 'rejected')
  };
}

async function replaceArticlePublication({
  articleSlug,
  markdown,
  stagingRoot,
  articlesRoot,
  publicAudioRoot,
  audioAssets,
  commitDatabase,
  fileSystem = fs,
  replacementId = crypto.randomUUID()
}) {
  if (!/^[A-Za-z0-9-]+$/.test(replacementId)) {
    throw articleAudioError(500, 'article_replace_failed', '文章替换失败');
  }
  const markdownStagePath = path.resolve(stagingRoot, 'article.md');
  const markdownFinalPath = resolveArticlePath(articlesRoot, articleSlug);
  const audioFinalDirectory = resolveArticleAudioDirectory(publicAudioRoot, articleSlug);
  const resources = [
    {
      source: markdownFinalPath,
      tombstone: path.join(path.dirname(markdownFinalPath), `.replacing-${replacementId}.md`),
      recursive: false
    },
    {
      source: audioFinalDirectory,
      tombstone: path.join(path.dirname(audioFinalDirectory), `.replacing-${replacementId}`),
      recursive: true
    }
  ];
  const moved = [];
  let markdownPromoted = false;
  try {
    await fileSystem.mkdir(stagingRoot, { recursive: true });
    await fileSystem.writeFile(markdownStagePath, markdown, { flag: 'wx' });
    for (const resource of resources) {
      if (await moveIfPresent(fileSystem, resource.source, resource.tombstone)) moved.push(resource);
    }
    await fileSystem.mkdir(articlesRoot, { recursive: true });
    await fileSystem.link(markdownStagePath, markdownFinalPath);
    markdownPromoted = true;
    await fileSystem.unlink(markdownStagePath);
    await audioAssets.promote();
    const databaseResult = await commitDatabase();
    if (databaseResult?.changes === 0) throw new Error('article replace did not change a row');
    const cleanupResults = await Promise.allSettled(moved.map(resource => (
      fileSystem.rm(resource.tombstone, { recursive: resource.recursive, force: true })
    )));
    return {
      ...databaseResult,
      cleanupFailed: cleanupResults.some(result => result.status === 'rejected')
    };
  } catch (error) {
    let rollbackFailed = false;
    try { await fileSystem.rm(markdownStagePath, { force: true }); } catch { rollbackFailed = true; }
    if (markdownPromoted) {
      try { await fileSystem.rm(markdownFinalPath, { force: true }); } catch { rollbackFailed = true; }
    }
    try { await audioAssets.rollback(); } catch { rollbackFailed = true; }
    for (const resource of [...moved].reverse()) {
      try { await fileSystem.rename(resource.tombstone, resource.source); } catch { rollbackFailed = true; }
    }
    if (rollbackFailed) {
      throw articleAudioError(500, 'article_replace_rollback_failed', '文章替换补偿失败');
    }
    throw publicationFailure(error);
  }
}

async function publishArticle({
  articleSlug,
  markdown,
  stagingRoot,
  articlesRoot,
  audioAssets,
  commitDatabase,
  fileSystem = fs
}) {
  const markdownStagePath = path.resolve(stagingRoot, 'article.md');
  const markdownFinalPath = resolveArticlePath(articlesRoot, articleSlug);
  let markdownPromoted = false;

  try {
    await fileSystem.mkdir(stagingRoot, { recursive: true });
    await fileSystem.writeFile(markdownStagePath, markdown, { flag: 'wx' });
    await fileSystem.mkdir(articlesRoot, { recursive: true });
    // Linking a fully staged file gives atomic, no-clobber publication on the same volume.
    await fileSystem.link(markdownStagePath, markdownFinalPath);
    markdownPromoted = true;
    await fileSystem.unlink(markdownStagePath);
    await audioAssets.promote();
    return await commitDatabase();
  } catch (error) {
    let rollbackFailed = false;
    try {
      await fileSystem.rm(markdownStagePath, { force: true });
    } catch {
      rollbackFailed = true;
    }
    if (markdownPromoted) {
      try {
        await fileSystem.rm(markdownFinalPath, { force: true });
        markdownPromoted = false;
      } catch {
        rollbackFailed = true;
      }
    }

    try {
      await audioAssets.rollback();
    } catch {
      rollbackFailed = true;
    }

    if (rollbackFailed) {
      throw articleAudioError(500, 'article_publish_rollback_failed', '文章发布补偿失败');
    }
    throw publicationFailure(error);
  }
}

module.exports = {
  deleteArticlePublication,
  publishArticle,
  replaceArticlePublication,
  serializeArticlePublication
};

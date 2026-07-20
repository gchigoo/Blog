const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const fs = require('fs').promises;
const fsSync = require('fs');
const AdmZip = require('adm-zip');
const { db, dbRun, dbGet, dbAll } = require('../db');
const { authenticateToken } = require('../middleware/auth');
const {
  parseMarkdownDocument,
  renderMarkdown,
  extractImages,
  replaceImagePaths
} = require('../utils/markdown');
const { convertToWebP, isImage } = require('../utils/image');
const {
  isSafeSlug,
  isSafeZipEntryName,
  resolveZipEntryPath
} = require('../utils/path-security');
const {
  buildArchiveEntryIndex,
  normalizeArchiveEntryName,
  prepareArticleAudioAssets
} = require('../article-audio/assets');
const { articleAudioError, isArticleAudioInputError } = require('../article-audio/errors');
const {
  deleteArticlePublication,
  publishArticle,
  serializeArticlePublication
} = require('../article-audio/publication');
const config = require('../config');
const MAX_UPLOAD_BYTES = 100 * 1024 * 1024;

// 配置文件上传
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const uploadDir = config.uploadDir;
    // 确保目录存在（同步）
    if (!fsSync.existsSync(uploadDir)) {
      fsSync.mkdirSync(uploadDir, { recursive: true });
    }
    cb(null, uploadDir);
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    cb(null, uniqueSuffix + '-' + file.originalname);
  }
});

const upload = multer({ 
  storage,
  // Busboy emits LIMIT_FILE_SIZE when the byte count reaches the configured value.
  // Keeping one sentinel byte makes the documented 100 MiB boundary inclusive.
  limits: { fileSize: MAX_UPLOAD_BYTES + 1 }
});

function receiveArticleUpload(req, res, next) {
  upload.single('file')(req, res, error => {
    if (error instanceof multer.MulterError && error.code === 'LIMIT_FILE_SIZE') {
      return res.status(413).json({
        error: '上传文件超过 100 MiB',
        code: 'upload_file_too_large'
      });
    }
    if (error) return next(error);
    next();
  });
}

function emptyAudioAssets() {
  return {
    resolvedBlocks: [],
    publishedCount: 0,
    async promote() {},
    async rollback() {}
  };
}

async function cleanupTemporaryPaths(paths) {
  for (const temporaryPath of paths) {
    try {
      await fs.rm(temporaryPath, { recursive: true, force: true });
    } catch {
      console.error('[article-upload] temporary cleanup failed');
    }
  }
}

function selectAvailableArticleSlug(requestedSlug) {
  if (!dbGet('SELECT id FROM articles WHERE slug = ?', [requestedSlug])) {
    return requestedSlug;
  }

  let suffix = Date.now();
  let candidate;
  do {
    candidate = `${requestedSlug}-${suffix}`;
    suffix += 1;
  } while (dbGet('SELECT id FROM articles WHERE slug = ?', [candidate]));
  return candidate;
}

/**
 * POST /api/admin/upload
 * 上传 Markdown 文章（支持单文件或 ZIP）
 */
router.post('/upload', authenticateToken, receiveArticleUpload, async (req, res) => {
  const temporaryPaths = [];
  let articleSlug = null;
  
  try {
    if (!req.file) {
      return res.status(400).json({ error: '请上传文件' });
    }
    
    temporaryPaths.push(req.file.path);
    const fileExt = path.extname(req.file.originalname).toLowerCase();
    
    let markdownContent = '';
    let markdownEntryName = null;
    let archiveEntries = [];
    const imageFiles = [];
    
    // 处理 ZIP 文件
    if (fileExt === '.zip') {
      const zip = new AdmZip(req.file.path);
      archiveEntries = zip.getEntries();

      if (archiveEntries.some(entry => !isSafeZipEntryName(entry.entryName))) {
        return res.status(400).json({ error: 'ZIP 包含不安全路径' });
      }
      buildArchiveEntryIndex(archiveEntries);
      
      // 提取目录
      const extractDir = path.join(
        config.uploadDir,
        `extract-${Date.now()}-${Math.round(Math.random() * 1E9)}`
      );
      await fs.mkdir(extractDir, { recursive: true });
      temporaryPaths.push(extractDir);
      
      // 解压文件
      zip.extractAllTo(extractDir, true);
      
      // 查找 Markdown 文件
      for (const entry of archiveEntries) {
        if (!entry.isDirectory && entry.entryName.endsWith('.md')) {
          const mdPath = resolveZipEntryPath(extractDir, entry.entryName);
          markdownContent = await fs.readFile(mdPath, 'utf-8');
          markdownEntryName = normalizeArchiveEntryName(entry.entryName);
          break;
        }
      }
      
      if (!markdownContent) {
        return res.status(400).json({ error: 'ZIP 中未找到 Markdown 文件' });
      }
      
      // 收集图片文件
      for (const entry of archiveEntries) {
        if (!entry.isDirectory && isImage(entry.entryName)) {
          const imgPath = resolveZipEntryPath(extractDir, entry.entryName);
          imageFiles.push({
            originalPath: entry.entryName,
            fullPath: imgPath
          });
        }
      }
    } 
    // 处理单个 Markdown 文件
    else if (fileExt === '.md') {
      markdownContent = await fs.readFile(req.file.path, 'utf-8');
    } 
    else {
      return res.status(400).json({ error: '仅支持 .md 或 .zip 文件' });
    }
    
    // 先解析作者态文档；音频路径只有在 ZIP 资产完成验证后才能进入最终 HTML。
    const { data, content, audioBlocks } = parseMarkdownDocument(markdownContent);

    if (fileExt === '.md' && audioBlocks.length > 0) {
      throw articleAudioError(
        400,
        'audio_archive_required',
        '包含音频块的文章必须使用 ZIP 上传'
      );
    }
    
    // 验证必需字段
    if (!data.title) {
      return res.status(400).json({ error: 'Markdown 文件必须包含 title 字段' });
    }

    if (!isSafeSlug(data.slug)) {
      return res.status(400).json({ error: 'slug 格式不安全' });
    }
    
    const publication = await serializeArticlePublication(async () => {
      let audioAssets = emptyAudioAssets();
      let publicationStarted = false;
      try {
        articleSlug = selectAvailableArticleSlug(data.slug);
        const publicationStage = path.join(
          config.uploadDir,
          `publish-${Date.now()}-${Math.round(Math.random() * 1E9)}`
        );
        temporaryPaths.push(publicationStage);

        if (audioBlocks.length > 0) {
          audioAssets = await prepareArticleAudioAssets({
            articleSlug,
            markdownEntryName,
            audioBlocks,
            archiveEntries,
            stagingRoot: publicationStage,
            publicAudioRoot: config.audioDir
          });
        }

        // 处理图片
        const imageMap = {};
        const extractedImages = extractImages(markdownContent);

        for (const imgRef of extractedImages) {
          // 查找匹配的图片文件
          const matchedImage = imageFiles.find(img =>
            img.originalPath.includes(path.basename(imgRef)) ||
            imgRef.includes(path.basename(img.originalPath))
          );

          if (matchedImage) {
            try {
              // 转换为 WebP
              const outputPath = await convertToWebP(
                matchedImage.fullPath,
                config.imagesDir
              );

              const webPath = `/images/${path.basename(outputPath)}`;
              imageMap[imgRef] = webPath;
            } catch {
              console.error('[article-upload] image conversion failed');
            }
          }
        }

        // 图片路径先写回作者态 Markdown，再使用 resolved audio blocks 生成最终 HTML。
        let updatedContent = content;
        if (Object.keys(imageMap).length > 0) {
          updatedContent = replaceImagePaths(content, imageMap);
        }
        const updatedHtml = renderMarkdown(updatedContent, {
          resolvedAudioBlocks: audioAssets.resolvedBlocks
        });
        const savedMarkdown = `---
title: ${data.title}
tags: ${JSON.stringify(data.tags)}
date: ${data.date}
---

${updatedContent}`;

        const insertArticle = db.transaction(() => {
          const info = db.prepare(
            `INSERT INTO articles (title, slug, content, html, tags, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?)`
          ).run(
            data.title,
            articleSlug,
            updatedContent,
            updatedHtml,
            JSON.stringify(data.tags),
            data.date,
            new Date().toISOString()
          );
          return { id: info.lastInsertRowid, changes: info.changes };
        });

        publicationStarted = true;
        const result = await publishArticle({
          articleSlug,
          markdown: savedMarkdown,
          stagingRoot: publicationStage,
          articlesRoot: config.articlesDir,
          audioAssets,
          commitDatabase: insertArticle
        });
        return {
          id: result.id,
          slug: articleSlug,
          imagesConverted: Object.keys(imageMap).length,
          audioPublished: audioAssets.publishedCount
        };
      } catch (error) {
        if (!publicationStarted) {
          try {
            await audioAssets.rollback();
          } catch {
            throw articleAudioError(
              500,
              'article_publish_rollback_failed',
              '文章发布补偿失败'
            );
          }
        }
        throw error;
      }
    });
    
    return res.json({
      success: true,
      message: '文章上传成功',
      article: {
        id: publication.id,
        title: data.title,
        slug: publication.slug,
        tags: data.tags,
        imagesConverted: publication.imagesConverted,
        audioPublished: publication.audioPublished
      }
    });
  } catch (error) {
    if (isArticleAudioInputError(error)) {
      if (error.status >= 500) {
        console.error(
          `[article-upload] failed slug=${articleSlug || 'unassigned'} stage=publication code=${error.code}`
        );
      }
      return res.status(error.status).json({
        error: error.safeMessage,
        code: error.code
      });
    }

    console.error(`[article-upload] failed slug=${articleSlug || 'unassigned'} stage=upload`);
    return res.status(500).json({ error: '上传失败' });
  } finally {
    await cleanupTemporaryPaths(temporaryPaths);
  }
});

/**
 * GET /api/admin/articles
 * 获取所有文章（管理用）
 */
router.get('/articles', authenticateToken, (req, res) => {
  try {
    const articles = dbAll(
      `SELECT id, title, slug, tags, created_at, updated_at 
       FROM articles 
       ORDER BY created_at DESC`
    );
    
    const articlesWithTags = articles.map(article => ({
      ...article,
      tags: article.tags ? JSON.parse(article.tags) : []
    }));
    
    res.json(articlesWithTags);
  } catch (error) {
    console.error('获取文章列表失败:', error);
    res.status(500).json({ error: '服务器错误' });
  }
});

/**
 * DELETE /api/admin/articles/:id
 * 删除文章
 */
router.delete('/articles/:id', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    const deletion = await serializeArticlePublication(async () => {
      const article = dbGet('SELECT slug FROM articles WHERE id = ?', [id]);
      if (!article) return { status: 'not-found' };
      if (!isSafeSlug(article.slug)) return { status: 'unsafe-slug' };

      const result = await deleteArticlePublication({
        articleSlug: article.slug,
        articlesRoot: config.articlesDir,
        publicAudioRoot: config.audioDir,
        commitDatabase: () => dbRun('DELETE FROM articles WHERE id = ?', [id])
      });
      return {
        status: 'deleted',
        slug: article.slug,
        cleanupFailed: result.cleanupFailed
      };
    });

    if (deletion.status === 'not-found') {
      return res.status(404).json({ error: '文章不存在' });
    }
    if (deletion.status === 'unsafe-slug') {
      return res.status(400).json({ error: '文章 slug 格式不安全' });
    }
    if (deletion.cleanupFailed) {
      console.error(`[article-delete] tombstone cleanup pending id=${id} slug=${deletion.slug}`);
    }

    return res.json({ success: true, message: '文章已删除' });
  } catch {
    console.error('[article-delete] failed');
    return res.status(500).json({ error: '服务器错误' });
  }
});

module.exports = router;

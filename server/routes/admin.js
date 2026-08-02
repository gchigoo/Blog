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
  MarkdownMetadataError,
  parseMarkdownDocument,
  renderMarkdown,
  serializeMarkdownDocument,
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
  replaceArticlePublication,
  serializeArticlePublication
} = require('../article-audio/publication');
const config = require('../config');
const {
  deleteArticleSearchDocument,
  upsertArticleSearchDocument
} = require('../articles/search-index');
const { listAdminArticles } = require('../services/articles');
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
    const extension = path.extname(file.originalname).toLowerCase();
    cb(null, `${uniqueSuffix}${extension}`);
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

function findReferencedImage(imageFiles, markdownEntryName, imageReference) {
  if (typeof imageReference !== 'string' || !imageReference) return null;

  if (markdownEntryName
    && !imageReference.includes('\\')
    && !imageReference.includes('\0')
    && !imageReference.includes('?')
    && !imageReference.includes('#')
    && !path.posix.isAbsolute(imageReference)
    && !/^[A-Za-z][A-Za-z0-9+.-]*:/.test(imageReference)) {
    const resolvedName = path.posix.normalize(path.posix.join(
      path.posix.dirname(markdownEntryName),
      imageReference
    ));
    if (resolvedName !== '..' && !resolvedName.startsWith('../')) {
      const exactMatch = imageFiles.find(image => image.originalPath === resolvedName);
      if (exactMatch) return exactMatch;
    }
  }

  // Preserve legacy Windows-author paths only when the basename is unambiguous.
  if (!imageReference.includes('\\')) return null;
  const basename = imageReference.split(/[\\/]/).pop();
  const matches = imageFiles.filter(image => path.posix.basename(image.originalPath) === basename);
  return matches.length === 1 ? matches[0] : null;
}

/**
 * Localized taxonomy summary for preview/upload responses. Groups the stable
 * tag IDs of one article by their localized category labels and returns the
 * localized tag names; the article's own locale drives every label, so a
 * preview/upload response can never leak another locale's (or draft sibling's)
 * taxonomy data. Unknown IDs are skipped: this is a display summary, while the
 * upload path enforces strict ID existence in validateTaxonomyTags.
 *
 * @returns {{ categories: Array<{ name: string, tags: string[] }>, tags: string[] }}
 */
function summarizeTaxonomy(db, locale, tagIds) {
  if (!Array.isArray(tagIds) || tagIds.length === 0) return { categories: [], tags: [] };
  const placeholders = tagIds.map(() => '?').join(', ');
  const rows = dbAll(`
    SELECT category_labels.name AS category_name, tag_labels.name AS tag_name
    FROM tags
    JOIN tag_labels ON tag_labels.tag_id = tags.id AND tag_labels.locale = ?
    JOIN category_labels ON category_labels.category_id = tags.category_id AND category_labels.locale = ?
    WHERE tags.id IN (${placeholders})
    ORDER BY tags.sort_order ASC, tags.id ASC
  `, [locale, locale, ...tagIds]);
  const categories = [];
  const tags = [];
  const categoriesByName = new Map();
  for (const row of rows) {
    tags.push(row.tag_name);
    const existing = categoriesByName.get(row.category_name);
    if (existing) {
      existing.tags.push(row.tag_name);
    } else {
      const category = { name: row.category_name, tags: [row.tag_name] };
      categoriesByName.set(row.category_name, category);
      categories.push(category);
    }
  }
  return { categories, tags };
}

router.post('/preview', authenticateToken, receiveArticleUpload, async (req, res) => {
  const temporaryPaths = [];
  try {
    if (!req.file) return res.status(400).json({ error: '请上传文件' });
    temporaryPaths.push(req.file.path);
    const fileExt = path.extname(req.file.originalname).toLowerCase();
    let markdownContent;
    if (fileExt === '.md') {
      markdownContent = await fs.readFile(req.file.path, 'utf8');
    } else if (fileExt === '.zip') {
      const zip = new AdmZip(req.file.path);
      const entries = zip.getEntries();
      if (entries.some(entry => !isSafeZipEntryName(entry.entryName))) {
        return res.status(400).json({ error: 'ZIP 包含不安全路径' });
      }
      buildArchiveEntryIndex(entries);
      const markdownEntry = entries.find(entry => !entry.isDirectory && entry.entryName.endsWith('.md'));
      if (!markdownEntry) return res.status(400).json({ error: 'ZIP 中未找到 Markdown 文件' });
      markdownContent = markdownEntry.getData().toString('utf8');
    } else {
      return res.status(400).json({ error: '仅支持 .md 或 .zip 文件' });
    }
    const { data, content, audioBlocks } = parseMarkdownDocument(markdownContent);
    const previewContent = audioBlocks.length > 0
      ? `${content.replace(/^:::audio\s*$[\s\S]*?^:::\s*$/gm, '')}\n\n> 预览不会加载尚未发布的音频文件。`
      : content;
    const taxonomy = summarizeTaxonomy(db, data.locale, data.tags);
    return res.json({
      title: data.title,
      description: data.description,
      status: data.status,
      locale: data.locale,
      translationKey: data.translationKey,
      categories: taxonomy.categories,
      tags: taxonomy.tags,
      html: renderMarkdown(previewContent, { locale: data.locale })
    });
  } catch (error) {
    if (error instanceof MarkdownMetadataError) {
      return res.status(400).json({ error: error.message, code: 'invalid_article_metadata' });
    }
    if (isArticleAudioInputError(error)) {
      return res.status(error.status).json({ error: error.safeMessage, code: error.code });
    }
    console.error('[article-preview] failed');
    return res.status(500).json({ error: '预览生成失败' });
  } finally {
    await cleanupTemporaryPaths(temporaryPaths);
  }
});

function selectAvailableArticleSlug(requestedSlug, locale) {
  if (!dbGet('SELECT id FROM articles WHERE slug = ? AND locale = ?', [requestedSlug, locale])) {
    return requestedSlug;
  }

  let suffix = Date.now();
  let candidate;
  do {
    candidate = `${requestedSlug}-${suffix}`;
    suffix += 1;
  } while (dbGet('SELECT id FROM articles WHERE slug = ? AND locale = ?', [candidate, locale]));
  return candidate;
}

/**
 * Validate every front matter tag as an existing stable taxonomy ID. No
 * free-text labels, no legacy allocation, and no database writes here: the
 * English locale additionally refuses legacy-origin tags that carry no
 * localized content yet.
 */
function validateTaxonomyTags(db, locale, tags) {
  const placeholders = tags.map(() => '?').join(', ');
  const rows = dbAll(`SELECT id, origin FROM tags WHERE id IN (${placeholders})`, tags);
  const byId = new Map(rows.map(row => [row.id, row]));
  const missing = tags.filter(tag => !byId.has(tag));
  if (missing.length > 0) {
    throw articleAudioError(400, 'unknown_taxonomy_tag', `未知标签: ${missing.join(', ')}`);
  }
  if (locale === 'en') {
    const unlocalized = tags.filter(tag => byId.get(tag).origin === 'legacy');
    if (unlocalized.length > 0) {
      throw articleAudioError(400, 'unlocalized_taxonomy_tag', '英文文章不能引用 legacy 标签');
    }
  }
}

/**
 * Read-only publication identity planning. Explicit translation keys are used
 * exactly as supplied (never suffixed); omitted keys keep the backward
 * compatible serialized allocation where a same-locale conflict receives a
 * numeric suffix and a free slug may attach to an existing logical post.
 *
 * @returns {{ finalSlug: string, finalTranslationKey: string, postId: number | null }}
 */
function planPublicationIdentity(db, data) {
  const locale = data.locale;

  if (data.translationKeyExplicit) {
    const existingPost = dbGet('SELECT id FROM posts WHERE translation_key = ?', [data.translationKey]);
    let postId = null;
    if (existingPost) {
      const sibling = dbGet('SELECT id FROM articles WHERE post_id = ? AND locale = ?', [existingPost.id, locale]);
      if (sibling) {
        throw articleAudioError(409, 'translation_locale_exists', '同语言下该翻译键已存在文章');
      }
      postId = existingPost.id;
    }
    const slugOwner = dbGet('SELECT id, post_id FROM articles WHERE slug = ? AND locale = ?', [data.slug, locale]);
    if (slugOwner && (!postId || slugOwner.post_id !== postId)) {
      throw articleAudioError(409, 'locale_slug_exists', '该 slug 已被其他文章占用');
    }
    return { finalSlug: data.slug, finalTranslationKey: data.translationKey, postId };
  }

  const slugOwner = dbGet('SELECT id FROM articles WHERE slug = ? AND locale = ?', [data.slug, locale]);
  if (slugOwner) {
    const finalSlug = selectAvailableArticleSlug(data.slug, locale);
    return { finalSlug, finalTranslationKey: finalSlug, postId: null };
  }
  const existingPost = dbGet('SELECT id FROM posts WHERE translation_key = ?', [data.slug]);
  if (existingPost) {
    const sibling = dbGet('SELECT id FROM articles WHERE post_id = ? AND locale = ?', [existingPost.id, locale]);
    if (sibling) {
      const finalSlug = selectAvailableArticleSlug(data.slug, locale);
      return { finalSlug, finalTranslationKey: finalSlug, postId: null };
    }
    return { finalSlug: data.slug, finalTranslationKey: data.slug, postId: existingPost.id };
  }
  return { finalSlug: data.slug, finalTranslationKey: data.slug, postId: null };
}

/**
 * POST /api/admin/upload
 * 上传 Markdown 文章（支持单文件或 ZIP）
 */
router.post('/upload', authenticateToken, receiveArticleUpload, async (req, res) => {
  const temporaryPaths = [];
  let articleSlug = null;
  const imageWarnings = [];
  
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
            originalPath: normalizeArchiveEntryName(entry.entryName),
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

    validateTaxonomyTags(db, data.locale, data.tags);

    const publication = await serializeArticlePublication(async () => {
      let audioAssets = emptyAudioAssets();
      let publicationStarted = false;
      try {
        let replacementArticle = null;
        let identity = null;
        let locale;
        if (req.body.replaceId !== undefined && req.body.replaceId !== '') {
          if (typeof req.body.replaceId !== 'string' || !/^\d+$/.test(req.body.replaceId)) {
            return Promise.reject(articleAudioError(400, 'article_replace_invalid', '替换文章参数无效'));
          }
          // Immutable identity fields are compared before any file staging:
          // id, post_id, locale, slug, and translation_key all come from one
          // posts-joined lookup.
          replacementArticle = dbGet(`
            SELECT a.id, a.locale, a.slug, a.post_id, p.translation_key
            FROM articles a
            JOIN posts p ON p.id = a.post_id
            WHERE a.id = ?
          `, [req.body.replaceId]);
          if (!replacementArticle) {
            return Promise.reject(articleAudioError(404, 'article_replace_not_found', '替换文章不存在'));
          }
          if (replacementArticle.slug !== data.slug) {
            return Promise.reject(articleAudioError(400, 'article_replace_slug_mismatch', '替换文章必须保持原 slug'));
          }
          if (replacementArticle.locale !== data.locale) {
            return Promise.reject(articleAudioError(400, 'article_replace_locale_mismatch', '替换文章必须保持原 locale'));
          }
          if (replacementArticle.translation_key !== data.translationKey) {
            return Promise.reject(
              articleAudioError(400, 'article_replace_translation_key_mismatch', '替换文章必须保持原 translationKey')
            );
          }
          articleSlug = replacementArticle.slug;
          locale = replacementArticle.locale;
        } else {
          identity = planPublicationIdentity(db, data);
          articleSlug = identity.finalSlug;
          locale = data.locale;
        }
        const finalTranslationKey = replacementArticle
          ? replacementArticle.translation_key
          : identity.finalTranslationKey;
        const articlesRoot = path.join(config.articlesDir, locale);
        const audioRoot = path.join(config.audioDir, locale);
        const publicationStage = path.join(
          config.uploadDir,
          `publish-${Date.now()}-${Math.round(Math.random() * 1E9)}`
        );
        temporaryPaths.push(publicationStage);

        if (audioBlocks.length > 0) {
          audioAssets = await prepareArticleAudioAssets({
            locale,
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
          // 优先按 Markdown 所在目录解析精确路径；旧 Windows 路径仅接受唯一同名文件。
          const matchedImage = findReferencedImage(imageFiles, markdownEntryName, imgRef);

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
              imageWarnings.push(imgRef);
              console.error('[article-upload] image conversion failed');
            }
          }
        }

        // 图片路径先写回作者态 Markdown，再使用 resolved audio blocks 生成最终 HTML。
        // The article locale drives the stored audio fallback label so persisted
        // HTML is already localized for the language it was authored in.
        let updatedContent = content;
        if (Object.keys(imageMap).length > 0) {
          updatedContent = replaceImagePaths(content, imageMap);
        }
        const updatedHtml = renderMarkdown(updatedContent, {
          resolvedAudioBlocks: audioAssets.resolvedBlocks,
          locale
        });
        const savedMarkdown = serializeMarkdownDocument(updatedContent, {
          title: data.title,
          slug: articleSlug,
          locale,
          translationKey: finalTranslationKey,
          tags: data.tags,
          date: data.date,
          description: data.description,
          status: data.status
        });

        const insertArticleTag = db.prepare('INSERT OR IGNORE INTO article_tags (article_id, tag_id) VALUES (?, ?)');

        // posts.updated_at always equals the newest surviving sibling version.
        // The statement runs after the FTS refresh so the whole lifecycle keeps
        // one ordering: article write, tag replacement, FTS refresh, post touch.
        const refreshPostUpdatedAt = db.prepare(`
          UPDATE posts SET updated_at = (SELECT MAX(updated_at) FROM articles WHERE post_id = ?) WHERE id = ?
        `);

        const commitArticle = db.transaction(() => {
          const now = new Date().toISOString();
          if (replacementArticle) {
            const updateInfo = db.prepare(`
              UPDATE articles
              SET title = ?, content = ?, html = ?, description = ?, status = ?, updated_at = ?
              WHERE id = ?
            `).run(
              data.title, updatedContent, updatedHtml,
              data.description || null, data.status, now, replacementArticle.id
            );
            db.prepare('DELETE FROM article_tags WHERE article_id = ?').run(replacementArticle.id);
            for (const tagId of data.tags) {
              insertArticleTag.run(replacementArticle.id, tagId);
            }
            upsertArticleSearchDocument(db, replacementArticle.id);
            refreshPostUpdatedAt.run(replacementArticle.post_id, replacementArticle.post_id);
            return { id: replacementArticle.id, postId: replacementArticle.post_id, changes: updateInfo.changes };
          }

          // Recheck and allocate the logical post inside the final transaction.
          // The publication serializer guarantees no other publication is
          // mid-flight, so a planned post can only vanish if external tooling
          // deleted it; every violation rolls the new post back with the
          // transaction before any success is reported.
          let postId = identity.postId;
          if (!postId) {
            const existingPost = dbGet('SELECT id FROM posts WHERE translation_key = ?', [finalTranslationKey]);
            if (existingPost) {
              const sibling = dbGet('SELECT id FROM articles WHERE post_id = ? AND locale = ?', [existingPost.id, locale]);
              if (sibling) {
                throw articleAudioError(409, 'translation_locale_exists', '同语言下该翻译键已存在文章');
              }
              postId = existingPost.id;
            } else {
              const postInfo = db.prepare(`
                INSERT INTO posts (translation_key, created_at, updated_at)
                VALUES (?, ?, ?)
              `).run(finalTranslationKey, data.date, now);
              postId = Number(postInfo.lastInsertRowid);
            }
          }
          const slugOwner = dbGet('SELECT id FROM articles WHERE slug = ? AND locale = ?', [articleSlug, locale]);
          if (slugOwner) {
            throw articleAudioError(409, 'locale_slug_exists', '该 slug 已被其他文章占用');
          }
          const articleInfo = db.prepare(`
            INSERT INTO articles
              (post_id, locale, title, slug, content, html, status, description, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `).run(
            postId, locale, data.title, articleSlug, updatedContent, updatedHtml,
            data.status, data.description || null, data.date, now
          );
          const articleId = Number(articleInfo.lastInsertRowid);
          for (const tagId of data.tags) {
            insertArticleTag.run(articleId, tagId);
          }
          upsertArticleSearchDocument(db, articleId);
          refreshPostUpdatedAt.run(postId, postId);
          return { id: articleId, postId, changes: articleInfo.changes };
        });

        publicationStarted = true;
        const publicationOptions = {
          articleSlug,
          markdown: savedMarkdown,
          stagingRoot: publicationStage,
          articlesRoot,
          audioAssets,
          commitDatabase: commitArticle
        };
        const result = replacementArticle
          ? await replaceArticlePublication({
            ...publicationOptions,
            publicAudioRoot: audioRoot
          })
          : await publishArticle(publicationOptions);
        return {
          id: result.id,
          postId: result.postId,
          slug: articleSlug,
          locale,
          translationKey: finalTranslationKey,
          imagesConverted: Object.keys(imageMap).length,
          audioPublished: audioAssets.publishedCount,
          replaced: Boolean(replacementArticle)
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
        postId: publication.postId,
        title: data.title,
        slug: publication.slug,
        locale: publication.locale,
        translationKey: publication.translationKey,
        tags: data.tags,
        categories: summarizeTaxonomy(db, publication.locale, data.tags).categories,
        imagesConverted: publication.imagesConverted,
        audioPublished: publication.audioPublished,
        status: data.status,
        replaced: publication.replaced,
        imageWarnings
      }
    });
  } catch (error) {
    if (error instanceof MarkdownMetadataError) {
      return res.status(400).json({
        error: error.message,
        code: 'invalid_article_metadata'
      });
    }

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
 * 获取所有文章（管理用，包含全部语言版本与翻译组信息）
 */
router.get('/articles', authenticateToken, (req, res) => {
  try {
    res.json(listAdminArticles(db));
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
      const article = dbGet('SELECT id, locale, slug, post_id FROM articles WHERE id = ?', [id]);
      if (!article) return { status: 'not-found' };
      if (!isSafeSlug(article.slug)) return { status: 'unsafe-slug' };

      const result = await deleteArticlePublication({
        articleSlug: article.slug,
        articlesRoot: path.join(config.articlesDir, article.locale),
        publicAudioRoot: path.join(config.audioDir, article.locale),
        commitDatabase: () => db.transaction(() => {
          // Delete the article row first so article_tags and comments cascade;
          // the FTS row is only removed once the row is really gone. A
          // zero-change DELETE aborts the transaction so no stale document or
          // post bookkeeping survives a vanished row.
          const deleted = dbRun('DELETE FROM articles WHERE id = ?', [article.id]);
          if (deleted.changes === 0) {
            throw new Error('article delete did not change a row');
          }
          deleteArticleSearchDocument(db, article.id);
          const remaining = dbGet('SELECT COUNT(*) AS count FROM articles WHERE post_id = ?', [article.post_id]);
          if (remaining.count === 0) {
            dbRun('DELETE FROM posts WHERE id = ?', [article.post_id]);
          } else {
            dbRun(`
              UPDATE posts SET updated_at = (SELECT MAX(updated_at) FROM articles WHERE post_id = ?) WHERE id = ?
            `, [article.post_id, article.post_id]);
          }
          return { id: article.id, changes: deleted.changes };
        })()
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

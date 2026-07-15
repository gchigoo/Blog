const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const fs = require('fs').promises;
const fsSync = require('fs');
const AdmZip = require('adm-zip');
const { dbRun, dbGet, dbAll } = require('../db');
const { authenticateToken } = require('../middleware/auth');
const { parseMarkdown, extractImages, replaceImagePaths, replaceHtmlImagePaths } = require('../utils/markdown');
const { convertToWebP, isImage, createWebPFromBuffer } = require('../utils/image');
const {
  isSafeSlug,
  isSafeZipEntryName,
  resolveArticlePath,
  resolveZipEntryPath
} = require('../utils/path-security');
const config = require('../config');

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
  limits: { fileSize: 50 * 1024 * 1024 } // 50MB
});

/**
 * POST /api/admin/upload
 * 上传 Markdown 文章（支持单文件或 ZIP）
 */
router.post('/upload', authenticateToken, upload.single('file'), async (req, res) => {
  let tempFiles = [];
  
  try {
    if (!req.file) {
      return res.status(400).json({ error: '请上传文件' });
    }
    
    tempFiles.push(req.file.path);
    const fileExt = path.extname(req.file.originalname).toLowerCase();
    
    let markdownContent = '';
    let imageFiles = [];
    
    // 处理 ZIP 文件
    if (fileExt === '.zip') {
      const zip = new AdmZip(req.file.path);
      const zipEntries = zip.getEntries();

      if (zipEntries.some(entry => !isSafeZipEntryName(entry.entryName))) {
        return res.status(400).json({ error: 'ZIP 包含不安全路径' });
      }
      
      // 提取目录
      const extractDir = path.join(config.uploadDir, `extract-${Date.now()}`);
      await fs.mkdir(extractDir, { recursive: true });
      tempFiles.push(extractDir);
      
      // 解压文件
      zip.extractAllTo(extractDir, true);
      
      // 查找 Markdown 文件
      for (const entry of zipEntries) {
        if (!entry.isDirectory && entry.entryName.endsWith('.md')) {
          const mdPath = resolveZipEntryPath(extractDir, entry.entryName);
          markdownContent = await fs.readFile(mdPath, 'utf-8');
          break;
        }
      }
      
      if (!markdownContent) {
        return res.status(400).json({ error: 'ZIP 中未找到 Markdown 文件' });
      }
      
      // 收集图片文件
      for (const entry of zipEntries) {
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
    
    // 解析 Markdown
    const { data, content, html } = parseMarkdown(markdownContent);
    
    // 验证必需字段
    if (!data.title) {
      return res.status(400).json({ error: 'Markdown 文件必须包含 title 字段' });
    }

    if (!isSafeSlug(data.slug)) {
      return res.status(400).json({ error: 'slug 格式不安全' });
    }
    
    // 检查 slug 是否已存在
    const existingArticle = dbGet(
      'SELECT id FROM articles WHERE slug = ?',
      [data.slug]
    );
    
    if (existingArticle) {
      // 如果存在，添加时间戳
      data.slug = `${data.slug}-${Date.now()}`;
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
          
          console.log(`图片已转换: ${imgRef} -> ${webPath}`);
        } catch (error) {
          console.error(`图片转换失败: ${imgRef}`, error);
        }
      }
    }
    
    // 更新 Markdown 和 HTML 中的图片路径
    let updatedContent = content;
    let updatedHtml = html;
    
    if (Object.keys(imageMap).length > 0) {
      updatedContent = replaceImagePaths(content, imageMap);
      updatedHtml = replaceHtmlImagePaths(html, imageMap);
    }
    
    // 保存文章到数据库
    const result = dbRun(
      `INSERT INTO articles (title, slug, content, html, tags, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        data.title,
        data.slug,
        updatedContent,
        updatedHtml,
        JSON.stringify(data.tags),
        data.date,
        new Date().toISOString()
      ]
    );
    
    // 保存 Markdown 原文
    const articlesDir = config.articlesDir;
    await fs.mkdir(articlesDir, { recursive: true });
    const mdFilePath = resolveArticlePath(articlesDir, data.slug);
    await fs.writeFile(mdFilePath, `---
title: ${data.title}
tags: ${JSON.stringify(data.tags)}
date: ${data.date}
---

${updatedContent}`);
    
    // 清理临时文件
    for (const tempFile of tempFiles) {
      try {
        const stat = await fs.stat(tempFile);
        if (stat.isDirectory()) {
          await fs.rm(tempFile, { recursive: true, force: true });
        } else {
          await fs.unlink(tempFile);
        }
      } catch (error) {
        console.error(`清理临时文件失败: ${tempFile}`, error);
      }
    }
    
    res.json({
      success: true,
      message: '文章上传成功',
      article: {
        id: result.id,
        title: data.title,
        slug: data.slug,
        tags: data.tags,
        imagesConverted: Object.keys(imageMap).length
      }
    });
  } catch (error) {
    console.error('上传文章失败:', error);
    
    // 清理临时文件
    for (const tempFile of tempFiles) {
      try {
        const stat = await fs.stat(tempFile);
        if (stat.isDirectory()) {
          await fs.rm(tempFile, { recursive: true, force: true });
        } else {
          await fs.unlink(tempFile);
        }
      } catch (error) {
        // 忽略清理错误
      }
    }
    
    res.status(500).json({ 
      error: '上传失败', 
      details: error.message 
    });
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
router.delete('/articles/:id', authenticateToken, (req, res) => {
  try {
    const { id } = req.params;
    
    // 获取文章信息
    const article = dbGet('SELECT slug FROM articles WHERE id = ?', [id]);
    
    if (!article) {
      return res.status(404).json({ error: '文章不存在' });
    }

    if (!isSafeSlug(article.slug)) {
      return res.status(400).json({ error: '文章 slug 格式不安全' });
    }

    const mdFilePath = resolveArticlePath(config.articlesDir, article.slug);
    
    // 删除数据库记录
    dbRun('DELETE FROM articles WHERE id = ?', [id]);
    
    // 删除 Markdown 文件
    fs.unlink(mdFilePath).catch(error => {
      console.error('删除 Markdown 文件失败:', error);
    });
    
    res.json({ success: true, message: '文章已删除' });
  } catch (error) {
    console.error('删除文章失败:', error);
    res.status(500).json({ error: '服务器错误' });
  }
});

module.exports = router;

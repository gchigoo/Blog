const sharp = /** @type {any} */ (require('sharp'));
const path = require('path');
const fs = require('fs').promises;
const crypto = require('crypto');
const config = require('../config');

/**
 * 转换图片为 WebP 格式
 * @param {string} inputPath - 输入图片路径
 * @param {string} outputDir - 输出目录
 * @param {string} filename - 输出文件名（可选，不包含扩展名）
 * @returns {Promise<string>} - 输出文件路径
 */
async function convertToWebP(inputPath, outputDir, filename = null) {
  try {
    // 确保输出目录存在
    await fs.mkdir(outputDir, { recursive: true });
    
    // 生成输出文件名
    if (!filename) {
      const hash = crypto.createHash('md5').update(inputPath + Date.now()).digest('hex');
      filename = hash.substring(0, 16);
    }
    
    const outputPath = path.join(outputDir, `${filename}.webp`);
    
    // 转换图片
    await sharp(inputPath)
      .webp({ quality: config.imageQuality })
      .toFile(outputPath);
    
    console.log(`图片转换成功: ${inputPath} -> ${outputPath}`);
    
    return outputPath;
  } catch (error) {
    console.error(`图片转换失败: ${inputPath}`, error);
    throw error;
  }
}

/**
 * 批量转换图片
 * @param {Array} imagePaths - 图片路径数组
 * @param {string} outputDir - 输出目录
 * @returns {Promise<Object>} - 路径映射 { 'old.jpg': '/images/new.webp' }
 */
async function convertImages(imagePaths, outputDir) {
  const imageMap = {};
  
  for (const imagePath of imagePaths) {
    try {
      // 检查文件是否存在
      await fs.access(imagePath);
      
      // 生成唯一文件名
      const hash = crypto.createHash('md5').update(imagePath + Date.now()).digest('hex');
      const filename = hash.substring(0, 16);
      
      // 转换图片
      const outputPath = await convertToWebP(imagePath, outputDir, filename);
      
      // 生成 Web 可访问路径
      const webPath = `/images/${path.basename(outputPath)}`;
      imageMap[imagePath] = webPath;
    } catch (error) {
      console.error(`处理图片失败: ${imagePath}`, error);
      // 继续处理其他图片
    }
  }
  
  return imageMap;
}

/**
 * 从 Buffer 创建 WebP 图片
 * @param {Buffer} buffer - 图片 Buffer
 * @param {string} outputDir - 输出目录
 * @param {string} originalName - 原始文件名
 * @returns {Promise<string>} - Web 可访问路径
 */
async function createWebPFromBuffer(buffer, outputDir, originalName = '') {
  try {
    // 确保输出目录存在
    await fs.mkdir(outputDir, { recursive: true });
    
    // 生成唯一文件名
    const hash = crypto.createHash('md5').update(buffer).digest('hex');
    const filename = `${hash.substring(0, 16)}.webp`;
    const outputPath = path.join(outputDir, filename);
    
    // 转换图片
    await sharp(buffer)
      .webp({ quality: config.imageQuality })
      .toFile(outputPath);
    
    console.log(`从 Buffer 创建 WebP 成功: ${originalName} -> ${filename}`);
    
    return `/images/${filename}`;
  } catch (error) {
    console.error(`从 Buffer 创建 WebP 失败: ${originalName}`, error);
    throw error;
  }
}

/**
 * 检查文件是否为图片
 * @param {string} filename - 文件名
 * @returns {boolean}
 */
function isImage(filename) {
  const imageExts = ['.jpg', '.jpeg', '.png', '.gif', '.bmp', '.tiff', '.webp'];
  const ext = path.extname(filename).toLowerCase();
  return imageExts.includes(ext);
}

/**
 * 获取图片信息
 * @param {string} imagePath - 图片路径
 * @returns {Promise<Object>} - { width, height, format }
 */
async function getImageInfo(imagePath) {
  try {
    const metadata = await sharp(imagePath).metadata();
    return {
      width: metadata.width,
      height: metadata.height,
      format: metadata.format
    };
  } catch (error) {
    console.error(`获取图片信息失败: ${imagePath}`, error);
    throw error;
  }
}

/**
 * 清理临时文件
 * @param {string} dirPath - 目录路径
 */
async function cleanupTempFiles(dirPath) {
  try {
    const files = await fs.readdir(dirPath);
    for (const file of files) {
      await fs.unlink(path.join(dirPath, file));
    }
    console.log(`临时文件清理完成: ${dirPath}`);
  } catch (error) {
    console.error(`清理临时文件失败: ${dirPath}`, error);
  }
}

module.exports = {
  convertToWebP,
  convertImages,
  createWebPFromBuffer,
  isImage,
  getImageInfo,
  cleanupTempFiles
};

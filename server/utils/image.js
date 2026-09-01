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
 * 检查文件是否为图片
 * @param {string} filename - 文件名
 * @returns {boolean}
 */
function isImage(filename) {
  const imageExts = ['.jpg', '.jpeg', '.png', '.gif', '.bmp', '.tiff', '.webp'];
  const ext = path.extname(filename).toLowerCase();
  return imageExts.includes(ext);
}

module.exports = {
  convertToWebP,
  isImage
};

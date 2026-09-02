const sharp = /** @type {any} */ (require('sharp'));
const path = require('path');
const fs = require('fs').promises;
const crypto = require('crypto');
const config = require('../config');

/** sharp 输入像素上限，防止超大图耗尽内存 */
const LIMIT_INPUT_PIXELS = 50_000_000;

const IMAGE_MAGIC = {
  '.png': { minBytes: 8, match: buf => buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4E && buf[3] === 0x47
    && buf[4] === 0x0D && buf[5] === 0x0A && buf[6] === 0x1A && buf[7] === 0x0A },
  '.jpg': { minBytes: 3, match: buf => buf[0] === 0xFF && buf[1] === 0xD8 && buf[2] === 0xFF },
  '.jpeg': { minBytes: 3, match: buf => buf[0] === 0xFF && buf[1] === 0xD8 && buf[2] === 0xFF },
  '.gif': { minBytes: 6, match: buf => buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x38
    && (buf[4] === 0x37 || buf[4] === 0x39) && buf[5] === 0x61 },
  '.webp': { minBytes: 12, match: buf => buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46
    && buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50 }
};

/**
 * 按扩展名校验图片魔数，拒绝扩展名与内容不一致的文件
 * @param {string} inputPath
 */
async function assertImageMagicBytes(inputPath) {
  const ext = path.extname(inputPath).toLowerCase();
  const rule = IMAGE_MAGIC[ext];
  if (!rule) return;

  const handle = await fs.open(inputPath, 'r');
  try {
    const buffer = Buffer.alloc(rule.minBytes);
    const { bytesRead } = await handle.read(buffer, 0, rule.minBytes, 0);
    if (bytesRead < rule.minBytes || !rule.match(buffer)) {
      throw new Error(`图片内容与扩展名不匹配: ${ext}`);
    }
  } finally {
    await handle.close();
  }
}

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

    await assertImageMagicBytes(inputPath);

    // 转换图片
    await sharp(inputPath, { limitInputPixels: LIMIT_INPUT_PIXELS })
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
  isImage,
  LIMIT_INPUT_PIXELS
};

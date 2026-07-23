const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const PUBLIC_ROOT = path.resolve(__dirname, '..', '..', 'public');
const assetVersions = new Map();
const dateFormatters = new Map();
const archiveDateFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Shanghai',
  year: 'numeric',
  month: 'numeric'
});
const yearFormatter = new Intl.DateTimeFormat('zh-CN', {
  timeZone: 'Asia/Shanghai',
  year: 'numeric'
});

function assetUrl(publicPath) {
  if (typeof publicPath !== 'string' || !publicPath.startsWith('/') || publicPath.includes('..')) {
    throw new TypeError('asset path must be an absolute public path');
  }
  let version = assetVersions.get(publicPath);
  if (!version) {
    const filePath = path.resolve(PUBLIC_ROOT, `.${publicPath}`);
    if (!filePath.startsWith(`${PUBLIC_ROOT}${path.sep}`)) throw new TypeError('invalid asset path');
    version = crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex').slice(0, 12);
    assetVersions.set(publicPath, version);
  }
  return `${publicPath}?v=${version}`;
}

function formatDate(value, options = {}) {
  const key = JSON.stringify(options);
  let formatter = dateFormatters.get(key);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('zh-CN', {
      timeZone: 'Asia/Shanghai',
      ...options
    });
    dateFormatters.set(key, formatter);
  }
  return formatter.format(new Date(value));
}

function formatYear(value) {
  return yearFormatter.formatToParts(new Date(value)).find(part => part.type === 'year').value;
}

function groupArticlesByMonth(articles) {
  const archive = {};
  for (const article of articles) {
    const parts = archiveDateFormatter.formatToParts(new Date(article.created_at));
    const year = parts.find(part => part.type === 'year').value;
    const month = String(Number(parts.find(part => part.type === 'month').value));
    archive[year] ||= {};
    archive[year][month] ||= [];
    archive[year][month].push(article);
  }
  return archive;
}

function escapeXml(value) {
  return String(value ?? '').replace(/[<>&"']/g, character => ({
    '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;'
  })[character]);
}

module.exports = { assetUrl, escapeXml, formatDate, formatYear, groupArticlesByMonth };

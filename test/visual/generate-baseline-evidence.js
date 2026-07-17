const { createHash } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const sharp = require('sharp');
const { scenarios } = require('./scenarios');

const BASELINE_EJS_VERSION = '3.1.10';
const baselineWriteFlag = 'ALLOW_EJS3_BASELINE_WRITE';

function readInstalledEjsVersion() {
  let directory = path.dirname(require.resolve('ejs'));
  while (directory !== path.dirname(directory)) {
    const manifestPath = path.join(directory, 'package.json');
    if (fs.existsSync(manifestPath)) {
      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
      if (manifest.name === 'ejs' && typeof manifest.version === 'string') {
        return manifest.version;
      }
    }
    directory = path.dirname(directory);
  }
  throw new Error('Unable to resolve the installed EJS package version.');
}

const installedEjsVersion = readInstalledEjsVersion();

const visualRoot = __dirname;
const snapshotsRoot = path.join(visualRoot, '__snapshots__');
const visualSnapshots = path.join(snapshotsRoot, 'ejs-visual.spec.js');
const htmlSnapshots = path.join(snapshotsRoot, 'ejs-html.spec.js', 'html-snapshots');
const projects = Object.freeze([
  { id: 'desktop-1080p', label: 'Desktop 1080p', viewport: '1920×1080', dpr: 1 },
  { id: 'desktop-2k', label: 'Desktop 2K / QHD', viewport: '2560×1440', dpr: 1 },
  { id: 'desktop-4k', label: 'Desktop 4K', viewport: '3840×2160', dpr: 1 },
  { id: 'iphone-17', label: 'iPhone 17', viewport: '402×874', dpr: 3 },
  { id: 'iphone-air', label: 'iPhone Air', viewport: '420×912', dpr: 3 },
  { id: 'iphone-17-pro-max', label: 'iPhone 17 Pro Max', viewport: '440×956', dpr: 3 }
]);

function relativeToVisual(filePath) {
  return path.relative(visualRoot, filePath).replaceAll('\\', '/');
}

function sha256(filePath) {
  return createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

async function buildEntries() {
  const entries = [];
  for (const project of projects) {
    for (const scenario of scenarios) {
      const imagePath = path.join(visualSnapshots, project.id, `${scenario.id}.png`);
      const layoutPath = path.join(visualSnapshots, project.id, `${scenario.id}-layout.json`);
      const htmlPath = path.join(htmlSnapshots, `${scenario.id}.html`);
      for (const required of [imagePath, layoutPath, htmlPath]) {
        if (!fs.existsSync(required)) throw new Error(`Missing baseline: ${required}`);
      }
      const metadata = await sharp(imagePath).metadata();
      entries.push({
        project,
        scenario,
        imagePath,
        layoutPath,
        htmlPath,
        imageWidth: metadata.width,
        imageHeight: metadata.height,
        imageBytes: fs.statSync(imagePath).size
      });
    }
  }
  return entries;
}

function buildManifest(entries) {
  const files = new Map();
  for (const entry of entries) {
    for (const filePath of [entry.imagePath, entry.layoutPath, entry.htmlPath]) {
      files.set(relativeToVisual(filePath), sha256(filePath));
    }
  }
  return {
    schemaVersion: 1,
    baselineEngine: `ejs@${installedEjsVersion}`,
    scenarioCount: scenarios.length,
    projectCount: projects.length,
    htmlSnapshotCount: scenarios.length,
    layoutSnapshotCount: entries.length,
    imageSnapshotCount: entries.length,
    files: Object.fromEntries([...files.entries()].sort(([left], [right]) => left.localeCompare(right)))
  };
}

function buildIndex(entries) {
  const sections = projects.map(project => {
    const cards = entries.filter(entry => entry.project.id === project.id).map(entry => {
      const image = relativeToVisual(entry.imagePath);
      const layout = relativeToVisual(entry.layoutPath);
      const html = relativeToVisual(entry.htmlPath);
      const sizeMiB = (entry.imageBytes / 1024 / 1024).toFixed(2);
      return `<article class="card">
        <h3>${escapeHtml(entry.scenario.id)}</h3>
        <a href="${image}"><img loading="lazy" src="${image}" alt="${escapeHtml(project.label)} / ${escapeHtml(entry.scenario.id)}"></a>
        <p>${entry.imageWidth}×${entry.imageHeight}px · ${sizeMiB} MiB</p>
        <nav><a href="${image}">原始 PNG</a> · <a href="${layout}">layout/style JSON</a> · <a href="${html}">HTML</a></nav>
      </article>`;
    }).join('\n');
    return `<section id="${project.id}">
      <h2>${escapeHtml(project.label)} <small>${project.viewport} CSS px @${project.dpr}x</small></h2>
      <div class="grid">${cards}</div>
    </section>`;
  }).join('\n');
  const projectLinks = projects.map(project => `<a href="#${project.id}">${escapeHtml(project.label)}</a>`).join(' · ');
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>EJS 3 视觉基线证据索引</title>
<style>
:root{font-family:system-ui,sans-serif;color:#1f2937;background:#f8fafc}body{max-width:1800px;margin:auto;padding:24px}header{position:sticky;top:0;z-index:2;background:#fff;border:1px solid #dbe3ee;border-radius:12px;padding:16px;box-shadow:0 4px 20px #0f172a14}h1{margin:0 0 8px}h2{margin-top:40px}small{font-weight:400;color:#64748b}.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:16px}.card{background:#fff;border:1px solid #dbe3ee;border-radius:10px;padding:12px}.card h3{font-size:1rem;margin:0 0 10px}.card img{display:block;width:100%;height:220px;object-fit:contain;object-position:top;background:#eef2f7;border:1px solid #e2e8f0}.card p,.card nav{font-size:.85rem}a{color:#0366d6}code{background:#eef2f7;padding:2px 5px;border-radius:4px}
</style></head><body>
<header><h1>EJS 3.1.10 基线证据</h1><p>17 份 HTML · 102 份 layout/style · 102 张 full-page PNG；6 个设备项目。所有文件由 <code>baseline-manifest.json</code> 锁定 SHA-256。</p><nav>${projectLinks}</nav></header>
${sections}
</body></html>`;
}

async function main() {
  if (process.env[baselineWriteFlag] !== '1') {
    throw new Error(`${baselineWriteFlag}=1 is required to write baseline evidence.`);
  }
  if (installedEjsVersion !== BASELINE_EJS_VERSION) {
    throw new Error(`Baseline evidence requires ejs@${BASELINE_EJS_VERSION}; found ejs@${installedEjsVersion}.`);
  }
  const entries = await buildEntries();
  const manifest = buildManifest(entries);
  fs.writeFileSync(path.join(visualRoot, 'baseline-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  fs.writeFileSync(path.join(visualRoot, 'baseline-index.html'), buildIndex(entries));
  console.log(`Indexed ${manifest.htmlSnapshotCount} HTML, ${manifest.layoutSnapshotCount} layout, and ${manifest.imageSnapshotCount} PNG baselines.`);
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});

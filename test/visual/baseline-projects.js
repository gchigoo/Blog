// The configured visual device matrix used by the EJS baseline evidence.
// Expected baseline counts are derived from scenarios.length × this list (see
// verify-baseline-manifest.js and generate-baseline-evidence.js) instead of
// hard-coded totals.
const projects = Object.freeze([
  { id: 'desktop-1080p', label: 'Desktop 1080p', viewport: '1920×1080', dpr: 1 },
  { id: 'desktop-2k', label: 'Desktop 2K / QHD', viewport: '2560×1440', dpr: 1 },
  { id: 'desktop-4k', label: 'Desktop 4K', viewport: '3840×2160', dpr: 1 },
  { id: 'iphone-17', label: 'iPhone 17', viewport: '402×874', dpr: 3 },
  { id: 'iphone-air', label: 'iPhone Air', viewport: '420×912', dpr: 3 },
  { id: 'iphone-17-pro-max', label: 'iPhone 17 Pro Max', viewport: '440×956', dpr: 3 }
]);

module.exports = { projects };

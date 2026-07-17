const CONTROL_OR_FORMAT = /[\p{Cc}\p{Cf}]/gu;

function visibleCodePoint(character) {
  return `\\u{${character.codePointAt(0).toString(16).toUpperCase()}}`;
}

function formatAnalyticsPath(rawPath) {
  const raw = typeof rawPath === 'string' ? rawPath : String(rawPath ?? '');
  let candidate;
  let displayPathStatus;
  try {
    candidate = decodeURI(raw);
    displayPathStatus = candidate === raw ? 'raw' : 'decoded';
  } catch {
    candidate = raw;
    displayPathStatus = 'raw_invalid_encoding';
  }
  const displayPath = candidate.normalize('NFC').replace(CONTROL_OR_FORMAT, visibleCodePoint);
  return { displayPath, displayPathStatus };
}

module.exports = { formatAnalyticsPath };

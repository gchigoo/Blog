const CONTROL_OR_FORMAT = /[\p{Cc}\p{Cf}]/gu;
// Query/fragment boundary: a literal `?`/`#` or its percent-encoded forms.
// Scanning the raw stored string distinguishes a real boundary (`%3F`/`%23`)
// from the double-encoded `%253F`, which is literal `%3F` text, not a
// delimiter.
const QUERY_FRAGMENT_BOUNDARY = /[?#]|%3[fF]|%23/;

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

/**
 * The pathname used for every Analytics label. A stored path may carry a
 * query/fragment payload literally (`?…`, `#…`) or percent-encoded
 * (`%3F…`, `%23…`); decodeURI preserves those reserved bytes, so the
 * boundary is found on the raw string first. The payload is stripped before
 * any decoding, then the remaining pathname is decoded. Double-encoded
 * `%253F` is literal text and never treated as a boundary. Invalid encodings
 * fall back to the raw path portion. Stored fields are never rewritten.
 */
function presentationPathname(rawPath) {
  if (typeof rawPath !== 'string') return null;
  const boundary = rawPath.search(QUERY_FRAGMENT_BOUNDARY);
  const withoutPayload = boundary === -1 ? rawPath : rawPath.slice(0, boundary);
  try {
    return decodeURI(withoutPayload);
  } catch {
    return withoutPayload;
  }
}

/**
 * Format a stored path for presentation labels: same NFC/control-char
 * handling as formatAnalyticsPath, applied to the query/fragment-free
 * presentation pathname. Shared by event page labels, the overview ranking
 * table, and the item-level list/detail API so every label follows the same
 * contract and never exposes query/fragment payload text.
 */
function formatPresentationPath(rawPath) {
  return formatAnalyticsPath(presentationPathname(rawPath));
}

module.exports = {
  formatAnalyticsPath,
  formatPresentationPath,
  presentationPathname
};

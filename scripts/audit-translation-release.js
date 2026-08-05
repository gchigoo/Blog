#!/usr/bin/env node
'use strict';

const { createHash } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const Database = require('better-sqlite3');
const matter = require('gray-matter');
const MarkdownIt = require('markdown-it');
const { SAFE_SLUG_PATTERN } = require('../server/utils/path-security');
const markdownUtils = require('../server/utils/markdown');

const ALLOWED_ENGLISH_CJK_LITERALS = Object.freeze([]);
const MANIFEST_TOP_LEVEL_KEYS = Object.freeze(['version', 'articles']);
const MANIFEST_ARTICLE_KEYS = Object.freeze([
  'translationKey',
  'zhSlug',
  'enSlug',
  'enTitle',
  'description',
  'date',
  'tags'
]);
const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const SHA_LINE_PATTERN = /^([a-f0-9]{64}) {2}([^\r\n]+)$/;
const STRUCTURE_MARKDOWN = new MarkdownIt({ html: false, linkify: true });
const CHECK_NAMES = Object.freeze([
  'releaseManifest',
  'bundleIntegrity',
  'englishMetadata',
  'sourceArchives',
  'images',
  'externalUrls',
  'lists',
  'fencedCode',
  'tableShapes',
  'headingLevels',
  'technicalTokens',
  'cjkProse',
  'rawHtml',
  'databaseCounts',
  'databaseFiles',
  'siblings'
]);
const EXPECTED_RELEASE_ARTICLE_COUNT = 4;
const EXIT_AUDIT_FAILURE = 2;
const EXIT_USAGE_OR_RUNTIME = 1;

class TranslationAuditContentError extends Error {}

function contentError(message) {
  throw new TranslationAuditContentError(message);
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function assertExactKeys(value, expectedKeys, context) {
  for (const key of Object.keys(value)) {
    if (!expectedKeys.includes(key)) {
      contentError(`unknown key ${JSON.stringify(key)} in ${context}`);
    }
  }
  for (const key of expectedKeys) {
    if (!Object.hasOwn(value, key)) {
      contentError(`missing key ${JSON.stringify(key)} in ${context}`);
    }
  }
}

function deepFreeze(value) {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function validateRequiredString(value, context) {
  if (typeof value !== 'string' || value.trim() === '') {
    contentError(`${context} must not be empty`);
  }
  if (value !== value.trim()) {
    contentError(`${context} must not have surrounding whitespace`);
  }
  return value;
}

function validateSafeSlug(value, context) {
  validateRequiredString(value, context);
  if (!SAFE_SLUG_PATTERN.test(value)) contentError(`unsafe ${context}: ${JSON.stringify(value)}`);
  return value;
}

function validateManifestArticle(value, index, seen) {
  const context = `release article ${index + 1}`;
  if (!isPlainObject(value)) contentError(`${context} must be an object`);
  if (Object.hasOwn(value, 'locale') && !['zh', 'en'].includes(value.locale)) {
    contentError(`unsupported locale: ${String(value.locale)}`);
  }
  assertExactKeys(value, MANIFEST_ARTICLE_KEYS, context);

  const translationKey = validateSafeSlug(value.translationKey, 'translationKey');
  const zhSlug = validateSafeSlug(value.zhSlug, 'zhSlug');
  const enSlug = validateSafeSlug(value.enSlug, 'enSlug');
  const enTitle = validateRequiredString(value.enTitle, `${context} enTitle`);
  const description = validateRequiredString(value.description, `${context} description`);
  if (description.length > 300) contentError(`${context} description exceeds 300 characters`);

  const date = validateRequiredString(value.date, `${context} date`);
  const parsedDate = new Date(date);
  if (
    !ISO_DATE_PATTERN.test(date)
    || Number.isNaN(parsedDate.getTime())
    || parsedDate.toISOString() !== date
  ) {
    contentError(`${context} date must be a canonical ISO date`);
  }

  if (!Array.isArray(value.tags) || value.tags.length === 0) {
    contentError(`${context} tags must be a non-empty array`);
  }
  const tags = [];
  const seenTags = new Set();
  for (const tag of value.tags) {
    validateSafeSlug(tag, `${context} tag`);
    if (tag.startsWith('legacy-')) contentError(`${context} contains legacy tag ${JSON.stringify(tag)}`);
    if (seenTags.has(tag)) contentError(`${context} contains duplicate tag ${JSON.stringify(tag)}`);
    seenTags.add(tag);
    tags.push(tag);
  }

  for (const [label, candidate] of [
    ['translationKey', translationKey],
    ['zhSlug', zhSlug],
    ['enSlug', enSlug]
  ]) {
    if (seen[label].has(candidate)) contentError(`duplicate ${label}: ${candidate}`);
    seen[label].add(candidate);
  }

  return { translationKey, zhSlug, enSlug, enTitle, description, date, tags };
}

/**
 * Load and validate the tracked release manifest.
 *
 * @param {string} releasePath
 * @returns {{version: 1, articles: Array<{translationKey: string, zhSlug: string,
 *   enSlug: string, enTitle: string, description: string, date: string, tags: string[]}>}}
 */
function loadReleaseManifest(releasePath) {
  const raw = fs.readFileSync(releasePath, 'utf8');
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    contentError(`release manifest is not valid JSON: ${error.message}`);
  }
  if (!isPlainObject(parsed)) contentError('release manifest must be an object');
  assertExactKeys(parsed, MANIFEST_TOP_LEVEL_KEYS, 'release manifest');
  if (parsed.version !== 1) contentError('release manifest version must be 1');
  if (!Array.isArray(parsed.articles)) contentError('release manifest articles must be an array');
  const seen = {
    translationKey: new Set(),
    zhSlug: new Set(),
    enSlug: new Set()
  };
  const articles = parsed.articles.map((article, index) => validateManifestArticle(article, index, seen));
  return deepFreeze({ version: 1, articles });
}

function sha256File(filePath) {
  return createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function validateBundleFilename(filename) {
  if (path.basename(filename) !== filename || filename.includes('/') || filename.includes('\\')) {
    contentError(`unsafe basename in SHA256SUMS: ${JSON.stringify(filename)}`);
  }
  if (!filename.endsWith('.md')) contentError(`SHA256SUMS entry is not Markdown: ${filename}`);
  const slug = filename.slice(0, -3);
  if (!SAFE_SLUG_PATTERN.test(slug)) contentError(`unsafe basename in SHA256SUMS: ${JSON.stringify(filename)}`);
}

/**
 * Validate a flat release bundle and return its signed Markdown entries.
 *
 * @param {string} bundleDir
 * @returns {Map<string, string>}
 */
function loadShaManifest(bundleDir) {
  const bundleStat = fs.lstatSync(bundleDir);
  if (bundleStat.isSymbolicLink()) contentError('bundle root must not be a symlink');
  if (!bundleStat.isDirectory()) contentError('bundle root must be a directory');
  const shaPath = path.join(bundleDir, 'SHA256SUMS');
  const shaStat = fs.lstatSync(shaPath);
  if (shaStat.isSymbolicLink()) contentError('SHA256SUMS must not be a symlink');
  if (!shaStat.isFile()) contentError('SHA256SUMS must be a regular file');

  const raw = fs.readFileSync(shaPath, 'utf8');
  const lines = raw.split(/\r?\n/);
  if (lines.at(-1) === '') lines.pop();
  if (lines.length === 0 || lines.some(line => line === '')) {
    contentError('SHA256SUMS must contain non-empty records');
  }

  const parsedLines = [];
  for (const [index, line] of lines.entries()) {
    const match = SHA_LINE_PATTERN.exec(line);
    if (!match) contentError(`invalid SHA256SUMS hash record on line ${index + 1}`);
    const [, hash, filename] = match;
    validateBundleFilename(filename);
    parsedLines.push({ hash, filename });
  }

  const filenames = parsedLines.map(record => record.filename);
  const sortedFilenames = [...filenames].sort(compareStrings);
  if (!arraysEqual(filenames, sortedFilenames)) contentError('SHA256SUMS entries must be sorted by filename');

  const hashes = new Map();
  for (const { hash, filename } of parsedLines) {
    if (hashes.has(filename)) contentError(`duplicate SHA256SUMS entry: ${filename}`);
    hashes.set(filename, hash);
  }

  const entries = fs.readdirSync(bundleDir, { withFileTypes: true }).sort((left, right) => compareStrings(left.name, right.name));
  for (const entry of entries) {
    if (entry.name.startsWith('.')) contentError(`hidden file is not allowed in bundle: ${entry.name}`);
    const entryPath = path.join(bundleDir, entry.name);
    const stat = fs.lstatSync(entryPath);
    if (stat.isSymbolicLink()) contentError(`symlink is not allowed in bundle: ${entry.name}`);
    if (stat.isDirectory()) contentError(`subdirectory is not allowed in bundle: ${entry.name}`);
    if (!stat.isFile()) contentError(`non-regular bundle entry is not allowed: ${entry.name}`);
    if (entry.name !== 'SHA256SUMS' && !hashes.has(entry.name)) {
      contentError(`extra file is not listed in SHA256SUMS: ${entry.name}`);
    }
  }

  for (const [filename, expectedHash] of hashes) {
    const filePath = path.join(bundleDir, filename);
    if (!fs.existsSync(filePath)) contentError(`signed Markdown file is missing: ${filename}`);
    const stat = fs.lstatSync(filePath);
    if (stat.isSymbolicLink()) contentError(`symlink is not allowed in bundle: ${filename}`);
    if (!stat.isFile()) contentError(`signed bundle entry is not a regular file: ${filename}`);
    const actualHash = sha256File(filePath);
    if (actualHash !== expectedHash) contentError(`SHA256SUMS mismatch for ${filename}`);
  }

  return hashes;
}

function compareStrings(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function arraysEqual(left, right) {
  if (left.length !== right.length) return false;
  return left.every((value, index) => value === right[index]);
}

function objectsEqual(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function sortedMultiset(values) {
  return [...values].sort(compareStrings);
}

function setsEqual(left, right) {
  if (left.size !== right.size) return false;
  for (const value of left) {
    if (!right.has(value)) return false;
  }
  return true;
}

function normalizeReferenceLabel(label) {
  return label.trim().replace(/\s+/g, ' ').toLowerCase();
}

function collectLinkDestinationRanges(markdown) {
  const records = [];
  const covered = [];
  const definitions = new Map();
  const definitionPattern = /^ {0,3}\[([^\]\r\n]+)\]:\s*(?:<([^>\r\n]+)>|(https?:\/\/\S+))/gimu;
  for (const match of markdown.matchAll(definitionPattern)) {
    covered.push([match.index, match.index + match[0].length]);
    const label = normalizeReferenceLabel(match[1]);
    const url = (match[2] || match[3]).replace(/[.,;!?]+$/u, '');
    if (!definitions.has(label)) definitions.set(label, url);
  }

  const inlinePattern = /(!?)\[[^\]\r\n]*\]\(\s*(?:<([^>\r\n]+)>|(https?:\/\/[^\s)]+))(?:\s+(?:"[^"]*"|'[^']*'|\([^)]*\)))?\s*\)/giu;
  for (const match of markdown.matchAll(inlinePattern)) {
    covered.push([match.index, match.index + match[0].length]);
    if (match[1] !== '!') records.push({ index: match.index, url: match[2] || match[3] });
  }

  const fullReferencePattern = /(!?)\[([^\]\r\n]+)\]\[([^\]\r\n]*)\]/gu;
  for (const match of markdown.matchAll(fullReferencePattern)) {
    if (covered.some(([start, end]) => match.index >= start && match.index < end)) continue;
    covered.push([match.index, match.index + match[0].length]);
    const label = normalizeReferenceLabel(match[3] || match[2]);
    if (match[1] !== '!' && definitions.has(label)) {
      records.push({ index: match.index, url: definitions.get(label) });
    }
  }

  const shortcutReferencePattern = /(!?)\[([^\]\r\n]+)\](?![[(])/gu;
  for (const match of markdown.matchAll(shortcutReferencePattern)) {
    if (covered.some(([start, end]) => match.index >= start && match.index < end)) continue;
    const label = normalizeReferenceLabel(match[2]);
    if (!definitions.has(label)) continue;
    covered.push([match.index, match.index + match[0].length]);
    if (match[1] !== '!') records.push({ index: match.index, url: definitions.get(label) });
  }

  const autolinkPattern = /<(https?:\/\/[^<>\s]+)>/giu;
  for (const match of markdown.matchAll(autolinkPattern)) {
    if (!covered.some(([start, end]) => match.index >= start && match.index < end)) {
      covered.push([match.index, match.index + match[0].length]);
      records.push({ index: match.index, url: match[1] });
    }
  }

  const barePattern = /https?:\/\/[^\s<>()]+/giu;
  for (const match of markdown.matchAll(barePattern)) {
    if (!covered.some(([start, end]) => match.index >= start && match.index < end)) {
      records.push({ index: match.index, url: match[0].replace(/[.,;!?]+$/u, '') });
    }
  }
  records.sort((left, right) => left.index - right.index);
  return records;
}

/**
 * Return absolute HTTP(S) link destinations in document order, excluding images.
 *
 * @param {string} markdown
 * @returns {string[]}
 */
function extractExternalUrls(markdown) {
  return collectLinkDestinationRanges(String(markdown)).map(record => record.url);
}

function parseStructureTokens(markdown) {
  return STRUCTURE_MARKDOWN.parse(String(markdown), {});
}

function splitSourceLines(markdown) {
  const lines = [];
  let cursor = 0;
  while (cursor < markdown.length) {
    const start = cursor;
    while (cursor < markdown.length && markdown[cursor] !== '\n' && markdown[cursor] !== '\r') cursor += 1;
    let ending = '';
    if (markdown[cursor] === '\r' && markdown[cursor + 1] === '\n') {
      ending = '\r\n';
      cursor += 2;
    } else if (markdown[cursor] === '\r' || markdown[cursor] === '\n') {
      ending = markdown[cursor];
      cursor += 1;
    }
    lines.push({ start, end: cursor, ending });
  }
  return lines;
}

function restoreFenceLineEndings(content, sourceLines, firstBodyLine) {
  let lineIndex = firstBodyLine;
  return content.replace(/\n/g, () => {
    const ending = sourceLines[lineIndex]?.ending || '\n';
    lineIndex += 1;
    return ending;
  });
}

function scanFencedCode(markdown) {
  const sourceLines = splitSourceLines(markdown);
  const records = [];
  for (const token of parseStructureTokens(markdown)) {
    if (token.type !== 'fence' || !token.map) continue;
    const [startLine, endLine] = token.map;
    records.push({
      info: token.info.trim(),
      body: restoreFenceLineEndings(token.content, sourceLines, startLine + 1),
      start: sourceLines[startLine]?.start || 0,
      end: endLine < sourceLines.length ? sourceLines[endLine].start : markdown.length
    });
  }
  return records;
}

/**
 * Return ordered fenced code records with exact logical body bytes.
 * Container prefixes are removed by the Markdown parser; original body line
 * endings are restored from the source document.
 *
 * @param {string} markdown
 * @returns {Array<{info: string, body: string}>}
 */
function extractFencedCode(markdown) {
  return scanFencedCode(String(markdown)).map(({ info, body }) => ({ info, body }));
}

function blankRanges(value, ranges) {
  if (ranges.length === 0) return value;
  let cursor = 0;
  let result = '';
  for (const { start, end } of ranges) {
    result += value.slice(cursor, start);
    result += value.slice(start, end).replace(/[^\r\n]/g, ' ');
    cursor = end;
  }
  return result + value.slice(cursor);
}

/**
 * Return ordered Markdown table dimensions. Rows include the header row.
 *
 * @param {string} markdown
 * @returns {Array<{columns: number, rows: number}>}
 */
function extractTableShapes(markdown) {
  const shapes = [];
  let table = null;
  let columns = 0;
  for (const token of parseStructureTokens(markdown)) {
    if (token.type === 'table_open') table = { columns: 0, rows: 0 };
    else if (token.type === 'tr_open' && table) columns = 0;
    else if ((token.type === 'th_open' || token.type === 'td_open') && table) columns += 1;
    else if (token.type === 'tr_close' && table) {
      table.columns = Math.max(table.columns, columns);
      table.rows += 1;
    } else if (token.type === 'table_close' && table) {
      shapes.push(table);
      table = null;
    }
  }
  return shapes;
}

function headingLevels(markdown) {
  return parseStructureTokens(markdown)
    .filter(token => token.type === 'heading_open')
    .map(token => Number(token.tag.slice(1)));
}

function listStructure(markdown) {
  const structure = [];
  let depth = 0;
  for (const token of parseStructureTokens(markdown)) {
    if (token.type === 'bullet_list_open' || token.type === 'ordered_list_open') {
      depth += 1;
      structure.push({
        event: 'open',
        kind: token.type === 'ordered_list_open' ? 'ordered' : 'bullet',
        depth,
        start: token.type === 'ordered_list_open' ? Number(token.attrGet('start') || 1) : null
      });
    } else if (token.type === 'list_item_open') {
      structure.push({ event: 'item', depth });
    } else if (token.type === 'bullet_list_close' || token.type === 'ordered_list_close') {
      structure.push({
        event: 'close',
        kind: token.type === 'ordered_list_close' ? 'ordered' : 'bullet',
        depth
      });
      depth -= 1;
    }
  }
  return structure;
}

function imageDestinations(markdown) {
  const destinations = [];
  const visit = tokens => {
    for (const token of tokens) {
      if (token.type === 'image') destinations.push(token.attrGet('src'));
      if (token.children) visit(token.children);
    }
  };
  visit(parseStructureTokens(markdown));
  return destinations;
}

function overlapsRange(start, end, ranges) {
  return ranges.some(range => start < range.end && end > range.start);
}

function collectPatternTokens(markdown, pattern, ranges, normalize) {
  const tokens = [];
  for (const match of markdown.matchAll(pattern)) {
    const start = match.index;
    const end = start + match[0].length;
    if (overlapsRange(start, end, ranges)) continue;
    ranges.push({ start, end });
    tokens.push(normalize(match));
  }
  return tokens;
}

/**
 * Return a sorted technical-token multiset.
 *
 * @param {string} markdown
 * @returns {string[]}
 */
function extractTechnicalTokens(markdown) {
  const value = String(markdown);
  const occupied = [];
  const tokens = [];
  const patterns = [
    {
      pattern: /\b([A-Za-z][A-Za-z0-9_-]*)\s*=\s*(-?\d+(?:\.\d+)?)\b/gu,
      normalize: match => `${match[1]}=${match[2]}`
    },
    {
      pattern: /\b(?:port)\s*[:=#]?\s*(\d{1,5})\b/giu,
      normalize: match => `port:${match[1]}`
    },
    {
      pattern: /端口\s*[:=#]?\s*(\d{1,5})\b/gu,
      normalize: match => `port:${match[1]}`
    },
    {
      pattern: /\b\d+(?:\.\d+)?\s*(?:[KMGT]i?B|[KMGT]b)\/s\b/giu,
      normalize: match => match[0].replace(/\s+/g, '')
    },
    {
      pattern: /\b\d+(?:\.\d+)?\s*(?:[KMGT]bps|Mbps|Gbps)\b/giu,
      normalize: match => match[0].replace(/\s+/g, '')
    },
    {
      pattern: /\b\d+(?:\.\d+)?\s*(?:[KMGT]i?B|mAh|Ah)\b/gu,
      normalize: match => match[0].replace(/\s+/g, '')
    },
    {
      pattern: /\b\d+(?:\.\d+)?\s*(?:mV|V|mA|A|mW|W|kW)\b/gu,
      normalize: match => match[0].replace(/\s+/g, '')
    },
    {
      pattern: /\b\d+(?:\.\d+)?%/gu,
      normalize: match => match[0]
    },
    {
      pattern: /\b(?:HTTP\/\d(?:\.\d+)?|HTTPS|HTTP|USB-PD|USB PD|Quick Charge|QC|TCP|UDP|TLS|IPv4|IPv6|Wi-Fi)\b/giu,
      normalize: match => match[0].replace('USB PD', 'USB-PD')
    },
    {
      pattern: /\bv?\d+(?:\.\d+){1,3}(?:[-+][A-Za-z0-9.-]+)?\b/gu,
      normalize: match => match[0]
    },
    {
      pattern: /--[a-z][a-z0-9-]*[ =]-?\d+(?:\.\d+)?\b/giu,
      normalize: match => match[0].replace(' ', '=')
    }
  ];
  for (const { pattern, normalize } of patterns) {
    tokens.push(...collectPatternTokens(value, pattern, occupied, normalize));
  }
  return tokens.sort(compareStrings);
}

function removeInlineCode(markdown) {
  let result = '';
  let cursor = 0;
  while (cursor < markdown.length) {
    if (markdown[cursor] !== '`') {
      result += markdown[cursor];
      cursor += 1;
      continue;
    }
    let markerEnd = cursor;
    while (markdown[markerEnd] === '`') markerEnd += 1;
    const marker = markdown.slice(cursor, markerEnd);
    const closing = markdown.indexOf(marker, markerEnd);
    if (closing === -1) {
      result += marker;
      cursor = markerEnd;
      continue;
    }
    result += markdown.slice(cursor, closing + marker.length).replace(/[^\r\n]/g, ' ');
    cursor = closing + marker.length;
  }
  return result;
}

/**
 * Remove non-prose Markdown regions before untranslated-CJK scanning.
 *
 * @param {string} markdown
 * @returns {string}
 */
function stripNonProse(markdown) {
  const value = String(markdown);
  let prose = blankRanges(value, scanFencedCode(value));
  prose = removeInlineCode(prose);
  prose = prose.replace(/!?\[([^\]\r\n]*)\]\(\s*(?:<[^>\r\n]+>|[^)\r\n]+)\)/gu, '$1');
  prose = prose.replace(/^ {0,3}\[[^\]\r\n]+\]:\s*(?:<[^>\r\n]+>|\S+).*$/gmu, '');
  prose = prose.replace(/<https?:\/\/[^<>\s]+>/giu, '');
  prose = prose.replace(/https?:\/\/[^\s<>()]+/giu, '');
  prose = prose.replace(/^[ \t]*[-*_]{3,}[ \t]*$/gmu, '');
  prose = prose.replace(/[\\`*_{}()#+.!>|~:-]/gu, ' ');
  prose = prose.replaceAll('[', ' ').replaceAll(']', ' ');
  return prose;
}

function rawHtmlTags(markdown) {
  const withoutCode = removeInlineCode(blankRanges(markdown, scanFencedCode(markdown)));
  const tags = [];
  const pattern = /<(\/)?([A-Za-z][A-Za-z0-9-]*)(?=\s|\/?>)[^>]*>/gu;
  for (const match of withoutCode.matchAll(pattern)) {
    tags.push({ closing: match[1] === '/', name: match[2] });
  }
  return tags;
}

function hasEscapedRawHtml(markdown) {
  const tags = rawHtmlTags(markdown);
  if (tags.length === 0) return true;
  const rendered = markdownUtils.renderMarkdown(markdown, { locale: 'en' });
  const dangerousMarkup = /<(?:script|iframe|object|embed|svg|math|style|form|input|button|meta|link)\b|<[A-Za-z][^>]*\son[a-z]+\s*=|<[A-Za-z][^>]*(?:href|src)\s*=\s*["']?\s*javascript:/iu;
  if (dangerousMarkup.test(rendered)) return false;
  return tags.every(tag => {
    const prefix = `&lt;${tag.closing ? '/' : ''}${tag.name}`;
    return rendered.includes(prefix);
  });
}

function reportSkeleton(mode) {
  return {
    passed: false,
    mode,
    counts: {
      manifestArticles: 0,
      bundleMarkdownFiles: 0,
      posts: 0,
      articles: 0,
      zhArticles: 0,
      enArticles: 0,
      ftsRows: 0,
      sourceArchives: 0,
      publishedArchives: 0
    },
    checks: Object.fromEntries(CHECK_NAMES.map(name => [name, name === 'siblings' && mode === 'source' ? null : true])),
    errors: []
  };
}

function markFailure(report, check, message) {
  report.checks[check] = false;
  report.errors.push({ check, message });
}

function contentFailureOrThrow(error, onContentFailure) {
  if (error instanceof TranslationAuditContentError) {
    onContentFailure(error);
    return true;
  }
  return false;
}

function exactTagSet(dataTags, expectedTags) {
  const tags = Array.isArray(dataTags) ? dataTags : [];
  return tags.length === new Set(tags).size && setsEqual(new Set(tags), new Set(expectedTags));
}

function frontMatterSource(raw) {
  const opening = /^---[ \t]*\r?\n/.exec(raw);
  if (!opening) return null;
  const start = opening[0].length;
  const closing = /\r?\n---[ \t]*(?:\r?\n|$)/.exec(raw.slice(start));
  if (!closing) return null;
  return raw.slice(start, start + closing.index);
}

function decodeRawScalar(value) {
  const token = value.trim();
  try {
    if (token.startsWith('"') && token.endsWith('"')) return JSON.parse(token);
  } catch {
    return null;
  }
  if (token.startsWith("'") && token.endsWith("'")) {
    return token.slice(1, -1).replaceAll("''", "'");
  }
  return token;
}

function exactRawFrontMatterMismatches(raw, normalizedData, expected) {
  const source = frontMatterSource(raw);
  if (source === null) return ['frontMatter'];
  const rawData = matter(raw).data;
  const expectedScalars = {
    title: expected.title ?? normalizedData.title,
    slug: expected.slug,
    locale: expected.locale,
    translationKey: expected.translationKey,
    description: expected.description ?? normalizedData.description,
    date: expected.date,
    status: 'published'
  };
  const mismatches = [];
  for (const [key, expectedValue] of Object.entries(expectedScalars)) {
    if (!Object.hasOwn(rawData, key)) {
      mismatches.push(`raw-${key}`);
      continue;
    }
    const pattern = new RegExp(`^${key}[ \\t]*:[ \\t]*(.*)$`, 'm');
    const match = pattern.exec(source);
    if (!match || decodeRawScalar(match[1]) !== expectedValue) mismatches.push(`raw-${key}`);
  }
  if (!Object.hasOwn(rawData, 'tags') || !Array.isArray(rawData.tags) || !arraysEqual(rawData.tags, expected.tags)) {
    mismatches.push('raw-tags');
  }
  return mismatches;
}

function englishMetadataMismatches(data, record, raw) {
  const mismatches = exactRawFrontMatterMismatches(raw, data, {
    title: record.enTitle,
    slug: record.enSlug,
    locale: 'en',
    translationKey: record.translationKey,
    description: record.description,
    date: record.date,
    tags: record.tags
  });
  if (data.title !== record.enTitle) mismatches.push('title');
  if (data.slug !== record.enSlug) mismatches.push('slug');
  if (data.locale !== 'en') mismatches.push('locale');
  if (data.translationKey !== record.translationKey) mismatches.push('translationKey');
  if (data.date !== record.date) mismatches.push('date');
  if (data.status !== 'published') mismatches.push('status');
  if (data.description !== record.description) mismatches.push('description');
  if (!exactTagSet(data.tags, record.tags)) mismatches.push('tags');
  if (Array.isArray(data.tags) && data.tags.some(tag => tag.startsWith('legacy-'))) mismatches.push('legacy-tags');
  return mismatches;
}

function sourceMetadataMismatches(data, record, raw) {
  const mismatches = exactRawFrontMatterMismatches(raw, data, {
    slug: record.zhSlug,
    locale: 'zh',
    translationKey: record.translationKey,
    date: record.date,
    tags: record.tags
  });
  if (data.slug !== record.zhSlug) mismatches.push('slug');
  if (data.locale !== 'zh') mismatches.push('locale');
  if (data.translationKey !== record.translationKey) mismatches.push('translationKey');
  if (data.date !== record.date) mismatches.push('date');
  if (data.status !== 'published') mismatches.push('status');
  if (!exactTagSet(data.tags, record.tags)) mismatches.push('tags');
  return mismatches;
}

function pathIsWithin(root, candidate) {
  return candidate === root || candidate.startsWith(`${root}${path.sep}`);
}

function resolveSafeOwnedMarkdown(rootDir, relativeParts, label) {
  const resolvedRoot = path.resolve(rootDir);
  const rootStat = fs.lstatSync(resolvedRoot);
  if (rootStat.isSymbolicLink()) contentError(`${label} root must not be a symlink`);
  if (!rootStat.isDirectory()) contentError(`${label} root must be a directory`);
  const realRoot = fs.realpathSync(resolvedRoot);
  let current = resolvedRoot;
  for (const [index, segment] of relativeParts.entries()) {
    current = path.join(current, segment);
    if (!fs.existsSync(current)) contentError(`${label} is missing`);
    const stat = fs.lstatSync(current);
    if (stat.isSymbolicLink()) contentError(`${label} contains a symlinked path component: ${segment}`);
    const final = index === relativeParts.length - 1;
    if (!final && !stat.isDirectory()) contentError(`${label} parent component is not a directory: ${segment}`);
    if (final && !stat.isFile()) contentError(`${label} is not a regular file`);
    const realCurrent = fs.realpathSync(current);
    if (!pathIsWithin(realRoot, realCurrent)) contentError(`${label} escapes its owned root`);
  }
  return current;
}

function loadMarkdownForAudit(rootDir, relativeParts, missingCheck, invalidCheck, report, label) {
  let filePath;
  try {
    filePath = resolveSafeOwnedMarkdown(rootDir, relativeParts, label);
  } catch (error) {
    if (error instanceof TranslationAuditContentError) {
      markFailure(report, missingCheck, error.message);
      return null;
    }
    throw error;
  }
  const raw = fs.readFileSync(filePath, 'utf8');
  try {
    return { raw, parsed: markdownUtils.parseMarkdownDocument(raw) };
  } catch (error) {
    markFailure(report, invalidCheck, `${label} is invalid Markdown: ${error.message}`);
    return null;
  }
}

function compareTranslationBodies(report, record, sourceContent, englishContent) {
  const pairs = [
    ['images', sortedMultiset(imageDestinations(sourceContent)), sortedMultiset(imageDestinations(englishContent))],
    ['externalUrls', sortedMultiset(extractExternalUrls(sourceContent)), sortedMultiset(extractExternalUrls(englishContent))],
    ['lists', listStructure(sourceContent), listStructure(englishContent)],
    ['fencedCode', extractFencedCode(sourceContent), extractFencedCode(englishContent)],
    ['tableShapes', extractTableShapes(sourceContent), extractTableShapes(englishContent)],
    ['headingLevels', headingLevels(sourceContent), headingLevels(englishContent)],
    ['technicalTokens', extractTechnicalTokens(sourceContent), extractTechnicalTokens(englishContent)]
  ];
  for (const [check, sourceValue, englishValue] of pairs) {
    if (!objectsEqual(sourceValue, englishValue)) {
      markFailure(report, check, `${record.translationKey}: source and English ${check} differ`);
    }
  }

  let prose = stripNonProse(englishContent);
  for (const literal of ALLOWED_ENGLISH_CJK_LITERALS) prose = prose.split(literal).join('');
  if (/\p{Script=Han}/u.test(prose)) {
    markFailure(report, 'cjkProse', `${record.translationKey}: English prose contains untranslated CJK`);
  }

  if (!hasEscapedRawHtml(sourceContent)) {
    markFailure(report, 'rawHtml', `${record.translationKey}: source raw HTML rendered as executable markup`);
  }
}

function queryDatabaseState(db) {
  const posts = db.prepare('SELECT id, translation_key FROM posts ORDER BY id').all();
  const articles = db.prepare(`
    SELECT id, post_id, locale, title, slug, content, html, status, description, created_at
    FROM articles ORDER BY id
  `).all();
  const ftsRows = db.prepare('SELECT rowid FROM article_fts ORDER BY rowid').all();
  const tagsByArticle = new Map();
  for (const row of db.prepare('SELECT article_id, tag_id FROM article_tags ORDER BY article_id, tag_id').all()) {
    if (!tagsByArticle.has(row.article_id)) tagsByArticle.set(row.article_id, []);
    tagsByArticle.get(row.article_id).push(row.tag_id);
  }
  return { posts, articles, ftsRows, tagsByArticle };
}

function databaseFileMismatches(article, post, parsed, tagsByArticle) {
  const data = parsed.data;
  const expectedHtml = markdownUtils.renderMarkdown(parsed.content, { locale: data.locale });
  const mismatches = [];
  if (!post || post.translation_key !== data.translationKey) mismatches.push('translationKey');
  if (article.locale !== data.locale) mismatches.push('locale');
  if (article.title !== data.title) mismatches.push('title');
  if (article.slug !== data.slug) mismatches.push('slug');
  if (article.content !== parsed.content) mismatches.push('content');
  if (article.html !== expectedHtml) mismatches.push('html');
  if (article.status !== data.status) mismatches.push('status');
  if ((article.description ?? '') !== data.description) mismatches.push('description');
  if (article.created_at !== data.date) mismatches.push('date');
  const dbTags = new Set(tagsByArticle.get(article.id) || []);
  const fileTags = new Set(Array.isArray(data.tags) ? data.tags : []);
  if (!setsEqual(dbTags, fileTags)) mismatches.push('tags');
  return mismatches;
}

function validateDatabaseCounts(report, state, mode) {
  const zhArticles = state.articles.filter(article => article.locale === 'zh');
  const enArticles = state.articles.filter(article => article.locale === 'en');
  report.counts.posts = state.posts.length;
  report.counts.articles = state.articles.length;
  report.counts.zhArticles = zhArticles.length;
  report.counts.enArticles = enArticles.length;
  report.counts.ftsRows = state.ftsRows.length;

  const expectedArticles = mode === 'published' ? 8 : 4;
  const expectedEnglish = mode === 'published' ? 4 : 0;
  const expectedFts = mode === 'published' ? 8 : 4;
  const articleIds = new Set(state.articles.map(article => article.id));
  const ftsIds = new Set(state.ftsRows.map(row => Number(row.rowid)));
  if (
    state.posts.length !== 4
    || state.articles.length !== expectedArticles
    || zhArticles.length !== 4
    || enArticles.length !== expectedEnglish
    || state.ftsRows.length !== expectedFts
    || ftsIds.size !== expectedFts
    || !setsEqual(articleIds, ftsIds)
    || state.articles.some(article => article.status !== 'published')
  ) {
    markFailure(
      report,
      'databaseCounts',
      `expected posts/articles/zh/en/FTS 4/${expectedArticles}/4/${expectedEnglish}/${expectedFts}`
    );
  }
}

function assertUsageOptions(options) {
  if (!isPlainObject(options)) throw new TypeError('options must be an object');
  for (const name of ['dbPath', 'articlesDir', 'bundleDir', 'releasePath']) {
    if (typeof options[name] !== 'string' || options[name].trim() === '') {
      throw new TypeError(`${name} must be a non-empty path`);
    }
  }
  if (!['source', 'published'].includes(options.mode)) {
    throw new TypeError("mode must be 'source' or 'published'");
  }
}

/**
 * Audit one tracked English translation release without changing runtime state.
 * Content failures are accumulated in the returned report. Usage, filesystem,
 * and database-open/runtime errors throw.
 *
 * @param {{dbPath: string, articlesDir: string, bundleDir: string,
 *   releasePath: string, mode: 'source' | 'published'}} options
 * @returns {{passed: boolean, mode: string, counts: object, checks: object,
 *   errors: Array<{check: string, message: string}>}}
 */
function auditTranslationRelease(options) {
  assertUsageOptions(options);
  const report = reportSkeleton(options.mode);
  let manifest;
  try {
    manifest = loadReleaseManifest(path.resolve(options.releasePath));
  } catch (error) {
    if (!contentFailureOrThrow(error, content => {
      markFailure(report, 'releaseManifest', content.message);
    })) throw error;
    report.passed = false;
    return report;
  }
  report.counts.manifestArticles = manifest.articles.length;
  if (manifest.articles.length !== EXPECTED_RELEASE_ARTICLE_COUNT) {
    markFailure(report, 'releaseManifest', `release must contain exactly ${EXPECTED_RELEASE_ARTICLE_COUNT} articles`);
  }

  let shaManifest = null;
  try {
    shaManifest = loadShaManifest(path.resolve(options.bundleDir));
    report.counts.bundleMarkdownFiles = shaManifest.size;
    const expectedFiles = sortedMultiset(manifest.articles.map(record => `${record.enSlug}.md`));
    if (!arraysEqual([...shaManifest.keys()], expectedFiles) || shaManifest.size !== EXPECTED_RELEASE_ARTICLE_COUNT) {
      markFailure(report, 'bundleIntegrity', 'bundle filenames do not exactly match the release manifest');
    }
  } catch (error) {
    if (!contentFailureOrThrow(error, content => {
      markFailure(report, 'bundleIntegrity', content.message);
    })) throw error;
  }

  const sourceByKey = new Map();
  const englishByKey = new Map();
  for (const record of manifest.articles) {
    const source = loadMarkdownForAudit(
      path.resolve(options.articlesDir),
      ['zh', `${record.zhSlug}.md`],
      'sourceArchives',
      'sourceArchives',
      report,
      `source archive zh/${record.zhSlug}.md`
    );
    if (source) {
      report.counts.sourceArchives += 1;
      sourceByKey.set(record.translationKey, source);
      const mismatches = sourceMetadataMismatches(source.parsed.data, record, source.raw);
      if (mismatches.length > 0) {
        markFailure(report, 'sourceArchives', `${record.translationKey}: source metadata mismatch (${mismatches.join(', ')})`);
      }
    }

    if (!shaManifest || !shaManifest.has(`${record.enSlug}.md`)) continue;
    const english = loadMarkdownForAudit(
      path.resolve(options.bundleDir),
      [`${record.enSlug}.md`],
      'bundleIntegrity',
      'englishMetadata',
      report,
      `bundle archive ${record.enSlug}.md`
    );
    if (!english) continue;
    englishByKey.set(record.translationKey, english);
    const mismatches = englishMetadataMismatches(english.parsed.data, record, english.raw);
    if (mismatches.length > 0) {
      markFailure(report, 'englishMetadata', `${record.translationKey}: English metadata mismatch (${mismatches.join(', ')})`);
    }
    if (source) compareTranslationBodies(report, record, source.parsed.content, english.parsed.content);
  }

  let db;
  try {
    db = new Database(path.resolve(options.dbPath), { readonly: true, fileMustExist: true });
  } catch (error) {
    throw new Error(`cannot open database: ${error.message}`, { cause: error });
  }
  try {
    let state;
    try {
      state = queryDatabaseState(db);
    } catch (error) {
      markFailure(report, 'databaseCounts', `database audit query failed: ${error.message}`);
      report.passed = false;
      return report;
    }
    validateDatabaseCounts(report, state, options.mode);
    const postsById = new Map(state.posts.map(post => [post.id, post]));
    const postsByKey = new Map();
    for (const post of state.posts) {
      if (!postsByKey.has(post.translation_key)) postsByKey.set(post.translation_key, []);
      postsByKey.get(post.translation_key).push(post);
    }

    for (const record of manifest.articles) {
      const matchingPosts = postsByKey.get(record.translationKey) || [];
      const post = matchingPosts.length === 1 ? matchingPosts[0] : null;
      const postArticles = post ? state.articles.filter(article => article.post_id === post.id) : [];
      const zhSiblings = postArticles.filter(article => article.locale === 'zh');
      const enSiblings = postArticles.filter(article => article.locale === 'en');

      if (options.mode === 'published' && (matchingPosts.length !== 1 || zhSiblings.length !== 1 || enSiblings.length !== 1)) {
        markFailure(report, 'siblings', `${record.translationKey}: expected exactly one zh and one en sibling`);
      }
      if (options.mode === 'source' && (matchingPosts.length !== 1 || zhSiblings.length !== 1)) {
        markFailure(report, 'databaseFiles', `${record.translationKey}: expected exactly one source database article`);
      }

      const source = sourceByKey.get(record.translationKey);
      if (source && zhSiblings.length === 1) {
        const mismatches = databaseFileMismatches(zhSiblings[0], postsById.get(zhSiblings[0].post_id), source.parsed, state.tagsByArticle);
        if (mismatches.length > 0) {
          markFailure(report, 'databaseFiles', `${record.translationKey}: source database/file mismatch (${mismatches.join(', ')})`);
        }
      } else if (zhSiblings.length !== 1) {
        markFailure(report, 'databaseFiles', `${record.translationKey}: source database/file pair is incomplete`);
      }

      if (options.mode !== 'published') continue;
      const englishBundle = englishByKey.get(record.translationKey);
      const published = loadMarkdownForAudit(
        path.resolve(options.articlesDir),
        ['en', `${record.enSlug}.md`],
        'databaseFiles',
        'databaseFiles',
        report,
        `published archive en/${record.enSlug}.md`
      );
      if (published) {
        report.counts.publishedArchives += 1;
        if (!englishBundle || published.raw !== englishBundle.raw) {
          markFailure(report, 'databaseFiles', `${record.translationKey}: published English file differs from the signed bundle`);
        }
        const metadataMismatches = englishMetadataMismatches(published.parsed.data, record, published.raw);
        if (metadataMismatches.length > 0) {
          markFailure(report, 'databaseFiles', `${record.translationKey}: published English metadata mismatch (${metadataMismatches.join(', ')})`);
        }
      }
      if (published && enSiblings.length === 1) {
        const mismatches = databaseFileMismatches(enSiblings[0], postsById.get(enSiblings[0].post_id), published.parsed, state.tagsByArticle);
        if (mismatches.length > 0) {
          markFailure(report, 'databaseFiles', `${record.translationKey}: English database/file mismatch (${mismatches.join(', ')})`);
        }
      } else if (enSiblings.length !== 1) {
        markFailure(report, 'databaseFiles', `${record.translationKey}: English database/file pair is incomplete`);
      }
    }
  } finally {
    db.close();
  }

  report.passed = report.errors.length === 0;
  return report;
}

function cliErrorReport(mode, check, message) {
  const report = reportSkeleton(mode);
  report.checks[check] = false;
  report.errors.push({ check, message });
  return report;
}

function parseCliArgs(argv) {
  const allowed = new Set(['--db', '--articles', '--release', '--bundle', '--mode']);
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!allowed.has(flag)) throw new TypeError(`unknown flag: ${flag || '(missing)'}`);
    if (value === undefined || value.startsWith('--')) throw new TypeError(`missing value for ${flag}`);
    if (values.has(flag)) throw new TypeError(`duplicate flag: ${flag}`);
    values.set(flag, value);
  }
  const cwd = process.cwd();
  const release = values.get('--release');
  const bundle = values.get('--bundle');
  const mode = values.get('--mode');
  if (!release) throw new TypeError('--release is required');
  if (!bundle) throw new TypeError('--bundle is required');
  if (!mode) throw new TypeError('--mode is required');
  if (!['source', 'published'].includes(mode)) throw new TypeError("--mode must be 'source' or 'published'");
  return {
    dbPath: path.resolve(values.get('--db') || path.join(cwd, 'blog.db')),
    articlesDir: path.resolve(values.get('--articles') || path.join(cwd, 'articles')),
    releasePath: path.resolve(release),
    bundleDir: path.resolve(bundle),
    mode
  };
}

function printJson(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function main() {
  let options;
  try {
    options = parseCliArgs(process.argv.slice(2));
  } catch (error) {
    printJson(cliErrorReport(null, 'usage', error.message));
    process.exitCode = EXIT_USAGE_OR_RUNTIME;
    return;
  }
  try {
    const report = auditTranslationRelease(options);
    printJson(report);
    process.exitCode = report.passed ? 0 : EXIT_AUDIT_FAILURE;
  } catch (error) {
    printJson(cliErrorReport(options.mode, 'runtime', error.message));
    process.exitCode = EXIT_USAGE_OR_RUNTIME;
  }
}

if (require.main === module) main();

module.exports = {
  ALLOWED_ENGLISH_CJK_LITERALS,
  auditTranslationRelease,
  extractExternalUrls,
  extractFencedCode,
  extractTableShapes,
  extractTechnicalTokens,
  loadReleaseManifest,
  loadShaManifest,
  stripNonProse
};

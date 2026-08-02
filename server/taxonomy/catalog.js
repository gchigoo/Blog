const fs = require('node:fs');
const path = require('node:path');
const { SUPPORTED_LOCALES } = require('../i18n/config');

const TAXONOMY_VERSION = 1;
const SYSTEM_CATEGORY_ID = 'uncategorized';
const SYSTEM_TAG_ID = 'other';
const MAX_SEGMENT_CODE_POINTS = 80;

const CATALOG_KEYS = ['version', 'categories'];
const CATEGORY_KEYS = ['id', 'sortOrder', 'labels', 'tags'];
const TAG_KEYS = ['id', 'sortOrder', 'labels', 'legacyNames'];
const LABEL_KEYS = ['name', 'slug'];
const ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const FORBIDDEN_SEGMENT_PATTERN = /[/\\?%#]/;

function hasControlCharacters(value) {
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (codePoint < 0x20 || codePoint === 0x7f) return true;
  }
  return false;
}

function deepFreeze(value) {
  if (typeof value !== 'object' || value === null) return value;
  for (const key of Object.getOwnPropertyNames(value)) {
    deepFreeze(value[key]);
  }
  return Object.freeze(value);
}

function rejectUnknownKeys(object, allowed, where) {
  for (const key of Object.keys(object)) {
    if (!allowed.includes(key)) {
      throw new Error(`unknown key "${key}" in ${where}`);
    }
  }
}

function validateSegment(value, label = 'segment') {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
  if (value !== value.trim()) {
    throw new Error(`${label} must not have leading or trailing whitespace`);
  }
  if (value === '.' || value === '..') {
    throw new Error(`${label} must not be '.' or '..'`);
  }
  if (FORBIDDEN_SEGMENT_PATTERN.test(value)) {
    throw new Error(`${label} contains forbidden characters (/, \\, ?, #, %)`);
  }
  if (hasControlCharacters(value)) {
    throw new Error(`${label} contains control characters`);
  }
  if ([...value].length > MAX_SEGMENT_CODE_POINTS) {
    throw new Error(`${label} exceeds ${MAX_SEGMENT_CODE_POINTS} code points`);
  }
  return value;
}

function isSegmentValid(value) {
  try {
    validateSegment(value);
    return true;
  } catch {
    return false;
  }
}

function validateIdentifier(value, where) {
  if (typeof value !== 'string' || !ID_PATTERN.test(value)) {
    throw new Error(`invalid ${where}: ${JSON.stringify(value)}`);
  }
  return value;
}

function validateSortOrder(value, where) {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new Error(`${where} sortOrder must be a non-negative integer`);
  }
  return value;
}

function validateLabels(labels, where, slugsByLocale, namespace) {
  if (typeof labels !== 'object' || labels === null || Array.isArray(labels)) {
    throw new Error(`${where} must have zh and en labels`);
  }
  rejectUnknownKeys(labels, SUPPORTED_LOCALES, `${where} labels`);
  for (const locale of SUPPORTED_LOCALES) {
    const label = labels[locale];
    if (typeof label !== 'object' || label === null) {
      throw new Error(`${where} is missing ${locale} labels`);
    }
    rejectUnknownKeys(label, LABEL_KEYS, `${where} ${locale} labels`);
    if (typeof label.name !== 'string' || label.name.trim() === '') {
      throw new Error(`${where} ${locale} name must not be empty`);
    }
    validateSegment(label.slug, `${where} ${locale} slug`);
    const slugSet = slugsByLocale.get(locale);
    if (slugSet.has(label.slug)) {
      throw new Error(`duplicate ${locale} slug "${label.slug}" in ${namespace}`);
    }
    slugSet.add(label.slug);
  }
}

function validateTaxonomyCatalog(value) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('taxonomy catalog must be an object');
  }
  rejectUnknownKeys(value, CATALOG_KEYS, 'taxonomy catalog');
  if (value.version !== TAXONOMY_VERSION) {
    throw new Error(`taxonomy version must be ${TAXONOMY_VERSION}`);
  }
  if (!Array.isArray(value.categories)) {
    throw new Error('taxonomy categories must be an array');
  }

  const categoryIds = new Set();
  const tagIds = new Set();
  const categorySlugs = new Map(SUPPORTED_LOCALES.map(locale => [locale, new Set()]));
  const tagSlugs = new Map(SUPPORTED_LOCALES.map(locale => [locale, new Set()]));
  let hasUncategorizedCategory = false;
  let hasSystemTag = false;

  for (const category of value.categories) {
    if (typeof category !== 'object' || category === null || Array.isArray(category)) {
      throw new Error('each taxonomy category must be an object');
    }
    rejectUnknownKeys(category, CATEGORY_KEYS, 'taxonomy category');
    const categoryId = validateIdentifier(category.id, 'category id');
    if (categoryIds.has(categoryId)) {
      throw new Error(`duplicate category id: ${categoryId}`);
    }
    categoryIds.add(categoryId);
    validateSortOrder(category.sortOrder, `category ${categoryId}`);
    validateLabels(category.labels, `category ${categoryId}`, categorySlugs, 'categories');
    if (categoryId === SYSTEM_CATEGORY_ID) {
      hasUncategorizedCategory = true;
    }

    const tags = category.tags === undefined ? [] : category.tags;
    if (!Array.isArray(tags)) {
      throw new Error(`category ${categoryId} tags must be an array`);
    }
    for (const tag of tags) {
      if (typeof tag !== 'object' || tag === null || Array.isArray(tag)) {
        throw new Error(`each tag in category ${categoryId} must be an object`);
      }
      rejectUnknownKeys(tag, TAG_KEYS, 'taxonomy tag');
      const tagId = validateIdentifier(tag.id, 'tag id');
      if (tagIds.has(tagId)) {
        throw new Error(`duplicate tag id: ${tagId}`);
      }
      tagIds.add(tagId);
      validateSortOrder(tag.sortOrder, `tag ${tagId}`);
      validateLabels(tag.labels, `tag ${tagId}`, tagSlugs, 'tags');

      const legacyNames = tag.legacyNames === undefined ? [] : tag.legacyNames;
      if (!Array.isArray(legacyNames)) {
        throw new Error(`tag ${tagId} legacyNames must be an array`);
      }
      const seen = new Set();
      for (const legacyName of legacyNames) {
        validateSegment(legacyName, `legacy name for tag ${tagId}`);
        if (seen.has(legacyName)) {
          throw new Error(`duplicate legacy name: ${legacyName}`);
        }
        seen.add(legacyName);
      }

      if (categoryId === SYSTEM_CATEGORY_ID && tagId === SYSTEM_TAG_ID) {
        hasSystemTag = true;
      }
    }
  }

  if (!hasUncategorizedCategory) {
    throw new Error('taxonomy catalog must include the uncategorized category');
  }
  if (!hasSystemTag) {
    throw new Error('taxonomy catalog must include the uncategorized/other system tag');
  }

  return deepFreeze(value);
}

function loadTaxonomyCatalog(filePath) {
  if (typeof filePath !== 'string' || filePath === '') {
    throw new Error('taxonomy catalog file path is required');
  }
  const absolutePath = path.resolve(filePath);
  let raw;
  try {
    raw = fs.readFileSync(absolutePath, 'utf8');
  } catch (error) {
    throw new Error(`cannot read taxonomy catalog at ${absolutePath}: ${error.message}`, { cause: error });
  }
  let parsed;
  try {
    parsed = JSON.parse(raw.replace(/^\uFEFF/, ''));
  } catch (error) {
    throw new Error(`taxonomy catalog at ${absolutePath} is not valid JSON: ${error.message}`, { cause: error });
  }
  return validateTaxonomyCatalog(parsed);
}

module.exports = {
  TAXONOMY_VERSION,
  SYSTEM_CATEGORY_ID,
  SYSTEM_TAG_ID,
  MAX_SEGMENT_CODE_POINTS,
  validateSegment,
  isSegmentValid,
  validateTaxonomyCatalog,
  loadTaxonomyCatalog
};

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const {
  loadTaxonomyCatalog,
  validateTaxonomyCatalog,
  validateSegment
} = require('../server/taxonomy/catalog');
const { encodePathSegment } = require('../server/i18n/request');

const root = path.resolve(__dirname, '..');
const SHIPPED_CATALOG = path.join(root, 'content', 'taxonomy.json');

function baseCatalog() {
  return {
    version: 1,
    categories: [
      {
        id: 'technology',
        sortOrder: 30,
        labels: {
          zh: { name: '技术', slug: '技术' },
          en: { name: 'Technology', slug: 'technology' }
        },
        tags: [
          {
            id: 'nodejs',
            sortOrder: 10,
            labels: {
              zh: { name: 'Node.js', slug: 'Node.js' },
              en: { name: 'Node.js', slug: 'nodejs' }
            },
            legacyNames: ['Node']
          }
        ]
      },
      {
        id: 'uncategorized',
        sortOrder: 90,
        labels: {
          zh: { name: '其他', slug: '其他' },
          en: { name: 'Other', slug: 'other' }
        },
        tags: [
          {
            id: 'other',
            sortOrder: 10,
            labels: {
              zh: { name: '未分类', slug: '未分类' },
              en: { name: 'Uncategorized', slug: 'uncategorized' }
            },
            legacyNames: []
          }
        ]
      }
    ]
  };
}

function expectInvalid(mutate, expected) {
  const fixture = baseCatalog();
  mutate(fixture);
  assert.throws(() => validateTaxonomyCatalog(fixture), expected);
}

test('ships a taxonomy catalog that validates and contains the required entries', () => {
  assert.ok(fs.existsSync(SHIPPED_CATALOG), 'content/taxonomy.json must exist');
  const catalog = loadTaxonomyCatalog(SHIPPED_CATALOG);
  assert.equal(catalog.version, 1);
  assert.deepEqual(catalog.categories.map(category => category.id), [
    'news', 'life', 'technology', 'uncategorized'
  ]);
  const systemTag = catalog.categories
    .find(category => category.id === 'uncategorized').tags[0];
  assert.equal(systemTag.id, 'other');
  assert.equal(systemTag.labels.zh.name, '未分类');
  assert.equal(systemTag.labels.en.slug, 'uncategorized');
  const expectedPromotedTags = {
    productivity: ['life', '效率', 'Productivity', ['效率']],
    app: ['technology', 'App', 'App', ['App']],
    utm: ['technology', 'UTM', 'UTM', ['UTM']],
    'smart-home': ['technology', '智能家居', 'Smart Home', ['智能家居']],
    'home-assistant': ['technology', 'Home Assistant', 'Home Assistant', ['Home Assistant']],
    ios: ['technology', 'iOS', 'iOS', ['iOS']],
    iphone: ['technology', 'iPhone', 'iPhone', ['iPhone']],
    apple: ['technology', '苹果', 'Apple', ['苹果']],
    tools: ['technology', '工具', 'Tools', ['工具']],
    tampermonkey: ['technology', 'Tampermonkey', 'Tampermonkey', ['Tampermonkey']],
    tutorials: ['technology', '教程', 'Tutorials', ['教程']],
    charging: ['technology', '充电', 'Charging', ['充电']],
    explainers: ['technology', '科普', 'Explainers', ['科普']],
    'baidu-netdisk': ['technology', '百度网盘', 'Baidu Netdisk', ['百度网盘']],
    'mac-mini': ['technology', 'Mac mini', 'Mac mini', ['Mac mini']],
    idm: ['technology', 'IDM', 'IDM', ['IDM']],
    'consumer-electronics': ['technology', '数码', 'Consumer Electronics', ['数码']],
    homekit: ['technology', 'HomeKit', 'HomeKit', ['HomeKit']]
  };
  const actual = Object.fromEntries(catalog.categories.flatMap(category =>
    category.tags.map(tag => [tag.id, [
      category.id,
      tag.labels.zh.name,
      tag.labels.en.name,
      tag.legacyNames
    ]])
  ));
  for (const [id, expected] of Object.entries(expectedPromotedTags)) {
    assert.deepEqual(actual[id], expected, id);
  }
});

test('accepts the canonical taxonomy shape', () => {
  const catalog = validateTaxonomyCatalog(baseCatalog());
  assert.deepEqual(catalog.categories.map(category => category.id), ['technology', 'uncategorized']);
});

test('rejects duplicate category ids', () => {
  expectInvalid(catalog => {
    catalog.categories[1].id = 'technology';
  }, /duplicate category id: technology/);
});

test('rejects duplicate tag ids and tags declared under two categories', () => {
  expectInvalid(catalog => {
    catalog.categories[1].tags.push({ ...catalog.categories[0].tags[0] });
  }, /duplicate tag id: nodejs/);
});

test('rejects duplicate localized slugs within one locale', () => {
  expectInvalid(catalog => {
    catalog.categories[1].labels.zh.slug = '技术';
  }, /duplicate zh slug/);
  expectInvalid(catalog => {
    catalog.categories[1].tags[0].labels.en.slug = 'nodejs';
  }, /duplicate en slug/);
});

test('rejects categories or tags missing zh or en labels', () => {
  expectInvalid(catalog => {
    delete catalog.categories[0].labels.zh;
  }, /missing zh labels/);
  expectInvalid(catalog => {
    delete catalog.categories[0].labels.en;
  }, /missing en labels/);
  expectInvalid(catalog => {
    delete catalog.categories[0].tags[0].labels.zh;
  }, /missing zh labels/);
  expectInvalid(catalog => {
    catalog.categories[0].labels.zh = { name: '技术' };
  }, /slug/);
});

test('rejects unknown keys at every level', () => {
  expectInvalid(catalog => {
    catalog.foo = 1;
  }, /unknown key "foo" in taxonomy catalog/);
  expectInvalid(catalog => {
    catalog.categories[0].extra = true;
  }, /unknown key "extra"/);
  expectInvalid(catalog => {
    catalog.categories[0].tags[0].aliases = [];
  }, /unknown key "aliases"/);
  expectInvalid(catalog => {
    catalog.categories[0].labels.zh.displayName = 'x';
  }, /unknown key "displayName"/);
});

test('rejects invalid category and tag ids', () => {
  for (const badId of ['', 'Node.js', '技术', 'has space', 'UPPER', '-lead', 'trail-', 'a_b', 'a/b']) {
    expectInvalid(catalog => {
      catalog.categories[0].id = badId;
    }, /invalid category id/);
    expectInvalid(catalog => {
      catalog.categories[0].tags[0].id = badId;
    }, /invalid tag id/);
  }
});

test('rejects empty localized names', () => {
  expectInvalid(catalog => {
    catalog.categories[0].labels.zh.name = '  ';
  }, /name must not be empty/);
  expectInvalid(catalog => {
    catalog.categories[0].labels.en.name = '';
  }, /name must not be empty/);
  expectInvalid(catalog => {
    catalog.categories[0].tags[0].labels.en.name = '';
  }, /name must not be empty/);
});

test('rejects duplicate legacy names', () => {
  expectInvalid(catalog => {
    catalog.categories[0].tags[0].legacyNames = ['Node', 'Node'];
  }, /duplicate legacy name: Node/);
});

test('requires the uncategorized/other system entries', () => {
  expectInvalid(catalog => {
    catalog.categories.pop();
  }, /uncategorized category/);
  expectInvalid(catalog => {
    catalog.categories[1].tags = [];
  }, /system tag/);
});

test('rejects unsupported versions and non-object catalogs', () => {
  assert.throws(() => validateTaxonomyCatalog({ version: 2, categories: [] }), /version must be 1/);
  assert.throws(() => validateTaxonomyCatalog(null), /must be an object/);
  assert.throws(() => validateTaxonomyCatalog([]), /must be an object/);
  assert.throws(() => validateTaxonomyCatalog('nope'), /must be an object/);
});

test('segment validator enforces the slug contract', () => {
  for (const slug of ['Node.js', 'nodejs', '技术', '生活', 'a.b.c', 'hello-world', 'hello world']) {
    assert.equal(validateSegment(slug), slug, `accepts ${JSON.stringify(slug)}`);
  }
  const invalid = [
    '.', '..', '/absolute', 'a/b', 'back\\slash', '?query', 'hash#', 'percent%2F',
    ' leading', 'trailing ', 'line\nbreak', 'a\u0000b', 'a\u001fb', 'a\u007fb', ''
  ];
  for (const slug of invalid) {
    assert.throws(() => validateSegment(slug), undefined, `rejects ${JSON.stringify(slug)}`);
  }
  assert.throws(() => validateSegment('x'.repeat(81)), /80 code points/);
  assert.equal(validateSegment('x'.repeat(80)), 'x'.repeat(80));
});

test('encodePathSegment encodes exactly once and rejects already-encoded input', () => {
  assert.equal(encodePathSegment('技术'), '%E6%8A%80%E6%9C%AF');
  assert.equal(encodePathSegment('Node.js'), 'Node.js');
  assert.equal(encodePathSegment('hello world'), 'hello%20world');
  assert.throws(() => encodePathSegment('foo%20bar'), /forbidden/);
  assert.throws(() => encodePathSegment(encodePathSegment('技术')), /forbidden/);
  assert.throws(() => encodePathSegment('../up'), /forbidden/);
  assert.throws(() => encodePathSegment('a?b'), /forbidden/);
  assert.throws(() => encodePathSegment('a#b'), /forbidden/);
  assert.throws(() => encodePathSegment(''), /non-empty/);
});

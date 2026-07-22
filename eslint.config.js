const js = require('@eslint/js');
const globals = require('globals');

module.exports = [
  {
    ignores: [
      'node_modules/**',
      'test/visual/__snapshots__/**',
      'test-results/**',
      'public/images/**',
      'articles/**',
      'backups/**'
    ]
  },
  {
    files: ['**/*.js'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'commonjs',
      globals: {
        ...globals.node,
        ...globals.es2025
      }
    },
    rules: js.configs.recommended.rules
  },
  {
    files: ['public/js/**/*.js'],
    languageOptions: {
      sourceType: 'script',
      globals: globals.browser
    }
  }
];

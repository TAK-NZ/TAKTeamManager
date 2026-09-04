'use strict';

const js = require('@eslint/js');
const globals = require('globals');

// Flat ESLint config (ESLint 10.x) scoped to the Node/Express backend
// (`server/`, including `server/workers/`) plus root-level scripts.
// The React client (`client/`) has its own build tooling and is
// intentionally not linted from this config.
module.exports = [
  {
    ignores: [
      'node_modules/**',
      'client/**',
      'database/migrations/**',
      'coverage/**',
    ],
  },
  js.configs.recommended,
  {
    // This config file is itself linted (it matches no `ignores` pattern
    // above), and runs under Node/CommonJS just like the rest of the
    // files below -- without its own languageOptions it fell back to
    // ESLint's default (browser-less, Node-less) globals, so its own
    // top-level `require`/`module` flagged as undefined (no-undef).
    files: ['eslint.config.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'commonjs',
      globals: {
        ...globals.node,
      },
    },
  },
  {
    // `database/**/*.js` (not the non-recursive `database/*.js`) so a
    // file in a subdirectory -- e.g. `database/testHelpers/
    // throwawayDatabase.js` -- is actually linted rather than silently
    // skipped. `database/migrations/**` stays excluded via the
    // `ignores` block above regardless.
    files: ['server/**/*.js', 'scripts/**/*.js', 'database/**/*.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'commonjs',
      globals: {
        ...globals.node,
      },
    },
    rules: {
      // Requirement 13.8: production code must log via the structured
      // logger (server/config/logger.js), not console.*.
      'no-console': 'error',
    },
  },
  {
    // `database/**/*.test.js`/`database/**/*.integration.test.js` (e.g.
    // schemaConsistency.integration.test.js) match `database/**/*.js`
    // above but not `server/**/*.test.js`/`scripts/**/*.test.js` below, so
    // without this block they got no-console disabled but still no
    // jest globals -- describe/it/expect flagged as undefined (no-undef).
    files: ['server/**/*.test.js', 'scripts/**/*.test.js', 'database/**/*.test.js', 'database/**/*.integration.test.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'commonjs',
      globals: {
        ...globals.node,
        ...globals.jest,
      },
    },
    rules: {
      // Tests stub console.* deliberately to assert it is NOT called
      // (see authentikSync.test.js); no-console would flag those stubs.
      'no-console': 'off',
    },
  },
];

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
    files: ['server/**/*.js', 'scripts/**/*.js', 'database/*.js'],
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
    files: ['server/**/*.test.js', 'scripts/**/*.test.js'],
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

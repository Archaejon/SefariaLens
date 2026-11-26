'use strict';

const js = require('@eslint/js');
const globals = require('globals');

// Correctness rules only. Formatting is left to the people writing the code
// (see CONTRIBUTING.md); this exists to catch the mistakes a reader misses:
// an undefined name, a variable nobody reads, a case that falls through.
const rules = {
  ...js.configs.recommended.rules,
  'no-unused-vars': ['error', {
    args: 'after-used', argsIgnorePattern: '^_', caughtErrors: 'none', ignoreRestSiblings: true,
  }],
  // `let x = fallback; try { x = await ... } catch { ... }` is this codebase's
  // idiom for "use the fallback if the call fails"; the rule reads it as waste.
  'no-useless-assignment': 'off',
  'no-empty': ['error', { allowEmptyCatch: true }],
  eqeqeq: ['error', 'always', { null: 'ignore' }],
  'no-var': 'error',
  'prefer-const': ['error', { destructuring: 'all' }],
};

module.exports = [
  { ignores: ['dist/**', 'node_modules/**', '.tools/**', 'tools/appdata/**'] },
  {
    files: ['**/*.js'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'commonjs',
      globals: { ...globals.node },
    },
    rules,
  },
  {
    // The renderer is classic scripts sharing one global scope, in the order
    // index.html loads them: bridge.js, notebook.js, app.js.
    files: ['renderer/**/*.js'],
    languageOptions: {
      sourceType: 'script',
      globals: { ...globals.browser },
    },
    rules: {
      // Names defined in one file and used in another cannot be resolved file
      // by file; the syntax check and the smoke test cover the renderer.
      'no-undef': 'off',
      'no-unused-vars': ['error', {
        vars: 'local', args: 'after-used', argsIgnorePattern: '^_', caughtErrors: 'none', ignoreRestSiblings: true,
      }],
    },
  },
];

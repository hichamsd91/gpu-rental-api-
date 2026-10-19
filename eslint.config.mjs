// @see https://eslint.org/docs/latest/use/configure/configuration-assets
import js from '@eslint/js';
import globals from 'globals';

export default [
  { ignores: ['node_modules/**', '**/*.test.js'] },
  js.configs.recommended,
  {
    // Server code is CommonJS (*.js and *.cjs, including ops scripts like scripts/live-smoke.cjs); the flat
    // config file itself (.mjs) stays under plain recommended rules. Omitting .cjs here once left committed tooling
    // with 57 "no-undef" errors (console/process/fetch undefined) — every Node-global a committed script may use belongs in this block.
    files: ['**/*.js', '**/*.cjs'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'commonjs',
      globals: {
        ...globals.node
      }
    },
    rules: {
      // Match the pre-migration .eslintrc.json behaviour (kept a warning so a clean
      // run stays green while unused code is still surfaced to humans):
      'no-unused-vars': 'warn'
    }
  }
];

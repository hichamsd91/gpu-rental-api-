// @see https://eslint.org/docs/latest/use/configure/configuration-assets
import js from '@eslint/js';
import globals from 'globals';

export default [
  { ignores: ['node_modules/**', '**/*.test.js'] },
  js.configs.recommended,
  {
    // Server code is CommonJS (the only files that use require()); the flat
    // config file itself (.mjs) stays under plain recommended rules.
    files: ['**/*.js'],
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

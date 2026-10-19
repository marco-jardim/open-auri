import { defineConfig } from 'eslint/config';
import js from '@eslint/js';
import globals from 'globals';

export default defineConfig([
  {
    ignores: [
      'design/**',
      'types/**',
      'coverage/**',
      'node_modules/**',
      'web/**',
      'workers/**',
      '**/.svelte-kit/**',
      '**/.wrangler/**',
      'apps/android/android/**',
    ],
  },
  js.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: { ...globals.node, ...globals.browser },
    },
  },
]);

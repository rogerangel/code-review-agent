import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      'no-control-regex': 'off',
    },
  },
  {
    ignores: ['dist/**', 'gate-action/dist/**', 'node_modules/**', 'test/fixtures/**'],
  },
);

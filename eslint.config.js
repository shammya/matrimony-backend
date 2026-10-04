import tseslint from 'typescript-eslint';
export default tseslint.config(
  { ignores: ['dist/**', 'node_modules/**', '.dependency-cruiser.cjs'] },
  ...tseslint.configs.recommended,
  {
    files: ['src/**/*.ts', 'scripts/**/*.ts', 'test/**/*.ts'],
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    rules: {
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
      '@typescript-eslint/no-explicit-any': 'error',
    },
  },
);

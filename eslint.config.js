export default [
  { ignores: ['node_modules/**', 'dist/**', '.generated/**', '.instances/**'] },
  {
    files: ['**/*.js'],
    languageOptions: { ecmaVersion: 'latest', sourceType: 'module' },
    rules: {
      'no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      'no-undef': 'off',
      'no-constant-condition': 'error',
      'no-unreachable': 'error',
      'eqeqeq': 'error'
    }
  }
];

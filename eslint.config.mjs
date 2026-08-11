import nextCoreWebVitals from 'eslint-config-next/core-web-vitals';
import nextTypescript from 'eslint-config-next/typescript';

/**
 * eslint-config-next v16 ships native flat config, so no FlatCompat shim.
 * (The shim breaks under ESLint 10 on a circular `react` reference.)
 */
export default [
  {
    ignores: [
      'node_modules/**',
      '.next/**',
      'coverage/**',
      'drizzle/**',
      'public/widget.js',
      'next-env.d.ts',
    ],
  },
  ...nextCoreWebVitals,
  ...nextTypescript,
  {
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/no-explicit-any': 'error',
      'no-console': ['error', { allow: ['warn', 'error'] }],
      eqeqeq: ['error', 'always'],
      'prefer-const': 'error',
      // FR-1.5: route handlers must go through the permission layer, which is
      // the only place the matter scope filter is applied.
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['**/db/client'],
              importNames: ['db'],
              message:
                'Route handlers must not query the database directly. ' +
                'Go through src/lib/auth/guard.ts so the permission scope filter is applied (FR-1.5).',
            },
          ],
        },
      ],
    },
  },
  {
    // Config files are legitimately anonymous default exports.
    files: ['*.config.mjs', '*.config.ts', '*.config.js'],
    rules: { 'import/no-anonymous-default-export': 'off' },
  },
  {
    // The permission layer, services, job workers and scripts are the
    // sanctioned direct-DB callers.
    // Server modules, job workers and CLI scripts log to stdout by design —
    // that output is the operator's only view of a background process.
    files: [
      'src/lib/**/*.ts',
      'src/jobs/**/*.ts',
      'scripts/**/*.{ts,mjs,js}',
      'evals/**/*.ts',
      'tests/**/*.ts',
      '**/*.test.ts',
    ],
    rules: {
      'no-restricted-imports': 'off',
      'no-console': 'off',
    },
  },
];

import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

/**
 * AI eval suite (AI-5). Separated from the unit suite because these cases call
 * the live model and are slower + cost money. Runs in CI on every PR that
 * touches src/lib/ai/**; merges are blocked on regression.
 */
export default defineConfig({
  test: {
    environment: 'node',
    include: ['evals/**/*.eval.ts'],
    testTimeout: 120_000,
    hookTimeout: 60_000,
    // Model calls are rate-limited; keep concurrency modest.
    maxConcurrency: 4,
    reporters: ['default'],
  },
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
      'server-only': fileURLToPath(new URL('./tests/stubs/server-only.ts', import.meta.url)),
    },
  },
});

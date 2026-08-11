import { config } from 'dotenv';

// Integration tests need the local database; unit tests ignore this.
config({ path: '.env', quiet: true });

process.env.APP_ENV ??= 'development';
process.env.APP_BASE_URL ??= 'http://localhost:3000';
process.env.EMBEDDING_DIMENSIONS ??= '1024';
process.env.AUTH_SECRET ??= 'test-only-secret';
process.env.FIELD_ENCRYPTION_KEY ??= Buffer.from('test-only-32-byte-key-for-vitest').toString(
  'base64',
);

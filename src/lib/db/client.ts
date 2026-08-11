import 'server-only';
import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import * as schema from './schema';

/**
 * Single pooled Drizzle client.
 *
 * Held on globalThis so Next.js dev hot-reload does not leak a new pool per
 * recompile, which exhausts Postgres connections within a few edits.
 *
 * IMPORTANT (FR-1.5): route handlers must not import `db` directly. All
 * matter-scoped reads go through src/lib/auth/guard.ts so the permission
 * filter is applied. ESLint enforces this via no-restricted-imports.
 */

declare global {
  var __mvpPool: Pool | undefined;
}

function createPool(): Pool {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error('DATABASE_URL is not set');
  }
  const needsSsl =
    process.env.APP_ENV === 'production' || /\bsslmode=require\b/.test(connectionString);

  return new Pool({
    connectionString,
    max: Number(process.env.DB_POOL_MAX ?? 10),
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
    // Railway's internal network terminates TLS at the proxy with a cert the
    // client cannot chain to a public root; verification is disabled only there.
    ssl: needsSsl ? { rejectUnauthorized: false } : undefined,
  });
}

/**
 * Lazily constructed. Importing this module must not open a connection —
 * pure-logic modules (guard.ts, ics.ts) import it for its types and query
 * builders and are unit-tested without a database.
 */
export function getPool(): Pool {
  if (!globalThis.__mvpPool) {
    globalThis.__mvpPool = createPool();
  }
  return globalThis.__mvpPool;
}

type DrizzleDb = ReturnType<typeof drizzle<typeof schema>>;

let dbInstance: DrizzleDb | null = null;

function getDb(): DrizzleDb {
  if (!dbInstance) {
    dbInstance = drizzle(getPool(), { schema, casing: 'snake_case' });
  }
  return dbInstance;
}

/**
 * Proxy so `db.select(...)` reads naturally at call sites while the underlying
 * pool is still created on first use rather than on import.
 */
export const db: DrizzleDb = new Proxy({} as DrizzleDb, {
  get(_target, prop, receiver) {
    return Reflect.get(getDb() as object, prop, receiver);
  },
  has(_target, prop) {
    return Reflect.has(getDb() as object, prop);
  },
});

export type Database = DrizzleDb;
export { schema };

/** Graceful shutdown for the worker process. */
export async function stopPool(): Promise<void> {
  if (globalThis.__mvpPool) {
    await globalThis.__mvpPool.end();
    globalThis.__mvpPool = undefined;
    dbInstance = null;
  }
}

/** Used by /api/health (NFR-3.5). */
export async function databaseHealthCheck(): Promise<{ ok: boolean; latencyMs: number }> {
  const started = Date.now();
  try {
    await getPool().query('select 1');
    return { ok: true, latencyMs: Date.now() - started };
  } catch {
    return { ok: false, latencyMs: Date.now() - started };
  }
}

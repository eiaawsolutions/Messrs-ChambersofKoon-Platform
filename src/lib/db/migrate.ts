import 'dotenv/config';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';

/**
 * Migration runner.
 *
 * Three ordered stages, because pgvector and the audit-immutability trigger
 * cannot be expressed in the drizzle schema DSL:
 *
 *   1. drizzle/pre/*.sql   — extensions. Must exist before any table DDL.
 *   2. drizzle journal     — drizzle-kit generated table/column/index DDL.
 *   3. drizzle/post/*.sql  — vector + tsvector columns, HNSW/GIN indexes,
 *                            triggers, grants. Written idempotently so a
 *                            re-run is always safe.
 *
 * Stages 1 and 3 are tracked in `_manual_migrations` by filename so each file
 * runs once, but every statement in them is also individually idempotent — the
 * belt-and-braces matters because a partially applied migration on Railway
 * must not wedge the next deploy.
 */

const MIGRATIONS_DIR = path.resolve(process.cwd(), 'drizzle');

async function runSqlStage(pool: Pool, stage: 'pre' | 'post'): Promise<void> {
  const dir = path.join(MIGRATIONS_DIR, stage);
  let files: string[];
  try {
    files = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort();
  } catch {
    return; // stage directory is optional
  }

  for (const file of files) {
    const id = `${stage}/${file}`;
    const { rows } = await pool.query('select 1 from _manual_migrations where id = $1', [id]);
    if (rows.length > 0) {
      console.log(`  = ${id} (already applied)`);
      continue;
    }
    const sql = await readFile(path.join(dir, file), 'utf8');
    const client = await pool.connect();
    try {
      await client.query('begin');
      await client.query(sql);
      await client.query('insert into _manual_migrations (id) values ($1)', [id]);
      await client.query('commit');
      console.log(`  + ${id}`);
    } catch (error) {
      await client.query('rollback');
      throw new Error(`Migration ${id} failed: ${(error as Error).message}`);
    } finally {
      client.release();
    }
  }
}

async function main(): Promise<void> {
  const connectionString = process.env.DIRECT_URL ?? process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error('DIRECT_URL or DATABASE_URL must be set to run migrations');
  }

  const needsSsl =
    process.env.APP_ENV === 'production' || /\bsslmode=require\b/.test(connectionString);

  const pool = new Pool({
    connectionString,
    max: 1,
    ssl: needsSsl ? { rejectUnauthorized: false } : undefined,
  });

  try {
    await pool.query(`
      create table if not exists _manual_migrations (
        id text primary key,
        applied_at timestamptz not null default now()
      )
    `);

    console.log('Stage 1/3 — extensions');
    await runSqlStage(pool, 'pre');

    console.log('Stage 2/3 — schema (drizzle journal)');
    const dz = drizzle(pool);
    await migrate(dz, { migrationsFolder: MIGRATIONS_DIR });

    console.log('Stage 3/3 — vector, search, triggers');
    await runSqlStage(pool, 'post');

    console.log('Migrations complete.');
  } finally {
    await pool.end();
  }
}

main().catch((error: unknown) => {
  console.error('Migration failed:', error);
  process.exit(1);
});

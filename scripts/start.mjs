#!/usr/bin/env node
/**
 * Role-aware entrypoint.
 *
 * The web service and the worker deploy from the same repository and the same
 * image. Railway's per-service start-command override is a dashboard setting,
 * so the role is taken from `SERVICE_ROLE` instead — one place, visible in the
 * service's own variables, and reproducible from the CLI.
 *
 *   SERVICE_ROLE=web     (default)  migrate → seed → next start
 *   SERVICE_ROLE=worker             wait for schema → run job workers
 *
 * Migrations run only on the web role. Two services racing the same migration
 * is the classic way to wedge a deploy, and pg-boss creates its own schema on
 * first start regardless.
 */
import { spawn } from 'node:child_process';

const role = (process.env.SERVICE_ROLE ?? 'web').toLowerCase();

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: 'inherit', shell: process.platform === 'win32' });
    child.on('exit', (code) =>
      code === 0 ? resolve() : reject(new Error(`${command} exited ${code}`)),
    );
    child.on('error', reject);
  });
}

/**
 * The worker must not start against a database the web service has not
 * migrated yet. Polling for the table the workers actually depend on is more
 * honest than a fixed sleep.
 */
async function waitForSchema(attempts = 30) {
  const { Pool } = await import('pg');
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error('DATABASE_URL is not set');

  const pool = new Pool({
    connectionString,
    max: 1,
    ssl: process.env.APP_ENV === 'production' ? { rejectUnauthorized: false } : undefined,
  });

  try {
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        const { rows } = await pool.query("select to_regclass('public.matters') as t");
        if (rows[0]?.t) {
          console.log('[start] schema is present');
          return;
        }
      } catch (error) {
        console.warn(`[start] database not ready (${error.message})`);
      }
      console.log(`[start] waiting for schema… (${attempt}/${attempts})`);
      await new Promise((r) => setTimeout(r, 5000));
    }
    throw new Error('Schema did not appear. Is the web service deploying and migrating?');
  } finally {
    await pool.end();
  }
}

async function main() {
  if (role === 'worker') {
    console.log('[start] role=worker');
    await waitForSchema();
    await run('npx', ['tsx', '--conditions=react-server', 'src/jobs/worker.ts']);
    return;
  }

  console.log('[start] role=web');
  await run('npm', ['run', 'db:migrate']);
  await run('npm', ['run', 'db:seed']);
  await run('npx', ['next', 'start']);
}

main().catch((error) => {
  console.error('[start] failed:', error.message);
  process.exit(1);
});

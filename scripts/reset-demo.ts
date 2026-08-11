import 'dotenv/config';
import { sql } from 'drizzle-orm';
import { db, stopPool } from '@/lib/db/client';

/**
 * Clear the transactional debris a demo or rehearsal leaves behind.
 *
 *   DEMO_SEED_ENABLED=true npm run demo:reset
 *
 * Removes enquiries, proposals, appointments, exception tasks and queued
 * messages — everything that accumulates each time the script is run — while
 * leaving the seeded people, availability and matters in place.
 *
 * Why this is needed: every rehearsal of the intake script creates a fresh
 * enquiry, and each completed one creates a proposal. After three rehearsals
 * the intake queue shows the same fictional client three times, which reads as
 * a duplicate-record bug in front of a partner.
 *
 * Refuses to run unless DEMO_SEED_ENABLED=true, the same flag that declares an
 * environment holds no real client matters. Audit events are never deleted —
 * the database rejects that, by design.
 */

async function main(): Promise<void> {
  if (process.env.DEMO_SEED_ENABLED !== 'true') {
    console.error(
      'Refusing to run. Set DEMO_SEED_ENABLED=true to confirm this environment\n' +
        'holds no real client matters.',
    );
    process.exit(1);
  }

  // Ordered so foreign keys are satisfied without relying on cascade order.
  const steps: Array<[string, string]> = [
    ['exception tasks', 'delete from exception_tasks'],
    ['queued and sent messages', 'delete from messages'],
    ['appointments', 'delete from appointments'],
    ['appointment proposals', 'delete from appointment_proposals'],
    ['enquiry transcripts', 'delete from enquiry_messages'],
    ['enquiries', 'delete from enquiries'],
    ['rate-limit buckets', 'delete from rate_limit_buckets'],
  ];

  for (const [label, statement] of steps) {
    const result = await db.execute(sql.raw(statement));
    console.log(`  cleared ${result.rowCount ?? 0} ${label}`);
  }

  console.log('\nIntake queue is empty. Seeded people, availability and matters are untouched.');
  console.log('Audit history is retained — it is append-only and cannot be deleted.\n');

  await stopPool();
}

main().catch(async (error: unknown) => {
  console.error('Demo reset failed:', error);
  await stopPool().catch(() => {});
  process.exit(1);
});

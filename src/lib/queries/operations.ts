import 'server-only';
import { sql } from 'drizzle-orm';
import { db } from '@/lib/db/client';
import { queueDepths } from '@/lib/jobs/queue';
import { monthToDateSpendUsd } from '@/lib/ai/client';
import { config } from '@/lib/config/env';

/**
 * Operational dashboard read model (NFR-4.3).
 *
 * "Enquiries per day, proposals pending, drafts generated, emails sent and
 *  bounced, AI spend, job queue depth and failures."
 *
 * Every figure here is a count or a sum — no client name, no case brief, no
 * message body. That is deliberate: this screen answers "is the platform
 * working", and it is the one screen a firm is most likely to leave open on a
 * shared monitor. NFR-4.1 makes the same point about logs.
 *
 * Read straight from the operational tables rather than from a metrics store.
 * At this firm's volume the aggregates are milliseconds, and one fewer moving
 * part is one fewer thing that can be silently stale — a dashboard that is
 * confidently wrong is worse than no dashboard.
 */

export interface DailyCount {
  /** YYYY-MM-DD in firm-local time. */
  day: string;
  count: number;
}

export interface EmailHealth {
  sent: number;
  delivered: number;
  bounced: number;
  failed: number;
  queued: number;
}

export interface OperationsSnapshot {
  enquiriesPerDay: DailyCount[];
  enquiriesToday: number;
  proposalsPending: number;
  proposalsExpiringToday: number;
  draftsGenerated30d: number;
  email30d: EmailHealth;
  aiSpend: { monthToDateUsd: number; ceilingUsd: number; percentOfCeiling: number };
  queues: Array<{ name: string; queued: number; active: number; failed: number }>;
  queueUnavailable: boolean;
  extractionsFailed: number;
  exceptionsOpen: number;
}

const DAYS = 14;

export async function operationsSnapshot(): Promise<OperationsSnapshot> {
  const [counts, perDay, email, queues, spend] = await Promise.all([
    scalarCounts(),
    enquiriesPerDay(),
    emailHealth(),
    safeQueueDepths(),
    monthToDateSpendUsd().catch(() => 0),
  ]);

  const ceiling = config().AI_MONTHLY_SPEND_CEILING_USD;

  return {
    enquiriesPerDay: perDay,
    enquiriesToday: perDay.at(-1)?.count ?? 0,
    proposalsPending: counts.proposalsPending,
    proposalsExpiringToday: counts.proposalsExpiringToday,
    draftsGenerated30d: counts.draftsGenerated30d,
    email30d: email,
    aiSpend: {
      monthToDateUsd: spend,
      ceilingUsd: ceiling,
      percentOfCeiling: ceiling > 0 ? Math.round((spend / ceiling) * 100) : 0,
    },
    queues: queues.depths,
    queueUnavailable: queues.unavailable,
    extractionsFailed: counts.extractionsFailed,
    exceptionsOpen: counts.exceptionsOpen,
  };
}

/**
 * One round trip for the single-number figures.
 *
 * Six separate `select count(*)` calls would be six round trips to render one
 * card each; as scalar subqueries they are one statement the planner can run
 * in parallel.
 */
async function scalarCounts() {
  const rows = await db.execute<Record<string, string>>(sql`
    select
      (select count(*) from appointment_proposals where state = 'pending') as proposals_pending,
      (
        select count(*) from appointment_proposals
        where state = 'pending' and expires_at < now() + interval '24 hours'
      ) as proposals_expiring_today,
      (
        select count(*) from document_versions
        where generated_by = 'ai' and created_at > now() - interval '30 days'
      ) as drafts_generated_30d,
      (select count(*) from archive_files where ocr_state = 'failed') as extractions_failed,
      (select count(*) from exception_tasks where state = 'open') as exceptions_open
  `);

  const row = rows.rows[0];
  return {
    proposalsPending: Number(row?.proposals_pending ?? 0),
    proposalsExpiringToday: Number(row?.proposals_expiring_today ?? 0),
    draftsGenerated30d: Number(row?.drafts_generated_30d ?? 0),
    extractionsFailed: Number(row?.extractions_failed ?? 0),
    exceptionsOpen: Number(row?.exceptions_open ?? 0),
  };
}

/**
 * Enquiries per day, in firm-local time, with empty days present as zero.
 *
 * The generated series matters. Grouping only over rows that exist would draw
 * a chart in which a quiet Sunday simply is not there, and a run of quiet days
 * would compress into a line that looks healthy — exactly the shape a broken
 * widget produces.
 */
async function enquiriesPerDay(): Promise<DailyCount[]> {
  const rows = await db.execute<{ day: string; count: string }>(sql`
    with days as (
      select generate_series(
        -- The cast is load-bearing. Without it the bind parameter is untyped,
        -- Postgres resolves 'date - unknown' to the 'date - date' operator
        -- that yields an integer, and generate_series is then handed an
        -- integer where it expects a date.
        (now() at time zone 'Asia/Kuala_Lumpur')::date - (${DAYS - 1})::integer,
        (now() at time zone 'Asia/Kuala_Lumpur')::date,
        interval '1 day'
      )::date as day
    )
    select
      to_char(days.day, 'YYYY-MM-DD') as day,
      count(e.id) as count
    from days
    left join enquiries e
      on (e.created_at at time zone 'Asia/Kuala_Lumpur')::date = days.day
    group by days.day
    order by days.day
  `);

  return rows.rows.map((row) => ({ day: row.day, count: Number(row.count) }));
}

async function emailHealth(): Promise<EmailHealth> {
  const rows = await db.execute<Record<string, string>>(sql`
    select
      count(*) filter (where state in ('sent', 'delivered')) as sent,
      count(*) filter (where state = 'delivered') as delivered,
      count(*) filter (where state = 'bounced') as bounced,
      count(*) filter (where state = 'failed') as failed,
      count(*) filter (where state = 'queued') as queued
    from messages
    where created_at > now() - interval '30 days'
  `);

  const row = rows.rows[0];
  return {
    sent: Number(row?.sent ?? 0),
    delivered: Number(row?.delivered ?? 0),
    bounced: Number(row?.bounced ?? 0),
    failed: Number(row?.failed ?? 0),
    queued: Number(row?.queued ?? 0),
  };
}

/**
 * Queue depths, or an honest gap.
 *
 * The web process reaches pg-boss over the same database, but the worker is a
 * separate service and its queues may not exist yet on a fresh deploy. A
 * failure here renders "unavailable" rather than a screen full of zeroes,
 * because zero queued and zero failed is precisely what a healthy system looks
 * like — the one reading that must never be faked.
 */
async function safeQueueDepths() {
  try {
    return { depths: await queueDepths(), unavailable: false };
  } catch (error) {
    console.error('[operations] queue stats unavailable', (error as Error).message);
    return { depths: [], unavailable: true };
  }
}

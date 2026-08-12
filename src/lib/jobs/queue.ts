import 'server-only';
import { PgBoss } from 'pg-boss';

/**
 * Durable background jobs (PRD §3.1).
 *
 * pg-boss on the same PostgreSQL instance rather than BullMQ + Redis: one
 * fewer service to secure, back up and restore, and the PRD's restore
 * rehearsal (NFR-3.4, AT-13) then covers the queue automatically. At this
 * firm's volume the throughput difference is irrelevant.
 *
 * pg-boss v12 makes queues explicit: each is declared once with its retry and
 * retention policy, and every queue has a dead-letter queue behind it so a job
 * that exhausts its retries is parked for inspection rather than lost
 * (FR-5.3: "never silently dropped").
 */

export const JOBS = {
  TRIAGE_ENQUIRY: 'triage.enquiry',
  PROPOSE_SLOT: 'schedule.propose',
  EXPIRE_PROPOSALS: 'schedule.expire-proposals',
  SEND_ICS: 'email.send-ics',
  SEND_MESSAGE: 'email.send-message',
  MILESTONE_DISPATCH: 'comms.milestone-dispatch',
  SLA_SWEEP: 'comms.sla-sweep',
  EXTRACT_TEXT: 'archive.extract-text',
  EMBED_CHUNKS: 'archive.embed-chunks',
  GENERATE_DRAFT: 'documents.generate-draft',
  PRUNE_RATE_LIMITS: 'ops.prune-rate-limits',
  /** NFR-2.2: destroy what is past its retention date. */
  RETENTION_SWEEP: 'ops.retention-sweep',
} as const;

export type JobName = (typeof JOBS)[keyof typeof JOBS];

/** Failed jobs land here for a human to inspect and redrive. */
export const DEAD_LETTER = 'dead-letter';

interface QueuePolicyConfig {
  retryLimit: number;
  /** Seconds a job may run before it is considered stalled and retried. */
  expireInSeconds: number;
}

/**
 * Per-queue policy. Long-running work (OCR on a 200-page scan, a Sonnet draft)
 * gets a generous expiry; email gets a short one so a wedged send retries fast.
 */
const QUEUE_POLICY: Record<JobName, QueuePolicyConfig> = {
  [JOBS.TRIAGE_ENQUIRY]: { retryLimit: 5, expireInSeconds: 300 },
  [JOBS.PROPOSE_SLOT]: { retryLimit: 5, expireInSeconds: 120 },
  [JOBS.EXPIRE_PROPOSALS]: { retryLimit: 3, expireInSeconds: 300 },
  [JOBS.SEND_ICS]: { retryLimit: 8, expireInSeconds: 120 },
  [JOBS.SEND_MESSAGE]: { retryLimit: 8, expireInSeconds: 120 },
  [JOBS.MILESTONE_DISPATCH]: { retryLimit: 8, expireInSeconds: 120 },
  [JOBS.SLA_SWEEP]: { retryLimit: 3, expireInSeconds: 600 },
  [JOBS.EXTRACT_TEXT]: { retryLimit: 4, expireInSeconds: 1800 },
  [JOBS.EMBED_CHUNKS]: { retryLimit: 5, expireInSeconds: 900 },
  [JOBS.GENERATE_DRAFT]: { retryLimit: 3, expireInSeconds: 900 },
  [JOBS.PRUNE_RATE_LIMITS]: { retryLimit: 2, expireInSeconds: 120 },
  // One retry only. A sweep that failed halfway has already committed its
  // first statement; retrying it repeatedly against a struggling database is
  // how a destructive job turns an outage into a longer one. It runs weekly —
  // the next pass picks up whatever this one missed.
  [JOBS.RETENTION_SWEEP]: { retryLimit: 1, expireInSeconds: 900 },
};

let bossInstance: PgBoss | null = null;
let starting: Promise<PgBoss> | null = null;

function connectionString(): string {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is required for the job queue');
  return url;
}

export async function getBoss(): Promise<PgBoss> {
  if (bossInstance) return bossInstance;
  if (starting) return starting;

  starting = (async () => {
    const boss = new PgBoss({
      connectionString: connectionString(),
      // Queue tables live in their own schema so drizzle migrations and
      // pg-boss never contend over the same namespace.
      schema: 'pgboss',
      max: 4,
      ...(process.env.APP_ENV === 'production' ? { ssl: { rejectUnauthorized: false } } : {}),
    });

    boss.on('error', (error: unknown) => {
      console.error('[jobs] pg-boss error', error);
    });

    await boss.start();

    // Idempotent: declaring an existing queue is a no-op.
    await boss.createQueue(DEAD_LETTER);
    for (const [name, policy] of Object.entries(QUEUE_POLICY)) {
      await boss.createQueue(name, {
        policy: 'standard',
        deadLetter: DEAD_LETTER,
        retryLimit: policy.retryLimit,
        retryDelay: 30,
        retryBackoff: true,
        retryDelayMax: 3600,
        expireInSeconds: policy.expireInSeconds,
        // 14-day retention on pending work, 7-day on completed — enough to
        // investigate an incident without growing the table unbounded.
        retentionSeconds: 1_209_600,
        deleteAfterSeconds: 604_800,
      });
    }

    bossInstance = boss;
    return boss;
  })();

  try {
    return await starting;
  } finally {
    starting = null;
  }
}

export interface EnqueueOptions {
  /** Delay before first attempt, seconds. */
  startAfterSeconds?: number;
  /**
   * Deduplication key. A second job with the same key while one is still
   * pending is dropped — this is what makes "record status" safe to call twice.
   */
  singletonKey?: string;
  priority?: number;
}

export async function enqueue<T extends object>(
  name: JobName,
  data: T,
  options: EnqueueOptions = {},
): Promise<string | null> {
  const boss = await getBoss();
  return boss.send(name, data, {
    ...(options.startAfterSeconds ? { startAfter: options.startAfterSeconds } : {}),
    ...(options.singletonKey ? { singletonKey: options.singletonKey } : {}),
    ...(options.priority ? { priority: options.priority } : {}),
  });
}

export async function queueHealthCheck(): Promise<{
  ok: boolean;
  latencyMs: number;
  note?: string;
}> {
  const started = Date.now();
  try {
    const boss = await getBoss();
    const stats = await boss.getQueueStats(JOBS.SEND_MESSAGE);
    const depth = stats[0]?.queuedCount ?? 0;
    return { ok: true, latencyMs: Date.now() - started, note: `depth ${depth}` };
  } catch (error) {
    return { ok: false, latencyMs: Date.now() - started, note: (error as Error).name };
  }
}

/** Operational dashboard input (NFR-4.3): queue depth and failure counts. */
export async function queueDepths(): Promise<
  Array<{ name: string; queued: number; active: number; failed: number }>
> {
  const boss = await getBoss();
  const out: Array<{ name: string; queued: number; active: number; failed: number }> = [];
  for (const name of Object.values(JOBS)) {
    try {
      const [stats] = await boss.getQueueStats(name);
      out.push({
        name,
        queued: stats?.queuedCount ?? 0,
        active: stats?.activeCount ?? 0,
        failed: stats?.failedCount ?? 0,
      });
    } catch {
      out.push({ name, queued: 0, active: 0, failed: 0 });
    }
  }
  return out;
}

export async function stopBoss(): Promise<void> {
  if (bossInstance) {
    await bossInstance.stop({ graceful: true, close: true, timeout: 30_000 });
    bossInstance = null;
  }
}

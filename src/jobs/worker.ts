import 'dotenv/config';
import { getBoss, JOBS, stopBoss, enqueue } from '@/lib/jobs/queue';
import { stopPool } from '@/lib/db/client';
import { buildCaseBrief } from '@/lib/intake/triage';
import { expireStaleProposals, proposeSlot } from '@/lib/scheduling/service';
import { pruneRateLimits } from '@/lib/intake/protection';
import { dispatchMilestone, sweepSlaBreaches } from '@/lib/comms/milestones';
import { extractArchiveText, embedPendingChunks } from '@/lib/archive/ingest';
import { runDraftGeneration } from '@/lib/documents/generate';

/**
 * Background worker process.
 *
 * Runs as a separate Railway service from the web app so a long OCR batch or a
 * slow Sonnet draft cannot occupy a request handler, and so the two scale
 * independently. Both point at the same database, which is where the queue
 * lives.
 *
 * Every handler is written to be idempotent: pg-boss guarantees at-least-once
 * delivery, so a handler that has already done its work must recognise that
 * and return rather than doing it twice. Sending a client the same milestone
 * email twice is the failure this prevents.
 */

type Handler<T> = (data: T) => Promise<void>;

/** Wrap a handler so a thrown error is logged with context before pg-boss retries. */
function handler<T extends object>(name: string, fn: Handler<T>) {
  return async (jobs: Array<{ id: string; data: T }>): Promise<void> => {
    for (const job of jobs) {
      const started = Date.now();
      try {
        await fn(job.data);
        console.log(
          JSON.stringify({
            level: 'info',
            job: name,
            jobId: job.id,
            durationMs: Date.now() - started,
            outcome: 'ok',
          }),
        );
      } catch (error) {
        console.error(
          JSON.stringify({
            level: 'error',
            job: name,
            jobId: job.id,
            durationMs: Date.now() - started,
            outcome: 'failed',
            error: (error as Error).message,
          }),
        );
        throw error; // let pg-boss apply the retry policy
      }
    }
  };
}

async function main(): Promise<void> {
  const boss = await getBoss();
  console.log('[worker] started');

  // --- Intake -------------------------------------------------------------
  await boss.work(
    JOBS.TRIAGE_ENQUIRY,
    handler<{ enquiryId: string }>(JOBS.TRIAGE_ENQUIRY, async ({ enquiryId }) => {
      const outcome = await buildCaseBrief(enquiryId);
      // FR-2.6: only a confident, complete brief proceeds to a proposal.
      if (outcome.autoProposeSlot) {
        await enqueue(JOBS.PROPOSE_SLOT, { enquiryId }, { singletonKey: `propose-${enquiryId}` });
      }
    }),
  );

  // --- Scheduling ---------------------------------------------------------
  await boss.work(
    JOBS.PROPOSE_SLOT,
    handler<{ enquiryId: string }>(JOBS.PROPOSE_SLOT, async ({ enquiryId }) => {
      const result = await proposeSlot(enquiryId);
      if (!result) {
        console.warn(`[worker] no slot available for enquiry ${enquiryId}; left for human triage`);
      }
    }),
  );

  await boss.work(
    JOBS.EXPIRE_PROPOSALS,
    handler<Record<string, never>>(JOBS.EXPIRE_PROPOSALS, async () => {
      const expired = await expireStaleProposals();
      if (expired > 0) console.log(`[worker] expired ${expired} stale proposal(s)`);
    }),
  );

  // --- Communications -----------------------------------------------------
  await boss.work(
    JOBS.MILESTONE_DISPATCH,
    handler<{ statusEventId: string }>(JOBS.MILESTONE_DISPATCH, async ({ statusEventId }) => {
      await dispatchMilestone(statusEventId);
    }),
  );

  await boss.work(
    JOBS.SLA_SWEEP,
    handler<Record<string, never>>(JOBS.SLA_SWEEP, async () => {
      const raised = await sweepSlaBreaches();
      if (raised > 0) console.log(`[worker] raised ${raised} SLA exception(s)`);
    }),
  );

  // --- Archive ------------------------------------------------------------
  await boss.work(
    JOBS.EXTRACT_TEXT,
    handler<{ archiveFileId: string }>(JOBS.EXTRACT_TEXT, async ({ archiveFileId }) => {
      await extractArchiveText(archiveFileId);
      await enqueue(
        JOBS.EMBED_CHUNKS,
        { archiveFileId },
        { singletonKey: `embed-${archiveFileId}` },
      );
    }),
  );

  await boss.work(
    JOBS.EMBED_CHUNKS,
    handler<{ archiveFileId: string }>(JOBS.EMBED_CHUNKS, async ({ archiveFileId }) => {
      await embedPendingChunks(archiveFileId);
    }),
  );

  // --- Documents ----------------------------------------------------------
  await boss.work(
    JOBS.GENERATE_DRAFT,
    handler<{ documentId: string; actorUserId: string }>(
      JOBS.GENERATE_DRAFT,
      async ({ documentId, actorUserId }) => {
        await runDraftGeneration({ documentId, actorUserId });
      },
    ),
  );

  // --- Housekeeping -------------------------------------------------------
  await boss.work(
    JOBS.PRUNE_RATE_LIMITS,
    handler<Record<string, never>>(JOBS.PRUNE_RATE_LIMITS, async () => {
      const removed = await pruneRateLimits();
      if (removed > 0) console.log(`[worker] pruned ${removed} rate-limit bucket(s)`);
    }),
  );

  // Recurring schedules. pg-boss stores these, so re-registering on each boot
  // updates rather than duplicates them.
  await boss.schedule(JOBS.EXPIRE_PROPOSALS, '*/15 * * * *', {}, { tz: 'Asia/Kuala_Lumpur' });
  await boss.schedule(JOBS.SLA_SWEEP, '0 8 * * 1-5', {}, { tz: 'Asia/Kuala_Lumpur' });
  await boss.schedule(JOBS.PRUNE_RATE_LIMITS, '0 3 * * *', {}, { tz: 'Asia/Kuala_Lumpur' });

  console.log('[worker] handlers registered; awaiting jobs');
}

async function shutdown(signal: string): Promise<void> {
  console.log(`[worker] ${signal} received, draining`);
  try {
    await stopBoss();
    await stopPool();
  } finally {
    process.exit(0);
  }
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

main().catch((error: unknown) => {
  console.error('[worker] failed to start', error);
  process.exit(1);
});

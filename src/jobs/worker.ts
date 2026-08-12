import 'dotenv/config';
import { createServer, type Server } from 'node:http';
import { getBoss, JOBS, stopBoss, enqueue, queueDepths } from '@/lib/jobs/queue';
import { stopPool } from '@/lib/db/client';
import { buildCaseBrief } from '@/lib/intake/triage';
import { expireStaleProposals, proposeSlot } from '@/lib/scheduling/service';
import { pruneRateLimits } from '@/lib/intake/protection';
import { dispatchMilestone, sweepSlaBreaches } from '@/lib/comms/milestones';
import { extractArchiveText, embedPendingChunks } from '@/lib/archive/ingest';
import { runDraftGeneration } from '@/lib/documents/generate';
import { purgeExpiredData } from '@/lib/privacy/retention';

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

let healthServer: Server | null = null;
let ready = false;

/**
 * Liveness endpoint for the worker.
 *
 * A background worker with no health signal is one that can die quietly and
 * take the intake pipeline with it — enquiries would keep arriving and simply
 * never be triaged. Serving `/api/health` lets the platform's own healthcheck
 * and the external uptime monitor see the worker the same way they see the web
 * service, and it reports queue depth so a stuck queue is visible.
 */
function startHealthServer(): void {
  const port = Number(process.env.PORT ?? 3000);

  healthServer = createServer((req, res) => {
    if (!req.url?.startsWith('/api/health')) {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'Not found' }));
      return;
    }

    void (async () => {
      const depths = ready ? await queueDepths().catch(() => []) : [];
      const failed = depths.reduce((sum, q) => sum + q.failed, 0);
      const body = JSON.stringify({
        status: ready ? 'ok' : 'starting',
        role: 'worker',
        queues: depths.length,
        pending: depths.reduce((sum, q) => sum + q.queued + q.active, 0),
        failed,
      });
      res.writeHead(ready ? 200 : 503, {
        'content-type': 'application/json',
        'cache-control': 'no-store',
      });
      res.end(body);
    })();
  });

  healthServer.listen(port, () => {
    console.log(`[worker] health endpoint listening on ${port}`);
  });
}

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
  // Serve health immediately so the platform healthcheck has a target while
  // handlers are still registering; it reports 503 until they are ready.
  startHealthServer();

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

  await boss.work(
    JOBS.RETENTION_SWEEP,
    handler<Record<string, never>>(JOBS.RETENTION_SWEEP, async () => {
      const purged = await purgeExpiredData();
      if (purged.enquiries > 0 || purged.messages > 0) {
        console.log(
          `[worker] retention: purged ${purged.enquiries} enquir(ies) and ${purged.messages} message(s)`,
        );
      }
    }),
  );

  // Recurring schedules. pg-boss stores these, so re-registering on each boot
  // updates rather than duplicates them.
  await boss.schedule(JOBS.EXPIRE_PROPOSALS, '*/15 * * * *', {}, { tz: 'Asia/Kuala_Lumpur' });
  await boss.schedule(JOBS.SLA_SWEEP, '0 8 * * 1-5', {}, { tz: 'Asia/Kuala_Lumpur' });
  await boss.schedule(JOBS.PRUNE_RATE_LIMITS, '0 3 * * *', {}, { tz: 'Asia/Kuala_Lumpur' });
  // NFR-2.2. Weekly rather than nightly: the thresholds are 24 months and 7
  // years, so nothing becomes overdue between Sundays, and a destructive sweep
  // that runs less often is easier to reconcile against the audit log.
  await boss.schedule(JOBS.RETENTION_SWEEP, '30 3 * * 0', {}, { tz: 'Asia/Kuala_Lumpur' });

  ready = true;
  console.log('[worker] handlers registered; awaiting jobs');
}

async function shutdown(signal: string): Promise<void> {
  console.log(`[worker] ${signal} received, draining`);
  ready = false;
  try {
    healthServer?.close();
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

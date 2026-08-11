import 'server-only';
import { eq } from 'drizzle-orm';
import { db } from '@/lib/db/client';
import { documents, matterStatusEvents, matters } from '@/lib/db/schema';
import { enqueue, JOBS } from '@/lib/jobs/queue';
import { audit, AUDIT_ACTIONS } from '@/lib/audit/log';
import type { Actor } from '@/lib/auth/guard';

/**
 * Matter mutations.
 *
 * Authorisation happens in the calling server action, which has the request
 * context needed to audit a denial. These functions assume the caller is
 * already authorised — and are only reachable from that layer.
 */

/**
 * Record a procedural stage (FR-7.2, FR-7.3).
 *
 * The platform never reads from a court system: this row exists because a
 * member of firm staff typed it. Recording it queues the client email, which
 * the worker sends within seconds.
 */
export async function recordStatus(params: {
  actor: Actor;
  matterId: string;
  stage: string;
  notes: string | null;
  suppressed: boolean;
}): Promise<string> {
  const [event] = await db
    .insert(matterStatusEvents)
    .values({
      matterId: params.matterId,
      stage: params.stage,
      recordedByUserId: params.actor.id,
      notes: params.notes,
      suppressed: params.suppressed,
    })
    .returning({ id: matterStatusEvents.id });

  if (!event) throw new Error('Could not record status');

  await audit({
    action: AUDIT_ACTIONS.MATTER_STATUS_RECORD,
    actorUserId: params.actor.id,
    actorEmail: params.actor.email,
    entityType: 'matter_status_event',
    entityId: event.id,
    matterId: params.matterId,
    metadata: { stage: params.stage, suppressed: params.suppressed },
  });

  // Idempotent on the event id: the dispatcher refuses to send twice for the
  // same event, so a retry cannot double-email a client.
  await enqueue(
    JOBS.MILESTONE_DISPATCH,
    { statusEventId: event.id },
    { singletonKey: `milestone-${event.id}` },
  );

  return event.id;
}

/** FR-7.4: stop every client communication on a sensitive matter. */
export async function setCommsHold(params: {
  actor: Actor;
  matterId: string;
  hold: boolean;
}): Promise<void> {
  await db.update(matters).set({ commsHold: params.hold }).where(eq(matters.id, params.matterId));

  await audit({
    action: AUDIT_ACTIONS.MATTER_UPDATE,
    actorUserId: params.actor.id,
    actorEmail: params.actor.email,
    entityType: 'matter',
    entityId: params.matterId,
    matterId: params.matterId,
    metadata: { commsHold: params.hold },
  });
}

/** Create a document shell and queue generation (FR-4.2). */
export async function createDocumentDraft(params: {
  actor: Actor;
  matterId: string;
  templateId: string;
  title: string;
}): Promise<string> {
  const [document] = await db
    .insert(documents)
    .values({
      matterId: params.matterId,
      templateId: params.templateId,
      title: params.title,
      state: 'draft',
      createdByUserId: params.actor.id,
    })
    .returning({ id: documents.id });

  if (!document) throw new Error('Could not create document');

  // Drafting is a Sonnet call per AI block plus retrieval; it runs in the
  // worker so the lawyer is not held on a request for up to two minutes
  // (NFR-3.2: "async with progress, never a blocking spinner").
  await enqueue(
    JOBS.GENERATE_DRAFT,
    { documentId: document.id, actorUserId: params.actor.id },
    { singletonKey: `draft-${document.id}` },
  );

  return document.id;
}

/** FR-4.5: a draft stays a draft until a permitted user marks it final. */
export async function finaliseDocument(params: {
  actor: Actor;
  documentId: string;
  matterId: string;
}): Promise<void> {
  const [document] = await db
    .select({
      id: documents.id,
      state: documents.state,
      currentVersionId: documents.currentVersionId,
    })
    .from(documents)
    .where(eq(documents.id, params.documentId))
    .limit(1);

  if (!document) throw new Error('Document not found');
  if (document.state === 'final') return; // already final; idempotent
  if (!document.currentVersionId) {
    throw new Error('Cannot finalise a document that has no generated version');
  }

  await db
    .update(documents)
    .set({ state: 'final', finalisedAt: new Date(), finalisedByUserId: params.actor.id })
    .where(eq(documents.id, params.documentId));

  await audit({
    action: AUDIT_ACTIONS.DOCUMENT_FINALISE,
    actorUserId: params.actor.id,
    actorEmail: params.actor.email,
    entityType: 'document',
    entityId: params.documentId,
    matterId: params.matterId,
    metadata: { versionId: document.currentVersionId },
  });
}

/** Re-run generation on an existing draft (a new version, never in place). */
export async function regenerateDraft(params: { actor: Actor; documentId: string }): Promise<void> {
  await enqueue(
    JOBS.GENERATE_DRAFT,
    { documentId: params.documentId, actorUserId: params.actor.id },
    { singletonKey: `draft-${params.documentId}-${Date.now()}` },
  );
}

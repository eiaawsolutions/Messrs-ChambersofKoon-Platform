'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { z } from 'zod';
import { requireActor, requestContext } from '@/lib/auth/session';
import { assertCan, getAuthorisedMatter, AuthorizationError } from '@/lib/auth/guard';
import { PERMISSIONS } from '@/lib/auth/permissions';
import {
  recordStatus,
  setCommsHold,
  createDocumentDraft,
  finaliseDocument,
} from '@/lib/matters/service';
import { recordRevision, RevisionRejected } from '@/lib/documents/revise';
import { raiseException } from '@/lib/comms/milestones';
import { audit, AUDIT_ACTIONS } from '@/lib/audit/log';

/**
 * Matter server actions (FR-4.5, FR-7.3, FR-7.4).
 *
 * Each action re-authorises against the specific matter. A server action is a
 * public endpoint; the button being hidden is not a control.
 */

async function authorise(matterId: string, permission: Parameters<typeof assertCan>[1]) {
  const actor = await requireActor();
  const matter = await getAuthorisedMatter(actor, matterId, permission);
  if (!matter) {
    const ctx = await requestContext();
    await audit({
      action: AUDIT_ACTIONS.MATTER_ACCESS_DENIED,
      actorUserId: actor.id,
      actorEmail: actor.email,
      entityType: 'matter',
      entityId: matterId,
      metadata: { permission },
      ...ctx,
    });
    throw new AuthorizationError(permission, matterId);
  }
  return { actor, matter };
}

const statusSchema = z.object({
  matterId: z.string().uuid(),
  stage: z.string().min(1).max(80),
  notes: z.string().max(2000).optional(),
  suppress: z.string().optional(),
});

/** FR-7.3: recording a stage queues the client email within 60 seconds. */
export async function recordStatusAction(formData: FormData): Promise<void> {
  const parsed = statusSchema.parse({
    matterId: formData.get('matterId'),
    stage: formData.get('stage'),
    notes: formData.get('notes') ?? undefined,
    suppress: formData.get('suppress') ?? undefined,
  });

  const { actor } = await authorise(parsed.matterId, PERMISSIONS.MATTER_STATUS_RECORD);

  await recordStatus({
    actor,
    matterId: parsed.matterId,
    stage: parsed.stage,
    notes: parsed.notes ?? null,
    suppressed: parsed.suppress === 'on',
  });

  revalidatePath(`/matters/${parsed.matterId}`);
}

const holdSchema = z.object({
  matterId: z.string().uuid(),
  hold: z.enum(['on', 'off']),
});

/** FR-7.4: "hold all client comms" on a sensitive matter. */
export async function setCommsHoldAction(formData: FormData): Promise<void> {
  const parsed = holdSchema.parse({
    matterId: formData.get('matterId'),
    hold: formData.get('hold'),
  });

  const { actor } = await authorise(parsed.matterId, PERMISSIONS.MATTER_EDIT);
  await setCommsHold({ actor, matterId: parsed.matterId, hold: parsed.hold === 'on' });

  revalidatePath(`/matters/${parsed.matterId}`);
}

const draftSchema = z.object({
  matterId: z.string().uuid(),
  templateId: z.string().uuid(),
  title: z.string().min(1).max(300),
});

export async function generateDraftAction(formData: FormData): Promise<void> {
  const parsed = draftSchema.parse({
    matterId: formData.get('matterId'),
    templateId: formData.get('templateId'),
    title: formData.get('title'),
  });

  const { actor } = await authorise(parsed.matterId, PERMISSIONS.DOCUMENT_GENERATE);

  const documentId = await createDocumentDraft({
    actor,
    matterId: parsed.matterId,
    templateId: parsed.templateId,
    title: parsed.title,
  });

  revalidatePath(`/matters/${parsed.matterId}`);
  redirect(`/documents/${documentId}`);
}

const finaliseSchema = z.object({ documentId: z.string().uuid(), matterId: z.string().uuid() });

/**
 * FR-4.5 / AT-06: finalisation is permission-gated server-side and audited.
 * A pupil reaching this action is blocked and the attempt recorded.
 */
export async function finaliseDocumentAction(formData: FormData): Promise<void> {
  const parsed = finaliseSchema.parse({
    documentId: formData.get('documentId'),
    matterId: formData.get('matterId'),
  });

  const actor = await requireActor();
  const matter = await getAuthorisedMatter(actor, parsed.matterId, PERMISSIONS.DOCUMENT_FINALISE);

  if (!matter) {
    const ctx = await requestContext();
    await audit({
      action: AUDIT_ACTIONS.DOCUMENT_FINALISE_BLOCKED,
      actorUserId: actor.id,
      actorEmail: actor.email,
      entityType: 'document',
      entityId: parsed.documentId,
      matterId: parsed.matterId,
      metadata: { role: actor.roleName, reason: 'not permitted' },
      ...ctx,
    });

    // The audit entry proves it happened; the exception task means someone is
    // actually told. A blocked finalise is either a role that needs widening
    // or a person reaching past their supervision — both are for the handling
    // lawyer to look at, and neither should wait for an audit review.
    await raiseException({
      matterId: parsed.matterId,
      kind: 'finalise_blocked',
      title: `${actor.fullName} was blocked from finalising a document`,
      detail:
        `Role "${actor.roleName}" does not carry permission to finalise. ` +
        'The attempt is in the audit log. Either the document needs a different ' +
        'reviewer, or this person needs supervision on it.',
    });

    // Surfaced on the document page rather than as an error screen: the person
    // did nothing wrong by trying, and a stack trace teaches them nothing.
    redirect(`/documents/${parsed.documentId}?denied=finalise`);
  }

  await finaliseDocument({ actor, documentId: parsed.documentId, matterId: parsed.matterId });

  revalidatePath(`/documents/${parsed.documentId}`);
  revalidatePath(`/matters/${parsed.matterId}`);
}

const reviseSchema = z.object({
  documentId: z.string().uuid(),
  matterId: z.string().uuid(),
  note: z.string().max(2000).optional(),
});

/**
 * FR-4.6: the lawyer's amended .docx becomes the next version.
 *
 * Gated on DOCUMENT_GENERATE, not DOCUMENT_FINALISE — amending a draft is
 * drafting. A pupil may revise; only an associate and above may finalise.
 */
export async function reviseDocumentAction(formData: FormData): Promise<void> {
  const parsed = reviseSchema.parse({
    documentId: formData.get('documentId'),
    matterId: formData.get('matterId'),
    note: formData.get('note') || undefined,
  });

  const { actor } = await authorise(parsed.matterId, PERMISSIONS.DOCUMENT_GENERATE);

  const file = formData.get('file');
  if (!(file instanceof File) || file.size === 0) {
    redirect(`/documents/${parsed.documentId}?revision=no_file`);
  }

  let outcome: 'saved' | string;
  try {
    await recordRevision({
      actor,
      documentId: parsed.documentId,
      matterId: parsed.matterId,
      filename: file.name,
      bytes: Buffer.from(await file.arrayBuffer()),
      note: parsed.note ?? null,
    });
    outcome = 'saved';
  } catch (error) {
    if (!(error instanceof RevisionRejected)) throw error;
    outcome = error.code;
  }

  revalidatePath(`/documents/${parsed.documentId}`);
  revalidatePath(`/matters/${parsed.matterId}`);
  redirect(`/documents/${parsed.documentId}?revision=${outcome}`);
}

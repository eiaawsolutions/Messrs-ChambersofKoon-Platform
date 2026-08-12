'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { requireActor } from '@/lib/auth/session';
import { loadProposalForDecision } from '@/lib/queries/dashboard';
import { assertCan, getAuthorisedMatter } from '@/lib/auth/guard';
import { PERMISSIONS } from '@/lib/auth/permissions';
import { acceptProposal, declineProposal, rescheduleProposal } from '@/lib/scheduling/service';
import { releaseHeldEnquiry } from '@/lib/intake/duplicate-check';
import { enqueue, JOBS } from '@/lib/jobs/queue';
import { audit, AUDIT_ACTIONS } from '@/lib/audit/log';
import { requestContext } from '@/lib/auth/session';

/**
 * Intake queue server actions (FR-3.3, FR-8.3).
 *
 * Every action re-authorises. A server action is a public HTTP endpoint with a
 * generated name — treating it as trusted because the UI only renders the
 * button for permitted users is the classic mistake.
 *
 * A proposal is only decidable by the lawyer it was proposed to, or by someone
 * whose scope covers them. That check is here rather than in the service so the
 * service stays usable from the job worker, which has no actor.
 */

async function assertMayDecide(proposalId: string) {
  const actor = await requireActor();
  assertCan(actor, PERMISSIONS.PROPOSAL_DECIDE);

  const proposal = await loadProposalForDecision(actor, proposalId);

  if (!proposal) {
    const ctx = await requestContext();
    await audit({
      action: AUDIT_ACTIONS.MATTER_ACCESS_DENIED,
      actorUserId: actor.id,
      actorEmail: actor.email,
      entityType: 'appointment_proposal',
      entityId: proposalId,
      metadata: { permission: PERMISSIONS.PROPOSAL_DECIDE },
      ...ctx,
    });
    // Same error whether it does not exist or is not theirs (no enumeration).
    throw new Error('Not authorised');
  }

  return { actor, proposal };
}

const decideSchema = z.object({ proposalId: z.string().uuid() });

export async function acceptProposalAction(formData: FormData): Promise<void> {
  const { proposalId } = decideSchema.parse({ proposalId: formData.get('proposalId') });
  const { actor } = await assertMayDecide(proposalId);

  await acceptProposal({ actor, proposalId });

  revalidatePath('/intake');
  revalidatePath('/dashboard');
}

const declineSchema = decideSchema.extend({
  reason: z.string().min(1).max(1000),
});

export async function declineProposalAction(formData: FormData): Promise<void> {
  const parsed = declineSchema.parse({
    proposalId: formData.get('proposalId'),
    reason: formData.get('reason'),
  });
  const { actor } = await assertMayDecide(parsed.proposalId);

  await declineProposal({ actor, proposalId: parsed.proposalId, reason: parsed.reason });

  revalidatePath('/intake');
  revalidatePath('/dashboard');
}

const rescheduleSchema = decideSchema.extend({
  startsAt: z.string().datetime(),
  endsAt: z.string().datetime(),
});

export async function rescheduleProposalAction(formData: FormData): Promise<void> {
  const parsed = rescheduleSchema.parse({
    proposalId: formData.get('proposalId'),
    startsAt: formData.get('startsAt'),
    endsAt: formData.get('endsAt'),
  });
  const { actor } = await assertMayDecide(parsed.proposalId);

  await rescheduleProposal({
    actor,
    proposalId: parsed.proposalId,
    startsAt: new Date(parsed.startsAt),
    endsAt: new Date(parsed.endsAt),
  });

  revalidatePath('/intake');
  revalidatePath('/dashboard');
}

/** FR-2.6 / FR-8.3: re-run triage after a human corrects the classification. */
const retriageSchema = z.object({ enquiryId: z.string().uuid() });

export async function retriageEnquiryAction(formData: FormData): Promise<void> {
  const { enquiryId } = retriageSchema.parse({ enquiryId: formData.get('enquiryId') });
  const actor = await requireActor();
  assertCan(actor, PERMISSIONS.INTAKE_TRIAGE);

  await enqueue(JOBS.TRIAGE_ENQUIRY, { enquiryId }, { singletonKey: `triage-${enquiryId}` });

  await audit({
    action: AUDIT_ACTIONS.ENQUIRY_TRIAGE_OVERRIDE,
    actorUserId: actor.id,
    actorEmail: actor.email,
    entityType: 'enquiry',
    entityId: enquiryId,
    metadata: { requeued: true },
  });

  revalidatePath('/intake');
}

/**
 * FR-2.8: put a held enquiry back in front of a human.
 *
 * Gated on INTAKE_TRIAGE, the same permission as correcting a classification —
 * because that is what this is. Deciding a flagged enquiry is genuine is a
 * triage judgement, and the audit records who made it.
 */
export async function releaseEnquiryAction(formData: FormData): Promise<void> {
  const { enquiryId } = retriageSchema.parse({ enquiryId: formData.get('enquiryId') });
  const actor = await requireActor();
  assertCan(actor, PERMISSIONS.INTAKE_TRIAGE);

  await releaseHeldEnquiry({ actor, enquiryId });

  revalidatePath('/intake');
  revalidatePath('/dashboard');
}

/** Manually propose a slot for an enquiry a human has corrected. */
export async function proposeForEnquiryAction(formData: FormData): Promise<void> {
  const { enquiryId } = retriageSchema.parse({ enquiryId: formData.get('enquiryId') });
  const actor = await requireActor();
  assertCan(actor, PERMISSIONS.PROPOSAL_DECIDE);

  await enqueue(JOBS.PROPOSE_SLOT, { enquiryId }, { singletonKey: `propose-${enquiryId}` });
  revalidatePath('/intake');
}

/** Used by the matter view; kept here so all intake authorisation lives together. */
export async function assertMatterAccess(matterId: string) {
  const actor = await requireActor();
  const matter = await getAuthorisedMatter(actor, matterId);
  if (!matter) throw new Error('Not authorised');
  return { actor, matter };
}

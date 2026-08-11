import 'server-only';
import { and, count, desc, eq, or } from 'drizzle-orm';
import { db } from '@/lib/db/client';
import {
  appointmentProposals,
  documents,
  enquiries,
  exceptionTasks,
  matters,
  users,
} from '@/lib/db/schema';
import { can, matterScopeFilter, type Actor } from '@/lib/auth/guard';
import { PERMISSIONS } from '@/lib/auth/permissions';

/**
 * Read models for the authenticated pages.
 *
 * Every function here takes an `Actor` and applies the permission scope
 * itself. That is a stronger guarantee than the ESLint rule which keeps `db`
 * out of `src/app/**`: it is impossible to *call* one of these without having
 * resolved an actor first, so an unscoped read cannot be written by accident.
 */

export async function pendingProposalsFor(actor: Actor) {
  if (!can(actor, PERMISSIONS.PROPOSAL_DECIDE)) return [];

  const scope = actor.grants[PERMISSIONS.PROPOSAL_DECIDE];
  const mineOnly = scope === 'own';

  return db
    .select({
      id: appointmentProposals.id,
      startsAt: appointmentProposals.startsAt,
      endsAt: appointmentProposals.endsAt,
      expiresAt: appointmentProposals.expiresAt,
      proposedUserId: appointmentProposals.proposedUserId,
      lawyerName: users.fullName,
      enquiryId: enquiries.id,
      contactName: enquiries.contactName,
      practiceArea: enquiries.practiceAreaPredicted,
      urgency: enquiries.urgency,
      confidence: enquiries.confidence,
      caseBriefMd: enquiries.caseBriefMd,
    })
    .from(appointmentProposals)
    .innerJoin(enquiries, eq(enquiries.id, appointmentProposals.enquiryId))
    .innerJoin(users, eq(users.id, appointmentProposals.proposedUserId))
    .where(
      mineOnly
        ? and(
            eq(appointmentProposals.state, 'pending'),
            eq(appointmentProposals.proposedUserId, actor.id),
          )
        : eq(appointmentProposals.state, 'pending'),
    )
    .orderBy(appointmentProposals.startsAt)
    .limit(40);
}

export async function draftsAwaitingReview(actor: Actor, limit = 8) {
  const scope = matterScopeFilter(actor, PERMISSIONS.MATTER_VIEW);

  return db
    .select({
      id: documents.id,
      title: documents.title,
      matterId: documents.matterId,
      reference: matters.reference,
      updatedAt: documents.updatedAt,
    })
    .from(documents)
    .innerJoin(matters, eq(matters.id, documents.matterId))
    .where(scope ? and(eq(documents.state, 'draft'), scope) : eq(documents.state, 'draft'))
    .orderBy(desc(documents.updatedAt))
    .limit(limit);
}

export async function openExceptionsFor(actor: Actor, limit = 8) {
  return db
    .select({
      id: exceptionTasks.id,
      title: exceptionTasks.title,
      kind: exceptionTasks.kind,
      createdAt: exceptionTasks.createdAt,
    })
    .from(exceptionTasks)
    .where(and(eq(exceptionTasks.state, 'open'), eq(exceptionTasks.assignedUserId, actor.id)))
    .orderBy(desc(exceptionTasks.createdAt))
    .limit(limit);
}

export async function needsHumanReviewCount(actor: Actor): Promise<number> {
  if (!can(actor, PERMISSIONS.INTAKE_VIEW)) return 0;
  const [row] = await db
    .select({ value: count() })
    .from(enquiries)
    .where(eq(enquiries.status, 'needs_review'));
  return row?.value ?? 0;
}

export async function enquiriesNeedingReview(actor: Actor, limit = 40) {
  if (!can(actor, PERMISSIONS.INTAKE_VIEW)) return [];

  return db
    .select({
      id: enquiries.id,
      contactName: enquiries.contactName,
      contactEmail: enquiries.contactEmail,
      practiceArea: enquiries.practiceAreaPredicted,
      urgency: enquiries.urgency,
      confidence: enquiries.confidence,
      caseBriefMd: enquiries.caseBriefMd,
      status: enquiries.status,
      createdAt: enquiries.createdAt,
    })
    .from(enquiries)
    .where(or(eq(enquiries.status, 'needs_review'), eq(enquiries.status, 'new')))
    .orderBy(desc(enquiries.createdAt))
    .limit(limit);
}

/**
 * Load a proposal for a decision, authorising the actor against it.
 *
 * Returns null both when the proposal does not exist and when it is not the
 * actor's to decide — the caller cannot distinguish the two, which is what
 * stops proposal-id enumeration.
 */
export async function loadProposalForDecision(
  actor: Actor,
  proposalId: string,
): Promise<{ id: string; proposedUserId: string; state: string } | null> {
  if (!can(actor, PERMISSIONS.PROPOSAL_DECIDE)) return null;

  const [proposal] = await db
    .select({
      id: appointmentProposals.id,
      proposedUserId: appointmentProposals.proposedUserId,
      state: appointmentProposals.state,
    })
    .from(appointmentProposals)
    .where(eq(appointmentProposals.id, proposalId))
    .limit(1);

  if (!proposal) return null;

  const scope = actor.grants[PERMISSIONS.PROPOSAL_DECIDE];
  if (scope === 'own' && proposal.proposedUserId !== actor.id) return null;

  return proposal;
}

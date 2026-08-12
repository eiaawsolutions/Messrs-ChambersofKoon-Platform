import 'server-only';
import { and, count, desc, eq, or, sql, type SQL } from 'drizzle-orm';
import { db } from '@/lib/db/client';
import {
  appointmentProposals,
  documents,
  enquiries,
  exceptionTasks,
  matters,
  users,
  type Office,
} from '@/lib/db/schema';
import { can, matterScopeFilter, type Actor } from '@/lib/auth/guard';
import { PERMISSIONS, type PermissionKey } from '@/lib/auth/permissions';

/** Matches nothing. Used when a permission is absent entirely. */
const DENY_ALL: SQL = sql`false`;

/**
 * Read models for the authenticated pages.
 *
 * Every function here takes an `Actor` and applies the permission scope
 * itself. That is a stronger guarantee than the ESLint rule which keeps `db`
 * out of `src/app/**`: it is impossible to *call* one of these without having
 * resolved an actor first, so an unscoped read cannot be written by accident.
 */

/**
 * Office/practice-area predicate for enquiry-shaped rows (FR-8.5).
 *
 * `matterScopeFilter` cannot serve here: an enquiry is not a matter and has no
 * assignee until it is routed, so the matter predicate would filter on columns
 * that do not exist. This is its counterpart, reading `enquiries.office`.
 *
 * `own` deliberately resolves to the office predicate rather than to nothing.
 * An enquiry awaiting triage belongs to no one by definition — that is what
 * makes it a review item — so an "own" reading would empty the queue FR-2.6
 * requires a human to work through. No stock role grants `intake.view` at
 * `own`; this only decides what a custom role built through FR-1.6 does.
 */
function enquiryScopeFilter(actor: Actor, permission: PermissionKey): SQL | null {
  const scope = actor.grants[permission];
  if (!scope) return DENY_ALL;
  if (scope === 'all') return null;

  const officeMatch = eq(enquiries.office, actor.office);
  if (actor.practiceAreas && actor.practiceAreas.length > 0) {
    const areaMatch = or(
      ...actor.practiceAreas.map((area) => eq(enquiries.practiceAreaPredicted, area)),
    );
    return and(officeMatch, areaMatch!)!;
  }
  return officeMatch;
}

/**
 * A caller who may read every office can narrow to one (FR-8.5, the per-office
 * view). A caller who may not is unaffected by the parameter — their own scope
 * has already been applied and this can only narrow further, never widen.
 */
function officeView(scoped: SQL | null, office: Office | null): SQL | null {
  if (!office) return scoped;
  const pick = eq(enquiries.office, office);
  return scoped ? and(scoped, pick)! : pick;
}

export async function pendingProposalsFor(actor: Actor, office: Office | null = null) {
  if (!can(actor, PERMISSIONS.PROPOSAL_DECIDE)) return [];

  const scope = actor.grants[PERMISSIONS.PROPOSAL_DECIDE];
  const mineOnly = scope === 'own';

  /*
   * An office-scoped practice lead sees their own office's queue and no other.
   * Before this predicate existed only `own` was special-cased, so every scope
   * above it read as firm-wide — a Petaling Jaya lead was shown Kuala Lumpur's
   * proposals, with the enquirer's name and case brief attached.
   */
  const scoped = mineOnly
    ? eq(appointmentProposals.proposedUserId, actor.id)
    : enquiryScopeFilter(actor, PERMISSIONS.PROPOSAL_DECIDE);

  const visible = officeView(scoped, office);

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
      visible
        ? and(eq(appointmentProposals.state, 'pending'), visible)
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

export async function needsHumanReviewCount(
  actor: Actor,
  office: Office | null = null,
): Promise<number> {
  if (!can(actor, PERMISSIONS.INTAKE_VIEW)) return 0;

  const visible = officeView(enquiryScopeFilter(actor, PERMISSIONS.INTAKE_VIEW), office);

  const [row] = await db
    .select({ value: count() })
    .from(enquiries)
    .where(
      visible
        ? and(eq(enquiries.status, 'needs_review'), visible)
        : eq(enquiries.status, 'needs_review'),
    );
  return row?.value ?? 0;
}

export async function enquiriesNeedingReview(
  actor: Actor,
  office: Office | null = null,
  limit = 40,
) {
  if (!can(actor, PERMISSIONS.INTAKE_VIEW)) return [];

  const visible = officeView(enquiryScopeFilter(actor, PERMISSIONS.INTAKE_VIEW), office);
  const unresolved = or(eq(enquiries.status, 'needs_review'), eq(enquiries.status, 'new'))!;

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
      office: enquiries.office,
      duplicateOfEnquiryId: enquiries.duplicateOfEnquiryId,
      createdAt: enquiries.createdAt,
    })
    .from(enquiries)
    .where(visible ? and(unresolved, visible) : unresolved)
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

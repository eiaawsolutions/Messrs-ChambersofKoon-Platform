import 'server-only';
import { and, desc, eq } from 'drizzle-orm';
import { db } from '@/lib/db/client';
import { appointmentProposals, appointments, enquiries, users } from '@/lib/db/schema';
import { candidateSlots, loadHolidayKeys } from '@/lib/scheduling/service';
import { computeExpiry, formatSlotForClient, type Slot } from '@/lib/scheduling/slots';
import {
  evaluateRescheduleLink,
  matchOfferedSlot,
  type RescheduleBlockedCode,
} from '@/lib/scheduling/reschedule-link';
import { checkRateLimit, type RateLimitRule } from '@/lib/intake/protection';
import { sha256 } from '@/lib/security/crypto';
import { audit, AUDIT_ACTIONS } from '@/lib/audit/log';
import { config } from '@/lib/config/env';
import { loadTemplate } from '@/lib/comms/templates';
import { sendEmail, renderTemplate } from '@/lib/email/resend';

/**
 * Client-initiated reschedule (FR-3.8), the database half.
 *
 * The decisions live in `reschedule-link.ts` and are unit tested there; this
 * module reads and writes the rows they decide about. Two properties are worth
 * stating because they are easy to lose in a later edit:
 *
 * - **Nothing here emails the client.** The only outbound mail is to the
 *   lawyer. The client already knows what they asked for; they hear back when
 *   a lawyer accepts, through the existing `.ics` path. That keeps FR-3.4
 *   true — no client-facing invitation until a lawyer acts — and means a
 *   reschedule request cannot be used to make the platform send mail to an
 *   arbitrary address.
 *
 * - **The existing appointment is untouched.** It stays confirmed, in the
 *   client's calendar, until a lawyer accepts the new proposal. A request that
 *   is never accepted leaves the original consultation standing rather than
 *   silently deleting it.
 */

/**
 * Reschedule requests per IP per day.
 *
 * Deliberately tighter than the enquiry limits: a client rescheduling one
 * consultation needs a handful of page loads, not forty, and the only party
 * who benefits from a higher ceiling is someone hammering tokens.
 */
const RESCHEDULE_RATE_LIMIT: RateLimitRule = { limit: 20, windowSeconds: 86_400 };

const SLOT_OPTIONS = 6;

export interface RescheduleOption {
  /** Round-trips through the form; re-matched server-side before use. */
  startsAtIso: string;
  label: string;
}

export interface RescheduleView {
  lawyerName: string;
  currentWhen: string;
  location: string;
  options: RescheduleOption[];
}

export type RescheduleLookup =
  { openable: true; view: RescheduleView } | { openable: false; code: RescheduleBlockedCode };

interface TokenMatch {
  appointmentId: string;
  enquiryId: string | null;
  userId: string;
  state: 'confirmed' | 'cancelled' | 'rescheduled';
  startsAt: Date;
  endsAt: Date;
  location: string;
  lawyerName: string;
  office: 'KL' | 'PJ' | 'IPOH';
  practiceArea:
    'family_matrimonial' | 'debt_recovery' | 'land_property' | 'corporate_disputes' | 'general';
}

/**
 * Resolve a raw token to its appointment.
 *
 * The token is never stored, only its SHA-256, so this hashes and looks up the
 * hash. There is no timing concern worth mitigating here: the comparison is an
 * indexed equality on a 256-bit digest, and an attacker who could measure it
 * would still need to produce a preimage.
 */
async function matchToken(token: string): Promise<TokenMatch | null> {
  if (!token) return null;

  const [row] = await db
    .select({
      appointmentId: appointments.id,
      enquiryId: appointments.enquiryId,
      userId: appointments.userId,
      state: appointments.state,
      startsAt: appointments.startsAt,
      endsAt: appointments.endsAt,
      location: appointments.location,
      lawyerName: users.fullName,
      userOffice: users.office,
      enquiryOffice: enquiries.office,
      practiceArea: enquiries.practiceAreaPredicted,
    })
    .from(appointments)
    .innerJoin(users, eq(users.id, appointments.userId))
    .leftJoin(enquiries, eq(enquiries.id, appointments.enquiryId))
    .where(eq(appointments.rescheduleTokenHash, sha256(token)))
    .limit(1);

  if (!row) return null;

  return {
    appointmentId: row.appointmentId,
    enquiryId: row.enquiryId,
    userId: row.userId,
    state: row.state,
    startsAt: row.startsAt,
    endsAt: row.endsAt,
    location: row.location,
    lawyerName: row.lawyerName,
    // The enquiry records where it was routed; the lawyer's own office is the
    // fallback for an appointment whose enquiry has since been purged.
    office: row.enquiryOffice ?? row.userOffice,
    practiceArea: row.practiceArea ?? 'general',
  };
}

/** Is there an undecided proposal on this enquiry already? */
async function hasPendingProposal(enquiryId: string | null): Promise<boolean> {
  if (!enquiryId) return false;
  const [row] = await db
    .select({ id: appointmentProposals.id })
    .from(appointmentProposals)
    .where(
      and(eq(appointmentProposals.enquiryId, enquiryId), eq(appointmentProposals.state, 'pending')),
    )
    .limit(1);
  return Boolean(row);
}

async function offerFor(match: TokenMatch): Promise<Slot[]> {
  return candidateSlots({
    userId: match.userId,
    office: match.office,
    practiceArea: match.practiceArea,
    limit: SLOT_OPTIONS,
  });
}

function toOption(slot: Slot): RescheduleOption {
  return { startsAtIso: slot.startsAt.toISOString(), label: formatSlotForClient(slot) };
}

/** What the page renders for a given token. */
export async function lookupRescheduleLink(token: string): Promise<RescheduleLookup> {
  const match = await matchToken(token);

  const state = evaluateRescheduleLink({
    appointment: match ? { state: match.state, startsAt: match.startsAt } : null,
    hasPendingProposal: match ? await hasPendingProposal(match.enquiryId) : false,
    now: new Date(),
  });

  if (!state.openable) return state;
  if (!match) return { openable: false, code: 'unknown' };

  return {
    openable: true,
    view: {
      lawyerName: match.lawyerName,
      currentWhen: formatSlotForClient({ startsAt: match.startsAt, endsAt: match.endsAt }),
      location: match.location,
      options: (await offerFor(match)).map(toOption),
    },
  };
}

export type RescheduleSubmission =
  | { ok: true }
  | { ok: false; code: RescheduleBlockedCode | 'slot_taken' | 'rate_limited' | 'no_enquiry' };

/**
 * Record the client's choice as a proposal for lawyer approval (FR-3.8).
 *
 * Every check the page made is made again here. The page is a rendering of
 * this state, not a gate on it — a form posted straight at the action, or
 * replayed an hour later, has to clear the same conditions.
 */
export async function submitRescheduleRequest(params: {
  token: string;
  startsAtIso: string;
  ip: string | null;
}): Promise<RescheduleSubmission> {
  const limit = await checkRateLimit(`reschedule:${params.ip ?? 'unknown'}`, RESCHEDULE_RATE_LIMIT);
  if (!limit.allowed) return { ok: false, code: 'rate_limited' };

  const match = await matchToken(params.token);
  const state = evaluateRescheduleLink({
    appointment: match ? { state: match.state, startsAt: match.startsAt } : null,
    hasPendingProposal: match ? await hasPendingProposal(match.enquiryId) : false,
    now: new Date(),
  });
  if (!state.openable) return { ok: false, code: state.code };
  if (!match) return { ok: false, code: 'unknown' };

  // A proposal hangs off an enquiry. An appointment whose enquiry was purged
  // at its retention date can no longer be rescheduled this way; the page
  // tells the client to phone the office rather than failing obscurely.
  if (!match.enquiryId) return { ok: false, code: 'no_enquiry' };

  // Re-derived, not trusted: the slot must still be one the rules offer now.
  const chosen = matchOfferedSlot(await offerFor(match), params.startsAtIso);
  if (!chosen) return { ok: false, code: 'slot_taken' };

  const expiresAt = computeExpiry({
    from: new Date(),
    workingHours: config().PROPOSAL_EXPIRY_WORKING_HOURS,
    holidayDateKeys: await loadHolidayKeys(match.office),
  });

  const [superseded] = await db
    .select({ id: appointmentProposals.id })
    .from(appointmentProposals)
    .where(eq(appointmentProposals.enquiryId, match.enquiryId))
    .orderBy(desc(appointmentProposals.createdAt))
    .limit(1);

  const [created] = await db
    .insert(appointmentProposals)
    .values({
      enquiryId: match.enquiryId,
      proposedUserId: match.userId,
      startsAt: chosen.startsAt,
      endsAt: chosen.endsAt,
      state: 'pending',
      expiresAt,
      supersedesProposalId: superseded?.id ?? null,
    })
    .returning({ id: appointmentProposals.id });

  await db
    .update(enquiries)
    .set({ status: 'slot_proposed' })
    .where(eq(enquiries.id, match.enquiryId));

  await audit({
    action: AUDIT_ACTIONS.PROPOSAL_CREATED,
    entityType: 'appointment_proposal',
    entityId: created?.id ?? null,
    ip: params.ip,
    metadata: {
      enquiryId: match.enquiryId,
      proposedUserId: match.userId,
      startsAt: chosen.startsAt.toISOString(),
      expiresAt: expiresAt.toISOString(),
      // The distinguishing fact when this is read back: the client asked, not
      // the triage agent, and the appointment it replaces is already confirmed.
      requestedBy: 'client_reschedule_link',
      supersedesAppointmentId: match.appointmentId,
      clientNotified: false,
    },
  });

  await notifyLawyer({
    match,
    slot: chosen,
    proposalId: created?.id ?? match.appointmentId,
  });

  return { ok: true };
}

/**
 * Tell the lawyer their client asked to move.
 *
 * Failure here is logged and swallowed, exactly as in `proposeSlot`: the
 * proposal row is already committed and visible in the intake queue, and
 * throwing would leave the client believing the request had not registered
 * when it had.
 */
async function notifyLawyer(params: {
  match: TokenMatch;
  slot: Slot;
  proposalId: string;
}): Promise<void> {
  const [lawyer] = await db
    .select({ email: users.email })
    .from(users)
    .where(eq(users.id, params.match.userId))
    .limit(1);
  if (!lawyer) return;

  try {
    const template = await loadTemplate('internal.client_reschedule_requested');
    const variables = {
      lawyerName: params.match.lawyerName,
      currentWhen: formatSlotForClient({
        startsAt: params.match.startsAt,
        endsAt: params.match.endsAt,
      }),
      requestedWhen: formatSlotForClient(params.slot),
      dashboardUrl: `${config().APP_BASE_URL}/intake`,
      firmName: config().FIRM_NAME,
    };

    await sendEmail({
      to: lawyer.email,
      subject: template
        ? renderTemplate(template.subject, variables)
        : `A client has asked to move their consultation — ${config().FIRM_SHORT_NAME}`,
      text: template
        ? renderTemplate(template.bodyMd, variables)
        : `${variables.currentWhen} → ${variables.requestedWhen}\n\nNothing has been confirmed. Accept or decline in ${variables.dashboardUrl}.`,
      idempotencyKey: `reschedule-request-${params.proposalId}`,
    });
  } catch (error) {
    console.error(
      '[schedule] client reschedule %s recorded but the lawyer notification failed: %s',
      params.proposalId,
      (error as Error).message,
    );
  }
}

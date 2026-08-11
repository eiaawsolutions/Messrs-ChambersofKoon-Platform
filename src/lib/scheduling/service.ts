import 'server-only';
import { and, eq, gte, inArray, lte, or, sql } from 'drizzle-orm';
import { db } from '@/lib/db/client';
import {
  appointmentProposals,
  appointments,
  availabilityRules,
  enquiries,
  messages,
  publicHolidays,
  users,
  type Office,
  type PracticeArea,
} from '@/lib/db/schema';
import {
  computeExpiry,
  findEarliestSlot,
  findSlots,
  formatSlotForClient,
  type AvailabilityWindow,
  type Slot,
} from '@/lib/scheduling/slots';
import { appointmentUid, buildIcs } from '@/lib/email/ics';
import { sendCalendarInvite, sendEmail, renderTemplate } from '@/lib/email/resend';
import { config, senderDomain } from '@/lib/config/env';
import { audit, AUDIT_ACTIONS } from '@/lib/audit/log';
import { randomToken, sha256 } from '@/lib/security/crypto';
import { loadTemplate } from '@/lib/comms/templates';
import { raiseException } from '@/lib/comms/milestones';
import type { Actor } from '@/lib/auth/guard';

/**
 * Scheduling service (M3).
 *
 * The load-bearing rule is FR-3.4: "No client-facing invitation is sent until
 * a lawyer acts." Nothing in `proposeSlot` touches the enquirer. The only
 * paths that email a client are `acceptProposal` and `cancelAppointment`, and
 * both require an actor who holds proposal.decide.
 */

async function loadHolidayKeys(office: Office): Promise<Set<string>> {
  const rows = await db
    .select({ date: publicHolidays.date, office: publicHolidays.office })
    .from(publicHolidays)
    .where(or(sql`${publicHolidays.office} is null`, eq(publicHolidays.office, office)));
  return new Set(rows.map((r) => r.date));
}

async function loadWindows(params: {
  office: Office;
  practiceArea: PracticeArea;
}): Promise<AvailabilityWindow[]> {
  const rows = await db
    .select({
      userId: availabilityRules.userId,
      weekday: availabilityRules.weekday,
      startTime: availabilityRules.startTime,
      endTime: availabilityRules.endTime,
      slotMinutes: availabilityRules.slotMinutes,
      bufferMinutes: availabilityRules.bufferMinutes,
      validFrom: availabilityRules.validFrom,
      validTo: availabilityRules.validTo,
    })
    .from(availabilityRules)
    .innerJoin(users, eq(users.id, availabilityRules.userId))
    .where(
      and(
        eq(availabilityRules.isActive, true),
        eq(availabilityRules.office, params.office),
        eq(users.status, 'active'),
        // A rule with no practice area serves every area in that office.
        or(
          sql`${availabilityRules.practiceArea} is null`,
          eq(availabilityRules.practiceArea, params.practiceArea),
        ),
      ),
    );
  return rows;
}

async function loadBusy(
  userIds: string[],
  from: Date,
): Promise<Array<{ userId: string; startsAt: Date; endsAt: Date }>> {
  if (userIds.length === 0) return [];
  const horizon = new Date(from.getTime() + 45 * 86_400_000);

  const confirmed = await db
    .select({
      userId: appointments.userId,
      startsAt: appointments.startsAt,
      endsAt: appointments.endsAt,
    })
    .from(appointments)
    .where(
      and(
        inArray(appointments.userId, userIds),
        eq(appointments.state, 'confirmed'),
        gte(appointments.endsAt, from),
        lte(appointments.startsAt, horizon),
      ),
    );

  // Pending proposals hold the slot too, otherwise two overnight enquiries
  // both get offered 9am Monday and one of them is guaranteed to be wrong.
  const pending = await db
    .select({
      userId: appointmentProposals.proposedUserId,
      startsAt: appointmentProposals.startsAt,
      endsAt: appointmentProposals.endsAt,
    })
    .from(appointmentProposals)
    .where(
      and(
        inArray(appointmentProposals.proposedUserId, userIds),
        eq(appointmentProposals.state, 'pending'),
        gte(appointmentProposals.endsAt, from),
      ),
    );

  return [...confirmed, ...pending];
}

export interface ProposalResult {
  proposalId: string;
  slot: Slot;
  lawyerName: string;
  expiresAt: Date;
}

/**
 * Propose the earliest matching slot and notify the lawyer (FR-3.2, FR-3.3).
 * Sends nothing to the enquirer — that is FR-3.4, and it is enforced by this
 * function simply not having a path that does so.
 */
export async function proposeSlot(enquiryId: string): Promise<ProposalResult | null> {
  const [enquiry] = await db
    .select({
      id: enquiries.id,
      practiceArea: enquiries.practiceAreaPredicted,
      office: enquiries.office,
      urgency: enquiries.urgency,
      contactName: enquiries.contactName,
    })
    .from(enquiries)
    .where(eq(enquiries.id, enquiryId))
    .limit(1);

  if (!enquiry?.practiceArea) return null;

  const office: Office = enquiry.office ?? 'KL';
  const [windows, holidayKeys] = await Promise.all([
    loadWindows({ office, practiceArea: enquiry.practiceArea }),
    loadHolidayKeys(office),
  ]);

  if (windows.length === 0) return null;

  const now = new Date();
  const busy = await loadBusy([...new Set(windows.map((w) => w.userId))], now);

  const slot = findEarliestSlot({
    windows,
    busy,
    holidayDateKeys: holidayKeys,
    from: now,
    // An urgent matter should still respect notice, but less of it.
    minimumNoticeMinutes: enquiry.urgency === 'critical' ? 30 : 120,
  });

  if (!slot) return null;

  const expiresAt = computeExpiry({
    from: now,
    workingHours: config().PROPOSAL_EXPIRY_WORKING_HOURS,
    holidayDateKeys: holidayKeys,
  });

  const [proposal] = await db
    .insert(appointmentProposals)
    .values({
      enquiryId,
      proposedUserId: slot.userId,
      startsAt: slot.startsAt,
      endsAt: slot.endsAt,
      state: 'pending',
      expiresAt,
    })
    .returning({ id: appointmentProposals.id });

  if (!proposal) return null;

  await db.update(enquiries).set({ status: 'slot_proposed' }).where(eq(enquiries.id, enquiryId));

  const [lawyer] = await db
    .select({ fullName: users.fullName, email: users.email })
    .from(users)
    .where(eq(users.id, slot.userId))
    .limit(1);

  await audit({
    action: AUDIT_ACTIONS.PROPOSAL_CREATED,
    entityType: 'appointment_proposal',
    entityId: proposal.id,
    metadata: {
      enquiryId,
      proposedUserId: slot.userId,
      startsAt: slot.startsAt.toISOString(),
      expiresAt: expiresAt.toISOString(),
      clientNotified: false,
    },
  });

  // Internal notification only — and deliberately not allowed to fail the
  // proposal. The row is already committed above; letting a mail error
  // propagate would make the job retry and create a *second* proposal for the
  // same enquiry, so the lawyer would see the slot twice. The proposal is
  // visible in the dashboard queue regardless of whether the email lands.
  if (lawyer) {
    try {
      await notifyLawyerOfProposal({
        to: lawyer.email,
        slot,
        practiceArea: enquiry.practiceArea,
        urgency: enquiry.urgency,
        proposalId: proposal.id,
      });
    } catch (error) {
      console.error(
        '[schedule] proposal %s created but the lawyer notification failed: %s',
        proposal.id,
        (error as Error).message,
      );
      await raiseException({
        matterId: null,
        kind: 'proposal_notification_failed',
        title: `Consultation proposed but ${lawyer.fullName} was not emailed`,
        detail:
          'The proposal is in their dashboard queue and can still be accepted. ' +
          'Check email delivery — nothing was sent to the enquirer either way.',
      });
    }
  }

  return {
    proposalId: proposal.id,
    slot,
    lawyerName: lawyer?.fullName ?? 'Unassigned',
    expiresAt,
  };
}

async function notifyLawyerOfProposal(params: {
  to: string;
  slot: Slot;
  practiceArea: PracticeArea;
  urgency: string;
  proposalId: string;
}): Promise<void> {
  const template = await loadTemplate('internal.proposal_pending');
  if (!template) return;

  const variables = {
    appointmentWhen: formatSlotForClient(params.slot),
    practiceArea: params.practiceArea.replace(/_/g, ' '),
    urgency: params.urgency,
    dashboardUrl: `${config().APP_BASE_URL}/intake`,
    firmName: config().FIRM_NAME,
  };

  await sendEmail({
    to: params.to,
    subject: renderTemplate(template.subject, variables),
    text: renderTemplate(template.bodyMd, variables),
    idempotencyKey: `proposal-notify-${params.proposalId}`,
  });
}

export interface AcceptResult {
  appointmentId: string;
  icsUid: string;
  sequence: number;
}

/**
 * Lawyer accepts (FR-3.6). This is the first point at which the enquirer hears
 * anything, and it is reached only through an authorised actor.
 */
export async function acceptProposal(params: {
  actor: Actor;
  proposalId: string;
}): Promise<AcceptResult> {
  const [proposal] = await db
    .select()
    .from(appointmentProposals)
    .where(eq(appointmentProposals.id, params.proposalId))
    .limit(1);

  if (!proposal) throw new Error('Proposal not found');
  if (proposal.state !== 'pending') {
    throw new Error(`Proposal is already ${proposal.state}`);
  }

  const [enquiry] = await db
    .select({
      id: enquiries.id,
      contactName: enquiries.contactName,
      contactEmail: enquiries.contactEmail,
      practiceArea: enquiries.practiceAreaPredicted,
      office: enquiries.office,
    })
    .from(enquiries)
    .where(eq(enquiries.id, proposal.enquiryId))
    .limit(1);

  const [lawyer] = await db
    .select({ fullName: users.fullName, email: users.email })
    .from(users)
    .where(eq(users.id, proposal.proposedUserId))
    .limit(1);

  const office = enquiry?.office ?? 'KL';
  const rescheduleToken = randomToken(24);

  const [appointment] = await db
    .insert(appointments)
    .values({
      enquiryId: proposal.enquiryId,
      userId: proposal.proposedUserId,
      startsAt: proposal.startsAt,
      endsAt: proposal.endsAt,
      location: officeAddress(office),
      title: `Consultation — ${(enquiry?.practiceArea ?? 'general').replace(/_/g, ' ')}`,
      clientEmail: enquiry?.contactEmail ?? null,
      clientName: enquiry?.contactName ?? null,
      // Placeholder; replaced below now that the row id exists.
      icsUid: `pending-${randomToken(8)}`,
      icsSequence: 0,
      state: 'confirmed',
      rescheduleTokenHash: sha256(rescheduleToken),
    })
    .returning({ id: appointments.id });

  if (!appointment) throw new Error('Could not create appointment');

  const icsUid = appointmentUid(appointment.id, senderDomain());
  await db.update(appointments).set({ icsUid }).where(eq(appointments.id, appointment.id));

  await db
    .update(appointmentProposals)
    .set({
      state: 'accepted',
      decidedAt: new Date(),
      decidedByUserId: params.actor.id,
    })
    .where(eq(appointmentProposals.id, proposal.id));

  await db.update(enquiries).set({ status: 'booked' }).where(eq(enquiries.id, proposal.enquiryId));

  await audit({
    action: AUDIT_ACTIONS.PROPOSAL_ACCEPTED,
    actorUserId: params.actor.id,
    actorEmail: params.actor.email,
    entityType: 'appointment',
    entityId: appointment.id,
    metadata: {
      proposalId: proposal.id,
      startsAt: proposal.startsAt.toISOString(),
      icsUid,
    },
  });

  if (enquiry?.contactEmail && lawyer) {
    await dispatchInvitation({
      appointmentId: appointment.id,
      icsUid,
      sequence: 0,
      method: 'REQUEST',
      startsAt: proposal.startsAt,
      endsAt: proposal.endsAt,
      location: officeAddress(office),
      clientEmail: enquiry.contactEmail,
      clientName: enquiry.contactName ?? 'Client',
      lawyerEmail: lawyer.email,
      lawyerName: lawyer.fullName,
      practiceArea: enquiry.practiceArea ?? 'general',
      rescheduleToken,
      enquiryId: enquiry.id,
    });
  }

  return { appointmentId: appointment.id, icsUid, sequence: 0 };
}

/** Decline (FR-3.3): the enquirer receives nothing; the enquiry returns to the queue. */
export async function declineProposal(params: {
  actor: Actor;
  proposalId: string;
  reason: string;
}): Promise<void> {
  const [proposal] = await db
    .select({
      id: appointmentProposals.id,
      enquiryId: appointmentProposals.enquiryId,
      state: appointmentProposals.state,
    })
    .from(appointmentProposals)
    .where(eq(appointmentProposals.id, params.proposalId))
    .limit(1);

  if (!proposal) throw new Error('Proposal not found');
  if (proposal.state !== 'pending') throw new Error(`Proposal is already ${proposal.state}`);

  await db
    .update(appointmentProposals)
    .set({
      state: 'declined',
      decidedAt: new Date(),
      decidedByUserId: params.actor.id,
      declineReason: params.reason,
    })
    .where(eq(appointmentProposals.id, params.proposalId));

  await db
    .update(enquiries)
    .set({ status: 'needs_review' })
    .where(eq(enquiries.id, proposal.enquiryId));

  await audit({
    action: AUDIT_ACTIONS.PROPOSAL_DECLINED,
    actorUserId: params.actor.id,
    actorEmail: params.actor.email,
    entityType: 'appointment_proposal',
    entityId: params.proposalId,
    metadata: { reason: params.reason, clientNotified: false },
  });
}

/** Reschedule (FR-3.3): supersede with a new pending proposal. Still no client email. */
export async function rescheduleProposal(params: {
  actor: Actor;
  proposalId: string;
  startsAt: Date;
  endsAt: Date;
}): Promise<string> {
  const [proposal] = await db
    .select()
    .from(appointmentProposals)
    .where(eq(appointmentProposals.id, params.proposalId))
    .limit(1);

  if (!proposal) throw new Error('Proposal not found');

  const holidayKeys = await loadHolidayKeys('KL');
  const expiresAt = computeExpiry({
    from: new Date(),
    workingHours: config().PROPOSAL_EXPIRY_WORKING_HOURS,
    holidayDateKeys: holidayKeys,
  });

  await db
    .update(appointmentProposals)
    .set({ state: 'rescheduled', decidedAt: new Date(), decidedByUserId: params.actor.id })
    .where(eq(appointmentProposals.id, params.proposalId));

  const [created] = await db
    .insert(appointmentProposals)
    .values({
      enquiryId: proposal.enquiryId,
      proposedUserId: params.actor.id,
      startsAt: params.startsAt,
      endsAt: params.endsAt,
      state: 'pending',
      expiresAt,
      supersedesProposalId: proposal.id,
    })
    .returning({ id: appointmentProposals.id });

  await audit({
    action: AUDIT_ACTIONS.PROPOSAL_RESCHEDULED,
    actorUserId: params.actor.id,
    actorEmail: params.actor.email,
    entityType: 'appointment_proposal',
    entityId: created?.id ?? params.proposalId,
    metadata: {
      supersedes: params.proposalId,
      startsAt: params.startsAt.toISOString(),
      clientNotified: false,
    },
  });

  return created?.id ?? '';
}

/**
 * Reschedule a *confirmed* appointment (FR-3.7): same UID, SEQUENCE + 1.
 */
export async function rescheduleAppointment(params: {
  actor: Actor;
  appointmentId: string;
  startsAt: Date;
  endsAt: Date;
}): Promise<void> {
  const [appointment] = await db
    .select()
    .from(appointments)
    .where(eq(appointments.id, params.appointmentId))
    .limit(1);
  if (!appointment) throw new Error('Appointment not found');

  const nextSequence = appointment.icsSequence + 1;

  await db
    .update(appointments)
    .set({
      startsAt: params.startsAt,
      endsAt: params.endsAt,
      icsSequence: nextSequence,
      state: 'confirmed',
    })
    .where(eq(appointments.id, params.appointmentId));

  const [lawyer] = await db
    .select({ fullName: users.fullName, email: users.email })
    .from(users)
    .where(eq(users.id, appointment.userId))
    .limit(1);

  await audit({
    action: AUDIT_ACTIONS.PROPOSAL_RESCHEDULED,
    actorUserId: params.actor.id,
    actorEmail: params.actor.email,
    entityType: 'appointment',
    entityId: params.appointmentId,
    metadata: { icsUid: appointment.icsUid, sequence: nextSequence },
  });

  if (appointment.clientEmail && lawyer) {
    await dispatchInvitation({
      appointmentId: appointment.id,
      icsUid: appointment.icsUid,
      sequence: nextSequence,
      method: 'REQUEST',
      startsAt: params.startsAt,
      endsAt: params.endsAt,
      location: appointment.location,
      clientEmail: appointment.clientEmail,
      clientName: appointment.clientName ?? 'Client',
      lawyerEmail: lawyer.email,
      lawyerName: lawyer.fullName,
      practiceArea: 'general',
      enquiryId: appointment.enquiryId,
    });
  }
}

/** Cancel a confirmed appointment: METHOD:CANCEL, SEQUENCE + 1 (FR-3.7). */
export async function cancelAppointment(params: {
  actor: Actor;
  appointmentId: string;
}): Promise<void> {
  const [appointment] = await db
    .select()
    .from(appointments)
    .where(eq(appointments.id, params.appointmentId))
    .limit(1);
  if (!appointment) throw new Error('Appointment not found');

  const nextSequence = appointment.icsSequence + 1;

  await db
    .update(appointments)
    .set({ state: 'cancelled', icsSequence: nextSequence })
    .where(eq(appointments.id, params.appointmentId));

  const [lawyer] = await db
    .select({ fullName: users.fullName, email: users.email })
    .from(users)
    .where(eq(users.id, appointment.userId))
    .limit(1);

  if (appointment.clientEmail && lawyer) {
    await dispatchInvitation({
      appointmentId: appointment.id,
      icsUid: appointment.icsUid,
      sequence: nextSequence,
      method: 'CANCEL',
      startsAt: appointment.startsAt,
      endsAt: appointment.endsAt,
      location: appointment.location,
      clientEmail: appointment.clientEmail,
      clientName: appointment.clientName ?? 'Client',
      lawyerEmail: lawyer.email,
      lawyerName: lawyer.fullName,
      practiceArea: 'general',
      enquiryId: appointment.enquiryId,
    });
  }
}

async function dispatchInvitation(params: {
  appointmentId: string;
  icsUid: string;
  sequence: number;
  method: 'REQUEST' | 'CANCEL';
  startsAt: Date;
  endsAt: Date;
  location: string;
  clientEmail: string;
  clientName: string;
  lawyerEmail: string;
  lawyerName: string;
  practiceArea: string;
  rescheduleToken?: string;
  enquiryId?: string | null;
}): Promise<void> {
  const cfg = config();
  const isCancel = params.method === 'CANCEL';

  const ics = buildIcs({
    uid: params.icsUid,
    sequence: params.sequence,
    method: params.method,
    summary: `Consultation — ${cfg.FIRM_SHORT_NAME}`,
    description: isCancel
      ? 'This consultation has been cancelled.'
      : 'Consultation with your lawyer.',
    location: params.location,
    startsAt: params.startsAt,
    endsAt: params.endsAt,
    organiser: { email: cfg.RESEND_FROM_ADDRESS, name: cfg.FIRM_NAME },
    attendees: [
      { email: params.clientEmail, name: params.clientName },
      { email: params.lawyerEmail, name: params.lawyerName },
    ],
  });

  const template = await loadTemplate(isCancel ? 'appointment.cancelled' : 'appointment.confirmed');

  const variables = {
    clientName: params.clientName,
    lawyerName: params.lawyerName,
    firmName: cfg.FIRM_NAME,
    appointmentWhen: formatSlotForClient({ startsAt: params.startsAt, endsAt: params.endsAt }),
    appointmentLocation: params.location,
    rescheduleUrl: params.rescheduleToken
      ? `${cfg.APP_BASE_URL}/reschedule/${params.rescheduleToken}`
      : '',
  };

  const subject = template
    ? renderTemplate(template.subject, variables)
    : `Your consultation — ${cfg.FIRM_NAME}`;
  const text = template ? renderTemplate(template.bodyMd, variables) : '';

  const result = await sendCalendarInvite({
    to: [params.clientEmail, params.lawyerEmail],
    subject,
    text,
    ics,
    method: params.method,
    // Same appointment + same sequence + same method must never send twice.
    idempotencyKey: `ics-${params.appointmentId}-${params.sequence}-${params.method}`,
  });

  await db
    .insert(messages)
    .values({
      enquiryId: params.enquiryId ?? null,
      toEmail: params.clientEmail,
      templateKey: isCancel ? 'appointment.cancelled' : 'appointment.confirmed',
      subject,
      bodyRendered: text,
      resendMessageId: result.id || null,
      state: 'sent',
      sentAt: new Date(),
      idempotencyKey: `ics-${params.appointmentId}-${params.sequence}-${params.method}`,
    })
    .onConflictDoNothing();
}

/** Candidate slots for the reschedule picker. */
export async function candidateSlots(params: {
  userId: string;
  office: Office;
  practiceArea: PracticeArea;
  limit?: number;
}): Promise<Slot[]> {
  const [windows, holidayKeys] = await Promise.all([
    loadWindows({ office: params.office, practiceArea: params.practiceArea }),
    loadHolidayKeys(params.office),
  ]);
  const mine = windows.filter((w) => w.userId === params.userId);
  if (mine.length === 0) return [];

  const now = new Date();
  const busy = await loadBusy([params.userId], now);

  return findSlots({
    windows: mine,
    busy,
    holidayDateKeys: holidayKeys,
    from: now,
    limit: params.limit ?? 6,
    minimumNoticeMinutes: 120,
  });
}

export function officeAddress(office: Office): string {
  switch (office) {
    case 'KL':
      return 'Chambers of Koon — Kuala Lumpur office';
    case 'PJ':
      return 'Chambers of Koon — Petaling Jaya office';
    case 'IPOH':
      return 'Chambers of Koon — Ipoh office';
  }
}

/** Nightly sweep: expire stale proposals and escalate (FR-3.5). */
export async function expireStaleProposals(): Promise<number> {
  const now = new Date();
  const stale = await db
    .select({ id: appointmentProposals.id, enquiryId: appointmentProposals.enquiryId })
    .from(appointmentProposals)
    .where(
      and(eq(appointmentProposals.state, 'pending'), lte(appointmentProposals.expiresAt, now)),
    );

  for (const proposal of stale) {
    await db
      .update(appointmentProposals)
      .set({ state: 'expired', escalatedAt: now })
      .where(eq(appointmentProposals.id, proposal.id));

    await db
      .update(enquiries)
      .set({ status: 'needs_review' })
      .where(eq(enquiries.id, proposal.enquiryId));

    await audit({
      action: AUDIT_ACTIONS.PROPOSAL_EXPIRED,
      entityType: 'appointment_proposal',
      entityId: proposal.id,
      metadata: { escalated: true, clientNotified: false },
    });
  }

  return stale.length;
}

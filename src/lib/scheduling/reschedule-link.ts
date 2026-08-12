import type { Slot } from '@/lib/scheduling/slots';

/**
 * Client reschedule link (FR-3.8) — the decisions, with no database in them.
 *
 * FR-3.8 is a SHOULD, and the shape it takes matters more than most SHOULDs
 * because this is the second unauthenticated surface in the system. The token
 * emailed with the confirmation is the only credential the holder has, so
 * everything this module decides is written to be readable by someone auditing
 * that surface rather than inferred from the call sites.
 *
 * Three rules, in the order they bite:
 *
 * 1. **Rescheduling asks; it does not book.** Choosing a slot here creates a
 *    pending proposal, exactly as an overnight enquiry does. The existing
 *    appointment stays confirmed and the client's calendar entry stays where it
 *    is until a lawyer accepts. FR-3.4 — no client-facing invitation until a
 *    lawyer acts — is not weakened by giving the client a link.
 *
 * 2. **Only an offered slot can be chosen.** The form posts a start time, and a
 *    start time is trivially editable. `matchOfferedSlot` re-derives the offer
 *    server-side and accepts nothing outside it, so a hand-edited request
 *    cannot book a lawyer at 3am or outside their availability rules.
 *
 * 3. **One open request at a time.** Without this a client can hold every free
 *    slot in the lawyer's week, because `loadBusy` treats pending proposals as
 *    busy. The second request is refused while the first is undecided.
 */

/** Why a link cannot be opened. The page renders its own copy per code. */
export type RescheduleBlockedCode = 'unknown' | 'cancelled' | 'passed' | 'pending_request';

export type RescheduleLinkState =
  { openable: true } | { openable: false; code: RescheduleBlockedCode };

/**
 * How close to the consultation the link stops working.
 *
 * Past this point a reschedule request would sit in a queue the lawyer may not
 * read before the appointment starts, and the client would be left believing
 * they had moved something they had not. Phoning the office is the honest
 * answer, and the page says so.
 */
export const CLIENT_RESCHEDULE_NOTICE_MINUTES = 120;

export interface RescheduleLinkInput {
  /** Null when no appointment carries the token's hash. */
  appointment: { state: 'confirmed' | 'cancelled' | 'rescheduled'; startsAt: Date } | null;
  /** True when this enquiry already has an undecided proposal. */
  hasPendingProposal: boolean;
  now: Date;
  noticeMinutes?: number;
}

/**
 * Whether the link may be opened, and if not, why.
 *
 * Note that a *valid* token gets a truthful reason — cancelled, passed, already
 * requested — while an unrecognised one gets `unknown`. That asymmetry is
 * deliberate and safe: the token is 24 random bytes, so anyone holding a
 * recognised one is the client the email was sent to, and telling them plainly
 * that their consultation was cancelled beats a generic dead end. Only the
 * guesser, who learns nothing either way, sees `unknown`.
 */
export function evaluateRescheduleLink(input: RescheduleLinkInput): RescheduleLinkState {
  if (!input.appointment) return { openable: false, code: 'unknown' };
  if (input.appointment.state !== 'confirmed') return { openable: false, code: 'cancelled' };

  const notice = input.noticeMinutes ?? CLIENT_RESCHEDULE_NOTICE_MINUTES;
  const cutoff = new Date(input.now.getTime() + notice * 60_000);
  if (input.appointment.startsAt <= cutoff) return { openable: false, code: 'passed' };

  if (input.hasPendingProposal) return { openable: false, code: 'pending_request' };

  return { openable: true };
}

/**
 * Resolve a posted start time against the slots actually offered.
 *
 * Matching on the start instant alone is sufficient because the offer is
 * re-derived from the availability rules on every request: a slot that is no
 * longer free is no longer in `offered`, so a replayed form from an hour ago
 * fails here rather than double-booking. Returns null on any mismatch, which
 * the caller renders as "that time has just been taken".
 */
export function matchOfferedSlot(offered: Slot[], startsAtIso: string): Slot | null {
  const wanted = new Date(startsAtIso);
  if (Number.isNaN(wanted.getTime())) return null;
  return offered.find((slot) => slot.startsAt.getTime() === wanted.getTime()) ?? null;
}

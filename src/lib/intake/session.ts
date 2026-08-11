import type { EnquiryStatus } from '@/lib/db/schema';

/**
 * Widget session resumption policy.
 *
 * A session token is the only thing that says "this message belongs to that
 * conversation", and it arrives from an unauthenticated browser. Deciding when
 * a token may resume an existing enquiry is therefore a real access-control
 * decision, not a convenience, and it is kept here as a pure function so it
 * can be reasoned about and tested without a database.
 *
 * The rule this replaces was "any enquiry with a matching token, newest
 * first", which merged unrelated enquiries into one conversation: the widget
 * stored its token in localStorage forever, so a second enquirer on the same
 * browser — or the same person coming back a week later with a different
 * problem — appended to a finished enquiry. The model then saw both stories in
 * one transcript and produced a single brief describing neither.
 *
 * Two conditions now have to hold.
 */

/**
 * How long a session may stay idle and still be resumed.
 *
 * Long enough to survive a phone call, a lost signal or an accidental reload
 * mid-enquiry. Short enough that the browser cannot carry a token into an
 * unrelated conversation days later.
 */
export const SESSION_IDLE_WINDOW_MINUTES = 120;

/**
 * Statuses that mean the conversation is still being gathered.
 *
 * Everything else — triaged, needs_review, slot_proposed, booked, declined,
 * spam — has been handed to a person. A lawyer reading a brief must be able to
 * trust that the transcript beneath it stopped when the brief was written; if
 * later messages could still land on it, the brief and the transcript would
 * silently disagree.
 */
const RESUMABLE_STATUSES: ReadonlySet<EnquiryStatus> = new Set<EnquiryStatus>(['new']);

export interface SessionCandidate {
  status: EnquiryStatus;
  /** Last message time, or the enquiry's creation time if it has none yet. */
  lastActivityAt: Date;
}

export function isResumable(candidate: SessionCandidate, now: Date = new Date()): boolean {
  if (!RESUMABLE_STATUSES.has(candidate.status)) return false;

  const idleMs = now.getTime() - candidate.lastActivityAt.getTime();
  if (Number.isNaN(idleMs)) return false;

  // A negative idle time means clock skew between the app and the database.
  // Treat it as active rather than expiring a live conversation.
  if (idleMs < 0) return true;

  return idleMs <= SESSION_IDLE_WINDOW_MINUTES * 60_000;
}

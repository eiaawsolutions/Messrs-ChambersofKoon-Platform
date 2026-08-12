/**
 * Duplicate and spam detection on repeated enquiries (FR-2.8).
 *
 * "Duplicate and spam detection on repeated submissions from the same email
 *  within 24 hours."
 *
 * The rule that shapes all of this: **a legal enquiry is never discarded on a
 * guess.** Someone leaving a violent household at 2am who sends a second
 * enquiry because the first felt incomplete must not be filtered out for
 * looking like a repeat. So the outcomes are graduated, and only the extreme
 * one withholds anything:
 *
 * - `distinct` — nothing to say. The common case.
 * - `duplicate` — the same person, again, within the day. The enquiry is kept
 *   and worked exactly as any other; the link is recorded so a lawyer opening
 *   it sees the earlier one and reads both together rather than ringing the
 *   same client twice about what they believe are two matters.
 * - `spam` — a volume no genuine enquirer produces. Held out of the queue for
 *   a human to release, never deleted.
 *
 * Everything here is a pure decision over rows the caller has already read;
 * the classifier holds no database and no clock of its own, so it is fully
 * testable and its thresholds are visible in one place.
 */

export type EnquiryDisposition = 'distinct' | 'duplicate' | 'spam';

export interface RecentEnquiry {
  id: string;
  createdAt: Date;
  /** First message or opening description; '' when nothing was captured. */
  summary: string;
}

export interface DuplicateVerdict {
  disposition: EnquiryDisposition;
  /** The enquiry this one repeats. Null unless `duplicate`. */
  duplicateOfEnquiryId: string | null;
  /** Stable code for the audit metadata and the queue badge. */
  reason: 'none' | 'same_email_within_window' | 'volume_from_one_address';
}

/** The window FR-2.8 names. */
export const DUPLICATE_WINDOW_HOURS = 24;

/**
 * How many enquiries from one address in the window stop looking like a person
 * with more to say.
 *
 * Five is deliberately generous. A distressed enquirer sending three or four
 * messages as things occur to them is ordinary; nobody with a real matter
 * opens six separate conversations in a day.
 */
export const SPAM_THRESHOLD = 6;

export function classifyEnquiry(input: {
  contactEmail: string | null;
  /** Prior enquiries from the same address, newest first, already scoped to the window. */
  recent: RecentEnquiry[];
  now: Date;
  windowHours?: number;
}): DuplicateVerdict {
  const none: DuplicateVerdict = {
    disposition: 'distinct',
    duplicateOfEnquiryId: null,
    reason: 'none',
  };

  // No address to correlate on. An anonymous enquiry is not a duplicate of
  // anything — the IP-based rate limits are what cover that case.
  if (!input.contactEmail?.trim()) return none;

  const windowMs = (input.windowHours ?? DUPLICATE_WINDOW_HOURS) * 3_600_000;
  const cutoff = new Date(input.now.getTime() - windowMs);

  // Re-applied here rather than trusted from the caller, so a widened query
  // cannot silently widen the rule.
  const inWindow = input.recent
    .filter((entry) => entry.createdAt > cutoff)
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());

  if (inWindow.length === 0) return none;

  // The enquiry being classified is not in the list yet, so it is counted
  // here: six earlier ones plus this makes seven, which is past the threshold.
  if (inWindow.length + 1 > SPAM_THRESHOLD) {
    return {
      disposition: 'spam',
      duplicateOfEnquiryId: null,
      reason: 'volume_from_one_address',
    };
  }

  return {
    disposition: 'duplicate',
    // The most recent, not the first: it is the one a lawyer most likely has
    // open, and it chains back through its own link if there were several.
    duplicateOfEnquiryId: inWindow[0]!.id,
    reason: 'same_email_within_window',
  };
}

/**
 * What the intake queue shows against a flagged enquiry.
 *
 * Phrased for a clerk deciding what to do, not for a log. A duplicate is a
 * prompt to read both; spam is a prompt to check before releasing.
 */
export function dispositionNote(verdict: DuplicateVerdict): string | null {
  switch (verdict.disposition) {
    case 'duplicate':
      return 'Same email as an enquiry in the last 24 hours. Read them together before replying — it is usually one person adding something they forgot.';
    case 'spam':
      return `More than ${SPAM_THRESHOLD} enquiries from this address in 24 hours. Held out of the queue rather than deleted — release it if it is genuine.`;
    case 'distinct':
      return null;
  }
}

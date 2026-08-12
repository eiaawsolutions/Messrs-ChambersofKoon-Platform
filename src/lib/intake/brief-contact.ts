import { looksRedacted } from '@/lib/ai/tokenise';
import { isPlausibleEmail, normalisePhone } from '@/lib/intake/details';

/**
 * Reconcile the contact details on an enquiry with the ones a case brief
 * reports (FR-2.5, AI-1).
 *
 * The brief is written by a model that only ever sees the scrubbed transcript,
 * so its idea of the enquirer's email is `[EMAIL]` and its idea of their number
 * is `[PHONE]` — faithfully, because that is what the transcript says. The
 * platform holds the real values: the opening form validated them, or
 * `extractContactDetails` captured them from the raw message before the scrub.
 *
 * So the brief is the weakest of the three sources and is treated as such:
 *
 *  - What is already stored wins. Not merely to avoid the placeholder problem —
 *    the addresses that appear later in a transcript are often somebody else's
 *    (an ex-spouse, the other side's solicitor), and overwriting on sight would
 *    quietly redirect the firm's reply to the opposing party.
 *  - A placeholder is never stored, and a stored placeholder is cleared. A
 *    field reading `[EMAIL]` is worse than an empty one: every downstream check
 *    is `if (email)`, so a placeholder passes as a real address and fails at the
 *    mail transport instead of at the queue.
 *  - A value the brief supplies for a genuinely blank field must still pass the
 *    same validation the form applies.
 *
 * Pure, so the rules are testable without a database or a model.
 */

export interface StoredContact {
  name: string | null;
  email: string | null;
  phone: string | null;
}

export interface BriefContact {
  contactName: string;
  contactEmail: string;
  contactPhone: string;
}

/** Only the fields that need writing, so an unchanged enquiry is not touched. */
export type ContactPatch = Partial<{
  contactName: string | null;
  contactEmail: string | null;
  contactPhone: string | null;
}>;

function usableName(value: string | null | undefined): string | null {
  const trimmed = value?.trim().replace(/\s+/g, ' ');
  if (!trimmed || looksRedacted(trimmed) || trimmed.length < 2) return null;
  return trimmed;
}

function usableEmail(value: string | null | undefined): string | null {
  const trimmed = value?.trim().toLowerCase();
  if (!trimmed || looksRedacted(trimmed) || !isPlausibleEmail(trimmed)) return null;
  return trimmed;
}

function usablePhone(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  if (!trimmed || looksRedacted(trimmed)) return null;
  // Stored numbers are E.164; normalising again is idempotent and rejects the
  // shapes that cannot be dialled at all.
  return normalisePhone(trimmed);
}

export function contactPatchFromBrief(stored: StoredContact, brief: BriefContact): ContactPatch {
  const patch: ContactPatch = {};

  const resolved = {
    contactName: usableName(stored.name) ?? usableName(brief.contactName),
    contactEmail: usableEmail(stored.email) ?? usableEmail(brief.contactEmail),
    contactPhone: usablePhone(stored.phone) ?? usablePhone(brief.contactPhone),
  };

  const current = {
    contactName: stored.name,
    contactEmail: stored.email,
    contactPhone: stored.phone,
  };

  for (const key of ['contactName', 'contactEmail', 'contactPhone'] as const) {
    // Compared against the raw stored value, not the usable one, so a column
    // holding a placeholder or '' is actually cleared rather than judged equal
    // to the null it resolves to. Re-running triage on a clean row is a no-op.
    if (resolved[key] !== (current[key] ?? null)) patch[key] = resolved[key];
  }

  return patch;
}

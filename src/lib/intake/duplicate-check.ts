import 'server-only';
import { and, desc, eq, gt, ne, sql } from 'drizzle-orm';
import { db } from '@/lib/db/client';
import { enquiries } from '@/lib/db/schema';
import {
  classifyEnquiry,
  DUPLICATE_WINDOW_HOURS,
  type DuplicateVerdict,
} from '@/lib/intake/duplicates';
import { audit, AUDIT_ACTIONS } from '@/lib/audit/log';
import type { Actor } from '@/lib/auth/guard';

/**
 * Duplicate and spam detection, the database half (FR-2.8).
 *
 * Run at handover rather than at creation. A widget enquiry has no email when
 * the conversation opens — the agent captures it as it goes — so classifying
 * on insert would correlate almost nothing. By handover the address is known
 * for every path, widget and no-JS form alike.
 *
 * Nothing here deletes or refuses an enquiry. The worst outcome is `spam`,
 * which moves the row out of the working queue into a held list a clerk can
 * release. A legal enquiry that was wrongly filtered is a client the firm never
 * knew contacted them, and no false-positive rate makes that acceptable.
 */

/**
 * Enough rows to decide, and no more.
 *
 * The classifier only needs to know whether the count passes a threshold in
 * the low single digits, so a script that opened ten thousand conversations
 * costs one bounded read rather than ten thousand rows in memory.
 */
const SPAM_SCAN_LIMIT = 20;

export async function flagDuplicates(enquiryId: string): Promise<DuplicateVerdict> {
  const quiet: DuplicateVerdict = {
    disposition: 'distinct',
    duplicateOfEnquiryId: null,
    reason: 'none',
  };

  const [enquiry] = await db
    .select({
      id: enquiries.id,
      contactEmail: enquiries.contactEmail,
      createdAt: enquiries.createdAt,
    })
    .from(enquiries)
    .where(eq(enquiries.id, enquiryId))
    .limit(1);

  if (!enquiry?.contactEmail) return quiet;

  const cutoff = new Date(Date.now() - DUPLICATE_WINDOW_HOURS * 3_600_000);

  const recent = await db
    .select({ id: enquiries.id, createdAt: enquiries.createdAt })
    .from(enquiries)
    .where(
      and(
        // Case-insensitive: Nurul@ and nurul@ are one person, and treating
        // them as two would defeat the whole check.
        sql`lower(${enquiries.contactEmail}) = lower(${enquiry.contactEmail})`,
        ne(enquiries.id, enquiry.id),
        gt(enquiries.createdAt, cutoff),
      ),
    )
    .orderBy(desc(enquiries.createdAt))
    .limit(SPAM_SCAN_LIMIT);

  const verdict = classifyEnquiry({
    contactEmail: enquiry.contactEmail,
    recent: recent.map((row) => ({ id: row.id, createdAt: row.createdAt, summary: '' })),
    now: new Date(),
  });

  if (verdict.disposition === 'distinct') return verdict;

  await db
    .update(enquiries)
    .set({
      duplicateOfEnquiryId: verdict.duplicateOfEnquiryId,
      // Held, not dropped. `spam` keeps it out of the working queue and in the
      // held list; a duplicate is worked exactly like any other enquiry.
      ...(verdict.disposition === 'spam' ? { status: 'spam' as const } : {}),
    })
    .where(eq(enquiries.id, enquiry.id));

  await audit({
    action: AUDIT_ACTIONS.ENQUIRY_FLAGGED,
    entityType: 'enquiry',
    entityId: enquiry.id,
    metadata: {
      disposition: verdict.disposition,
      reason: verdict.reason,
      duplicateOf: verdict.duplicateOfEnquiryId,
      priorInWindow: recent.length,
      clientNotified: false,
    },
  });

  return verdict;
}

/** Held enquiries, for the release list on the intake queue. */
export async function heldEnquiries(limit = 20) {
  return db
    .select({
      id: enquiries.id,
      contactName: enquiries.contactName,
      contactEmail: enquiries.contactEmail,
      office: enquiries.office,
      createdAt: enquiries.createdAt,
    })
    .from(enquiries)
    .where(eq(enquiries.status, 'spam'))
    .orderBy(desc(enquiries.createdAt))
    .limit(limit);
}

/**
 * Put a held enquiry back in front of a human.
 *
 * Deliberately one-way: there is a path out of `spam` and none into it that a
 * person can trigger. Whether an enquiry is genuine is a judgement a clerk
 * makes once, and the audit records who made it.
 */
export async function releaseHeldEnquiry(params: {
  actor: Actor;
  enquiryId: string;
}): Promise<void> {
  const updated = await db
    .update(enquiries)
    .set({ status: 'needs_review' })
    .where(and(eq(enquiries.id, params.enquiryId), eq(enquiries.status, 'spam')))
    .returning({ id: enquiries.id });

  if (updated.length === 0) return;

  await audit({
    action: AUDIT_ACTIONS.ENQUIRY_RELEASED,
    actorUserId: params.actor.id,
    actorEmail: params.actor.email,
    entityType: 'enquiry',
    entityId: params.enquiryId,
    metadata: { from: 'spam', to: 'needs_review' },
  });
}

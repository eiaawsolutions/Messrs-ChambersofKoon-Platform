import 'server-only';
import { eq } from 'drizzle-orm';
import { db } from '@/lib/db/client';
import { enquiries, enquiryMessages, type Office } from '@/lib/db/schema';
import { audit, AUDIT_ACTIONS } from '@/lib/audit/log';
import { randomToken } from '@/lib/security/crypto';
import { scrubFreeText } from '@/lib/ai/tokenise';

/**
 * Enquiry persistence.
 *
 * Route handlers stay thin and call these; the ESLint rule that keeps `db` out
 * of route handlers (FR-1.5) is not a nuisance to work around but the reason
 * this layer exists. The public intake endpoints have no authenticated actor
 * and therefore no permission scope — which is exactly why their database work
 * belongs in a reviewed service rather than inline in an unauthenticated
 * handler.
 */

export interface CreateEnquiryInput {
  source: 'widget' | 'form' | 'manual';
  sessionToken?: string;
  ip?: string | null;
  userAgent?: string | null;
  origin?: string | null;
  contactName?: string | null;
  contactEmail?: string | null;
  contactPhone?: string | null;
  office?: Office | null;
  /** Present for the no-JS form path, which arrives as one complete message. */
  initialMessage?: string;
}

export interface CreatedEnquiry {
  id: string;
  sessionToken: string;
}

export async function createEnquiry(input: CreateEnquiryInput): Promise<CreatedEnquiry | null> {
  const sessionToken = input.sessionToken ?? randomToken(24);

  const [created] = await db
    .insert(enquiries)
    .values({
      source: input.source,
      sessionToken,
      submittedIp: input.ip ?? null,
      office: input.office ?? null,
      contactName: input.contactName ?? null,
      contactEmail: input.contactEmail ?? null,
      contactPhone: input.contactPhone ?? null,
      rawPayload: {
        origin: input.origin ?? null,
        userAgent: input.userAgent ?? null,
        via: input.source,
      },
      status: 'new',
    })
    .returning({ id: enquiries.id });

  if (!created) return null;

  if (input.initialMessage) {
    await db.insert(enquiryMessages).values({
      enquiryId: created.id,
      role: 'user',
      content: scrubFreeText(input.initialMessage),
    });
  }

  await audit({
    action: AUDIT_ACTIONS.ENQUIRY_RECEIVED,
    entityType: 'enquiry',
    entityId: created.id,
    ip: input.ip ?? null,
    userAgent: input.userAgent ?? null,
    metadata: { source: input.source, origin: input.origin ?? null },
  });

  return { id: created.id, sessionToken };
}

/** Park an enquiry for a human after an unrecoverable error. Never lose it. */
export async function markNeedsReview(enquiryId: string): Promise<void> {
  await db.update(enquiries).set({ status: 'needs_review' }).where(eq(enquiries.id, enquiryId));
}

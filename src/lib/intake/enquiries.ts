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
  ip?: string | null;
  userAgent?: string | null;
  origin?: string | null;
  contactName?: string | null;
  contactEmail?: string | null;
  contactPhone?: string | null;
  office?: Office | null;
  /** The firm's public enquiry type the person picked, if they picked one. */
  enquiryTypeSelected?: string | null;
  /** Present for the no-JS form path, which arrives as one complete message. */
  initialMessage?: string;
  /**
   * The version of the terms and privacy policy the enquirer accepted.
   *
   * Required: there is no path that creates an enquiry without it, because
   * there is no lawful path that starts processing someone's personal data
   * before they have agreed to it.
   */
  termsVersion: string;
}

export interface CreatedEnquiry {
  id: string;
  sessionToken: string;
}

export async function createEnquiry(input: CreateEnquiryInput): Promise<CreatedEnquiry | null> {
  // Always minted here, never taken from the request. A client-proposed token
  // is a session fixation primitive: an unauthenticated caller could name the
  // token a real enquirer's browser is holding and have both conversations
  // resolve to one enquiry — reading the other person's transcript back to
  // them through the agent's replies.
  const sessionToken = randomToken(24);

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
      enquiryTypeSelected: input.enquiryTypeSelected ?? null,
      termsAcceptedAt: new Date(),
      termsVersion: input.termsVersion,
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
    metadata: {
      source: input.source,
      origin: input.origin ?? null,
      // The acceptance belongs in the append-only log too. The enquiry row can
      // be corrected; an audit event cannot.
      termsVersion: input.termsVersion,
    },
  });

  return { id: created.id, sessionToken };
}

/** Park an enquiry for a human after an unrecoverable error. Never lose it. */
export async function markNeedsReview(enquiryId: string): Promise<void> {
  await db.update(enquiries).set({ status: 'needs_review' }).where(eq(enquiries.id, enquiryId));
}

/**
 * Retire the widget session once the enquiry has been handed over.
 *
 * Called the moment the agent decides it has enough, rather than waiting for
 * the triage job to move the status. Without this there is a window — queue
 * latency plus a Sonnet call — in which the enquirer's next message still
 * finds a status of `new` and appends to a conversation a lawyer is already
 * being briefed on.
 *
 * The token is cleared, not just marked: a retired session cannot be resumed
 * by anyone, including whoever uses the browser next.
 */
export async function closeSession(enquiryId: string): Promise<void> {
  await db.update(enquiries).set({ sessionToken: null }).where(eq(enquiries.id, enquiryId));
}

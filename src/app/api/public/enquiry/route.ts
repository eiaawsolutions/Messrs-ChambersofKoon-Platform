import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import {
  checkRateLimit,
  clientIp,
  corsHeaders,
  isValidWidgetKey,
  RATE_LIMITS,
  resolveAllowedOrigin,
  verifyTurnstile,
} from '@/lib/intake/protection';
import { findEnquiryBySession, respondToTurn } from '@/lib/intake/triage';
import { createEnquiry, markNeedsReview } from '@/lib/intake/enquiries';
import { enqueue, JOBS } from '@/lib/jobs/queue';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Public intake endpoint (M2, FR-2.3).
 *
 * The only unauthenticated write surface in the platform, so every control the
 * PRD asks for is applied here and in this order: origin allow-list, widget
 * key, rate limit, bot check. Cheapest rejection first.
 *
 * Error responses are deliberately uniform and vague. An enumerable difference
 * between "unknown session" and "rate limited" is a reconnaissance signal
 * (penetration-testing.md).
 */

const turnSchema = z.object({
  sessionToken: z.string().min(16).max(64).optional(),
  message: z.string().min(1).max(4000),
  turnstileToken: z.string().max(4000).optional(),
  /** Set by the fallback form (FR-2.2) so we can capture contact details. */
  contactName: z.string().max(200).optional(),
  contactEmail: z.string().max(320).optional(),
  contactPhone: z.string().max(40).optional(),
  office: z.enum(['KL', 'PJ', 'IPOH']).optional(),
});

function reject(status: number, message: string, origin: string | null): NextResponse {
  return NextResponse.json(
    { error: message },
    { status, headers: { ...corsHeaders(origin), 'cache-control': 'no-store' } },
  );
}

export async function OPTIONS(request: NextRequest): Promise<NextResponse> {
  const origin = request.headers.get('origin');
  if (!resolveAllowedOrigin(origin)) {
    return new NextResponse(null, { status: 403 });
  }
  return new NextResponse(null, { status: 204, headers: corsHeaders(origin) });
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  const origin = request.headers.get('origin');

  // 1. Origin allow-list.
  if (!resolveAllowedOrigin(origin)) {
    return NextResponse.json({ error: 'Origin not permitted' }, { status: 403 });
  }

  // 2. Public widget key.
  if (!isValidWidgetKey(request.headers.get('x-widget-key'))) {
    return reject(401, 'Invalid widget key', origin);
  }

  const ip = clientIp(request.headers);

  // 3. Rate limit per IP before doing any work.
  const ipLimit = await checkRateLimit(`ip:${ip ?? 'unknown'}`, RATE_LIMITS.perIp);
  if (!ipLimit.allowed) {
    return reject(429, 'Too many requests. Please try again later.', origin);
  }

  let payload: z.infer<typeof turnSchema>;
  try {
    payload = turnSchema.parse(await request.json());
  } catch {
    return reject(400, 'Invalid request', origin);
  }

  // 4. Bot check.
  const turnstile = await verifyTurnstile(payload.turnstileToken ?? null, ip);
  if (!turnstile.ok) {
    return reject(403, 'Verification failed. Please refresh and try again.', origin);
  }

  // Resolve or create the conversation.
  let enquiryId: string | null = null;
  let sessionToken = payload.sessionToken ?? null;

  if (sessionToken) {
    const sessionLimit = await checkRateLimit(`session:${sessionToken}`, RATE_LIMITS.perSession);
    if (!sessionLimit.allowed) {
      return reject(429, 'Too many requests. Please try again later.', origin);
    }
    enquiryId = await findEnquiryBySession(sessionToken);
  }

  if (!enquiryId) {
    const newConversation = await checkRateLimit(
      `new:${ip ?? 'unknown'}`,
      RATE_LIMITS.newConversationPerIp,
    );
    if (!newConversation.allowed) {
      return reject(429, 'Too many requests. Please try again later.', origin);
    }

    const created = await createEnquiry({
      source: 'widget',
      ...(sessionToken ? { sessionToken } : {}),
      ip,
      userAgent: request.headers.get('user-agent'),
      origin,
      office: payload.office ?? null,
      contactName: payload.contactName ?? null,
      contactEmail: payload.contactEmail ?? null,
      contactPhone: payload.contactPhone ?? null,
    });

    if (!created) return reject(500, 'Could not start the conversation', origin);
    enquiryId = created.id;
    sessionToken = created.sessionToken;
  }

  // Converse.
  try {
    const turn = await respondToTurn({ enquiryId, userMessage: payload.message });

    // When the agent has what it needs, build the brief and (if confident)
    // propose a slot. Both run in the background so the enquirer is not left
    // waiting on a Sonnet call plus a scheduling sweep.
    if (turn.readyForBrief) {
      await enqueue(JOBS.TRIAGE_ENQUIRY, { enquiryId }, { singletonKey: `triage-${enquiryId}` });
    }

    return NextResponse.json(
      {
        sessionToken,
        reply: turn.reply,
        complete: turn.readyForBrief,
      },
      { headers: { ...corsHeaders(origin), 'cache-control': 'no-store' } },
    );
  } catch (error) {
    console.error('[intake] turn failed', (error as Error).message);
    // Park it for a human rather than losing the enquiry.
    await markNeedsReview(enquiryId);
    return NextResponse.json(
      {
        sessionToken,
        reply:
          'Sorry — something went wrong on our side. Your message has been saved and someone ' +
          'from the firm will follow up. If this is urgent, please call the office.',
        complete: true,
      },
      { headers: { ...corsHeaders(origin), 'cache-control': 'no-store' } },
    );
  }
}

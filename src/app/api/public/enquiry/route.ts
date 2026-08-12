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
import { config } from '@/lib/config/env';
import { findEnquiryBySession, respondToTurn } from '@/lib/intake/triage';
import { closeSession, createEnquiry, markNeedsReview } from '@/lib/intake/enquiries';
import { handOverToFirm } from '@/lib/intake/handover';
import {
  composeInitialMessage,
  parseEnquiryDetails,
  type DetailErrors,
} from '@/lib/intake/details';

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
  /**
   * Required to continue a conversation, optional to start one.
   *
   * The opening screen is the firm's enquiry form, whose message box is
   * optional — the four required answers are themselves an enquiry, and
   * refusing one because the person had nothing to add would lose it.
   */
  message: z.string().max(4000).optional(),
  turnstileToken: z.string().max(4000).optional(),
  /**
   * Name, email, contact number and enquiry type, from the opening form.
   *
   * Read only when a conversation is being created. Left unknown here and
   * handed to parseEnquiryDetails, which is the single authority both entry
   * points share — validating the shape twice, in two places, is how the
   * widget and the form come to disagree about what a phone number is.
   */
  details: z.unknown().optional(),
  office: z.enum(['KL', 'PJ', 'IPOH']).optional(),
  /**
   * The enquirer ticked the acceptance box on the opening form. Only read when
   * a conversation is being created — once an enquiry exists the acceptance is
   * already on the row and the client cannot revise it.
   */
  termsAccepted: z.literal(true).optional(),
});

function reject(status: number, message: string, origin: string | null): NextResponse {
  return NextResponse.json(
    { error: message },
    { status, headers: { ...corsHeaders(origin), 'cache-control': 'no-store' } },
  );
}

/**
 * A refusal that names the fields at fault.
 *
 * The uniform-vagueness rule above is about system state — whether a session
 * exists, whether a limit was hit — because the difference is a reconnaissance
 * signal. It does not apply to the caller's own submitted data: telling
 * someone their email address is malformed reveals nothing they did not just
 * type, and withholding it would mean an enquirer staring at a form with no
 * idea which box to fix. Codes, never free text, so nothing supplied is echoed.
 */
function rejectDetails(errors: DetailErrors, origin: string | null): NextResponse {
  return NextResponse.json(
    { error: 'Some details need correcting', fields: errors },
    { status: 400, headers: { ...corsHeaders(origin), 'cache-control': 'no-store' } },
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
  //
  // A presented token only ever *selects* an existing conversation; it is
  // never adopted as the identifier of a new one. Whether it selects anything
  // is decided by findEnquiryBySession, which refuses tokens naming an enquiry
  // already handed to a lawyer or idle past the session window. Anything else
  // starts a fresh enquiry under a freshly minted token — that, and not a
  // merged transcript, is what a returning browser should produce.
  let enquiryId: string | null = null;
  let sessionToken: string | null = null;

  if (payload.sessionToken) {
    const sessionLimit = await checkRateLimit(
      `session:${payload.sessionToken}`,
      RATE_LIMITS.perSession,
    );
    if (!sessionLimit.allowed) {
      return reject(429, 'Too many requests. Please try again later.', origin);
    }
    enquiryId = await findEnquiryBySession(payload.sessionToken);
    if (enquiryId) sessionToken = payload.sessionToken;
  }

  /**
   * The message this turn puts into the transcript.
   *
   * Opening a conversation, it is built from the details; continuing one, it
   * is what the person typed. Assigned in both branches below so the converse
   * step has one input regardless of which it was.
   */
  let userMessage: string;

  if (!enquiryId) {
    // No enquiry may be created without acceptance. This is the only gate —
    // a stale or refused token falls through to here, so a returning browser
    // accepts again for the new conversation rather than inheriting consent
    // given for a different matter, possibly by a different person.
    if (payload.termsAccepted !== true) {
      return reject(400, 'The terms and privacy policy must be accepted.', origin);
    }

    // The opening form is the gate, not a formality: an enquiry the firm
    // cannot reply to is worth less than no enquiry at all, because it also
    // consumes a lawyer's attention. Parsed before the rate-limit slot is
    // spent so a correctable typo does not cost someone their attempt.
    const parsed = parseEnquiryDetails(payload.details);
    if (!parsed.ok) {
      return rejectDetails(parsed.errors, origin);
    }

    const newConversation = await checkRateLimit(
      `new:${ip ?? 'unknown'}`,
      RATE_LIMITS.newConversationPerIp,
    );
    if (!newConversation.allowed) {
      return reject(429, 'Too many requests. Please try again later.', origin);
    }

    const created = await createEnquiry({
      source: 'widget',
      termsVersion: config().TERMS_VERSION,
      ip,
      userAgent: request.headers.get('user-agent'),
      origin,
      office: payload.office ?? null,
      contactName: parsed.details.contactName,
      contactEmail: parsed.details.contactEmail,
      contactPhone: parsed.details.contactPhone,
      enquiryTypeSelected: parsed.details.enquiryType,
    });

    if (!created) return reject(500, 'Could not start the conversation', origin);
    enquiryId = created.id;
    sessionToken = created.sessionToken;
    userMessage = composeInitialMessage(parsed.details);
  } else {
    // A turn inside an existing conversation is only ever a message. Details
    // sent here are ignored rather than applied: the acceptance and the
    // contact record belong to the enquiry a lawyer is being briefed on, and
    // an unauthenticated caller holding a token must not be able to rewrite
    // whose enquiry it is.
    const message = payload.message?.trim() ?? '';
    if (message.length === 0) {
      return reject(400, 'Invalid request', origin);
    }
    userMessage = message;
  }

  // Converse.
  try {
    const turn = await respondToTurn({ enquiryId, userMessage });
    let reply = turn.reply;

    // When the agent has what it needs, hand over to the firm: brief, then
    // proposal, then a closing line that names the proposed slot. Run inline
    // so the enquirer leaves with a time rather than an acknowledgement — see
    // handOverToFirm for why that is worth the latency on this one turn.
    if (turn.readyForBrief) {
      // Retire the session first, so a message sent while the handover runs
      // opens a new enquiry instead of landing on the one a lawyer is about to
      // read.
      await closeSession(enquiryId);
      sessionToken = null;

      const handover = await handOverToFirm(enquiryId);
      reply = `${reply.trimEnd()}\n\n${handover.closingLine}`;
    }

    return NextResponse.json(
      {
        sessionToken,
        reply,
        complete: turn.readyForBrief,
      },
      { headers: { ...corsHeaders(origin), 'cache-control': 'no-store' } },
    );
  } catch (error) {
    console.error('[intake] turn failed', (error as Error).message);
    // Park it for a human rather than losing the enquiry, and retire the
    // session with it: a parked enquiry is not a conversation to continue.
    await markNeedsReview(enquiryId);
    await closeSession(enquiryId);
    return NextResponse.json(
      {
        sessionToken: null,
        reply:
          'Sorry — something went wrong on our side. Your message has been saved and someone ' +
          'from the firm will follow up. If this is urgent, please call the office.',
        complete: true,
      },
      { headers: { ...corsHeaders(origin), 'cache-control': 'no-store' } },
    );
  }
}

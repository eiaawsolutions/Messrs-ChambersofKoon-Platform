import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { config } from '@/lib/config/env';
import { checkRateLimit, clientIp, RATE_LIMITS } from '@/lib/intake/protection';
import { composeInitialMessage, parseEnquiryDetails } from '@/lib/intake/details';
import { createEnquiry } from '@/lib/intake/enquiries';
import { enqueue, JOBS } from '@/lib/jobs/queue';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * No-JavaScript fallback submission (FR-2.2).
 *
 * Accepts a plain form POST, records the enquiry, and queues triage. There is
 * no conversation here — the enquirer wrote one message — so the triage job
 * builds the brief from that single turn and routes low-confidence cases to
 * the human queue exactly as the widget path does.
 *
 * The details themselves are parsed by the shared contract in
 * lib/intake/details.ts, the same one the widget's opening form goes through.
 * This route used to carry its own schema, which accepted a contact number of
 * "x" that the widget would have refused — two entry points into one firm,
 * disagreeing about what makes an enquiry answerable.
 *
 * No Turnstile: this path exists precisely for clients whose browser cannot
 * run the widget's JavaScript, and Turnstile needs JavaScript. The rate limit
 * and the honeypot carry the load instead.
 */

/** Everything about the submission that is not one of the shared details. */
const envelopeSchema = z.object({
  office: z.enum(['KL', 'PJ', 'IPOH']).optional(),
  /** The acceptance tick. A form without it is not submitted, it is refused. */
  terms: z.literal('on'),
  /** Honeypot: a real person never fills this in; it is visually hidden. */
  website: z.string().max(200).optional(),
});

function redirect(request: NextRequest, status: 'sent' | 'error'): NextResponse {
  const url = new URL('/enquiry/received', request.nextUrl.origin);
  url.searchParams.set('status', status);
  return NextResponse.redirect(url, { status: 303 });
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  const ip = clientIp(request.headers);

  const limit = await checkRateLimit(`form:${ip ?? 'unknown'}`, RATE_LIMITS.newConversationPerIp);
  if (!limit.allowed) {
    return redirect(request, 'error');
  }

  let fields: Record<string, unknown>;
  let envelope: z.infer<typeof envelopeSchema>;
  try {
    const formData = await request.formData();
    fields = Object.fromEntries(formData.entries());
    envelope = envelopeSchema.parse(fields);
  } catch {
    return redirect(request, 'error');
  }

  // Honeypot tripped: accept silently so a bot cannot tell it was detected.
  if (typeof envelope.website === 'string' && envelope.website.length > 0) {
    return redirect(request, 'sent');
  }

  const parsed = parseEnquiryDetails(fields);
  if (!parsed.ok) {
    // The page re-renders from scratch on this path, so there is nowhere to
    // put per-field messages without a round of state the fallback form
    // deliberately does not have. A browser that reached here got past the
    // page's own `required` attributes, which means scripting is off and the
    // input is genuinely malformed.
    return redirect(request, 'error');
  }

  const created = await createEnquiry({
    source: 'form',
    termsVersion: config().TERMS_VERSION,
    ip,
    userAgent: request.headers.get('user-agent'),
    contactName: parsed.details.contactName,
    contactEmail: parsed.details.contactEmail,
    contactPhone: parsed.details.contactPhone,
    office: envelope.office ?? null,
    enquiryTypeSelected: parsed.details.enquiryType,
    // The message box is optional, so the selection has to reach the
    // transcript — otherwise an enquiry with no message arrives at triage with
    // nothing to classify.
    initialMessage: composeInitialMessage(parsed.details),
  });

  if (!created) return redirect(request, 'error');

  await enqueue(
    JOBS.TRIAGE_ENQUIRY,
    { enquiryId: created.id },
    { singletonKey: `triage-${created.id}` },
  );

  return redirect(request, 'sent');
}

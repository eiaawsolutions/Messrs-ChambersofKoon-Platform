import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { checkRateLimit, clientIp, RATE_LIMITS } from '@/lib/intake/protection';
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
 * No Turnstile: this path exists precisely for clients whose browser cannot
 * run the widget's JavaScript, and Turnstile needs JavaScript. The rate limit
 * and the honeypot carry the load instead.
 */

const formSchema = z.object({
  contactName: z.string().min(1).max(200),
  contactEmail: z.string().email().max(320),
  contactPhone: z.string().max(40).optional(),
  office: z.enum(['KL', 'PJ', 'IPOH']).optional(),
  message: z.string().min(1).max(4000),
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

  let payload: z.infer<typeof formSchema>;
  try {
    const formData = await request.formData();
    payload = formSchema.parse(Object.fromEntries(formData.entries()));
  } catch {
    return redirect(request, 'error');
  }

  // Honeypot tripped: accept silently so a bot cannot tell it was detected.
  if (payload.website && payload.website.length > 0) {
    return redirect(request, 'sent');
  }

  const created = await createEnquiry({
    source: 'form',
    ip,
    userAgent: request.headers.get('user-agent'),
    contactName: payload.contactName,
    contactEmail: payload.contactEmail,
    contactPhone: payload.contactPhone ?? null,
    office: payload.office ?? null,
    initialMessage: payload.message,
  });

  if (!created) return redirect(request, 'error');

  await enqueue(
    JOBS.TRIAGE_ENQUIRY,
    { enquiryId: created.id },
    { singletonKey: `triage-${created.id}` },
  );

  return redirect(request, 'sent');
}

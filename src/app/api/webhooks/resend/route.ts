import { NextResponse, type NextRequest } from 'next/server';
import { createHmac } from 'node:crypto';
import { optionalSecret } from '@/lib/config/env';
import { safeEqual } from '@/lib/security/crypto';
import { recordDelivery } from '@/lib/comms/delivery';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Resend delivery webhooks (FR-7.5).
 *
 * "Delivery state (sent/delivered/bounced) written back via Resend webhooks and
 *  shown on the matter timeline. Bounces raise a task for the clerk."
 *
 * Resend signs with Svix headers. The signature is verified over the raw body
 * before anything is parsed — verifying a re-serialised object would compare
 * against bytes that were never signed.
 */

interface ResendEvent {
  type: string;
  data?: { email_id?: string; to?: string[]; subject?: string };
}

/**
 * Svix signature scheme: `v1,<base64>` entries in `svix-signature`, computed
 * over `${id}.${timestamp}.${body}` with the base64 portion of the secret.
 */
function verifySignature(params: {
  secret: string;
  id: string;
  timestamp: string;
  body: string;
  header: string;
}): boolean {
  const key = params.secret.startsWith('whsec_')
    ? Buffer.from(params.secret.slice(6), 'base64')
    : Buffer.from(params.secret, 'utf8');

  const expected = createHmac('sha256', key)
    .update(`${params.id}.${params.timestamp}.${params.body}`)
    .digest('base64');

  return params.header
    .split(' ')
    .map((part) => part.split(',')[1] ?? '')
    .filter(Boolean)
    .some((candidate) => safeEqual(candidate, expected));
}

/** Reject replays of an old, validly-signed delivery. */
function timestampIsFresh(timestamp: string, toleranceSeconds = 300): boolean {
  const sent = Number(timestamp);
  if (!Number.isFinite(sent)) return false;
  return Math.abs(Date.now() / 1000 - sent) <= toleranceSeconds;
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  const secret = await optionalSecret('RESEND_WEBHOOK_SECRET');
  const body = await request.text();

  if (secret) {
    const id = request.headers.get('svix-id');
    const timestamp = request.headers.get('svix-timestamp');
    const signature = request.headers.get('svix-signature');

    if (!id || !timestamp || !signature) {
      return NextResponse.json({ error: 'Unsigned' }, { status: 401 });
    }
    if (!timestampIsFresh(timestamp)) {
      return NextResponse.json({ error: 'Stale' }, { status: 401 });
    }
    if (!verifySignature({ secret, id, timestamp, body, header: signature })) {
      return NextResponse.json({ error: 'Invalid signature' }, { status: 401 });
    }
  } else if (process.env.APP_ENV === 'production') {
    // An unverified webhook in production would let anyone mark a bounced
    // client email as delivered. Refuse rather than trust it.
    console.error('[webhook] RESEND_WEBHOOK_SECRET is not configured in production');
    return NextResponse.json({ error: 'Not configured' }, { status: 503 });
  }

  let event: ResendEvent;
  try {
    event = JSON.parse(body) as ResendEvent;
  } catch {
    return NextResponse.json({ error: 'Invalid payload' }, { status: 400 });
  }

  const emailId = event.data?.email_id;
  if (!emailId) {
    return NextResponse.json({ ok: true, note: 'no email id' });
  }

  const outcome = await recordDelivery({ providerMessageId: emailId, event: event.type });
  return NextResponse.json({ ok: true, note: outcome.note });
}

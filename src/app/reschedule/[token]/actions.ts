'use server';

import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { submitRescheduleRequest } from '@/lib/scheduling/client-reschedule';
import { clientIp } from '@/lib/intake/protection';

/**
 * The client's chosen slot (FR-3.8).
 *
 * The token comes from the form rather than a closure so that this action is
 * exactly as exposed as the page is — there is no arrangement of hidden fields
 * that reaches a stronger code path. Everything is re-checked in
 * `submitRescheduleRequest`; nothing here decides anything.
 *
 * Outcomes travel back as a `status` code in the URL and the page renders its
 * own copy for each. Nothing the caller submitted is ever echoed onto the page.
 */
export async function requestRescheduleAction(formData: FormData): Promise<void> {
  const token = String(formData.get('token') ?? '');
  const startsAtIso = String(formData.get('startsAt') ?? '');

  // A token that is not URL-safe base64 cannot match a stored hash; refusing
  // it here keeps a hostile value out of the redirect entirely.
  if (!/^[A-Za-z0-9_-]{16,128}$/.test(token)) redirect('/reschedule/invalid');

  const result = await submitRescheduleRequest({
    token,
    startsAtIso,
    ip: clientIp(await headers()),
  });

  redirect(
    result.ok
      ? `/reschedule/${token}?status=requested`
      : `/reschedule/${token}?status=${result.code}`,
  );
}

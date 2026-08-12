'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { z } from 'zod';
import { requireActor } from '@/lib/auth/session';
import { assertCan } from '@/lib/auth/guard';
import { PERMISSIONS } from '@/lib/auth/permissions';
import { eraseClientData } from '@/lib/privacy/subject-request';

/**
 * Data subject request actions (NFR-2.3).
 *
 * Export is a GET route so the browser downloads a file; only erasure is here,
 * because only erasure changes anything.
 */

const eraseSchema = z.object({
  clientId: z.string().uuid(),
  requestReference: z.string().trim().min(1).max(120),
  /**
   * The operator types the client's name to proceed.
   *
   * Not security — they already hold `privacy.manage` and could post the form
   * directly. It is a deliberate pause in front of the one irreversible action
   * in the product, in the same spirit as the confirmation a package manager
   * asks for before it removes a database.
   */
  confirm: z.string().trim().min(1),
});

export async function eraseClientAction(formData: FormData): Promise<void> {
  const parsed = eraseSchema.parse({
    clientId: formData.get('clientId'),
    requestReference: formData.get('requestReference'),
    confirm: formData.get('confirm'),
  });

  const actor = await requireActor();
  assertCan(actor, PERMISSIONS.PRIVACY_MANAGE);

  const expected = String(formData.get('expectedName') ?? '');
  if (parsed.confirm !== expected) {
    redirect(`/admin/privacy?client=${parsed.clientId}&erase=name_mismatch`);
  }

  const result = await eraseClientData({
    actor,
    clientId: parsed.clientId,
    requestReference: parsed.requestReference,
  });

  revalidatePath('/admin/privacy');
  redirect(`/admin/privacy?erase=${result ? 'done' : 'not_found'}`);
}

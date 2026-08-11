'use server';

import { redirect } from 'next/navigation';
import { requireActor } from '@/lib/auth/session';
import { issueRecoveryCodes } from '@/lib/auth/credentials';
import { audit, AUDIT_ACTIONS } from '@/lib/audit/log';

/**
 * Replace the signed-in user's recovery codes.
 *
 * Only ever acts on the caller's own account — there is no userId parameter,
 * so this cannot be turned into a way to reset someone else's codes by
 * changing a form field.
 */
export async function regenerateRecoveryCodesAction(): Promise<void> {
  const actor = await requireActor();
  const codes = await issueRecoveryCodes(actor.id);

  await audit({
    action: AUDIT_ACTIONS.USER_UPDATE,
    actorUserId: actor.id,
    actorEmail: actor.email,
    entityType: 'user',
    entityId: actor.id,
    metadata: { recoveryCodesRegenerated: codes.length },
  });

  // Shown once on the next render, then gone.
  redirect(`/account?codes=${encodeURIComponent(codes.join(','))}`);
}

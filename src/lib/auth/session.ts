import 'server-only';
import { cache } from 'react';
import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { eq } from 'drizzle-orm';
import { db } from '@/lib/db/client';
import { roles, users, userDevices } from '@/lib/db/schema';
import { auth } from '@/lib/auth/auth';
import { loadGrants, type Actor, AuthorizationError } from '@/lib/auth/guard';
import { ROLE_NAMES, type PermissionKey } from '@/lib/auth/permissions';
import { audit, AUDIT_ACTIONS } from '@/lib/audit/log';
import { sha256 } from '@/lib/security/crypto';

/**
 * Request-scoped actor resolution.
 *
 * Every server request re-reads the user row rather than trusting the JWT
 * alone. That costs one indexed lookup and buys AT-07: a suspended user loses
 * access on their *next request*, not on their next login. `sessionEpoch` does
 * the same job for 2FA resets and forced sign-outs.
 *
 * Wrapped in React `cache` so multiple components in one render share a single
 * lookup.
 */

export const getActor = cache(async (): Promise<Actor | null> => {
  let session: Awaited<ReturnType<typeof auth>>;
  try {
    session = await auth();
  } catch (error) {
    // Auth cannot initialise — almost always because AUTH_SECRET is still a
    // secret:// handle and the Infisical resolver is off. Treat it as "nobody
    // is signed in" rather than a 500: every protected page then redirects to
    // /sign-in, which explains the state, and no unauthenticated request is
    // ever mistaken for an authenticated one.
    console.error('[auth] session resolution failed:', (error as Error).message);
    return null;
  }

  const userId = session?.user?.id;
  if (!userId) return null;

  const [row] = await db
    .select({
      id: users.id,
      email: users.email,
      fullName: users.fullName,
      roleId: users.roleId,
      roleName: roles.name,
      office: users.office,
      status: users.status,
      practiceAreas: users.practiceAreas,
      sessionEpoch: users.sessionEpoch,
    })
    .from(users)
    .innerJoin(roles, eq(roles.id, users.roleId))
    .where(eq(users.id, userId))
    .limit(1);

  if (!row) return null;

  // Session was invalidated server-side (suspend, role change, 2FA reset).
  if (row.sessionEpoch !== (session?.user.sessionEpoch ?? 0)) {
    return null;
  }

  if (row.status !== 'active') {
    return null;
  }

  const grants = await loadGrants(row.roleId);

  return {
    id: row.id,
    email: row.email,
    fullName: row.fullName,
    roleId: row.roleId,
    roleName: row.roleName,
    office: row.office,
    status: row.status,
    practiceAreas: row.practiceAreas,
    grants,
    masksClientIdentifiers: row.roleName === ROLE_NAMES.PUPIL,
    sessionEpoch: row.sessionEpoch,
  };
});

/** For pages: redirect to sign-in when unauthenticated. */
export async function requireActor(): Promise<Actor> {
  const actor = await getActor();
  if (!actor) redirect('/sign-in');
  return actor;
}

/** For pages: require a capability, or 403. */
export async function requirePermission(permission: PermissionKey): Promise<Actor> {
  const actor = await requireActor();
  if (!actor.grants[permission]) {
    await audit({
      action: AUDIT_ACTIONS.MATTER_ACCESS_DENIED,
      actorUserId: actor.id,
      actorEmail: actor.email,
      metadata: { permission },
    });
    throw new AuthorizationError(permission);
  }
  return actor;
}

/** Client IP + user agent for audit rows. */
export async function requestContext(): Promise<{ ip: string | null; userAgent: string | null }> {
  const h = await headers();
  const forwarded = h.get('x-forwarded-for');
  const ip = forwarded ? (forwarded.split(',')[0]?.trim() ?? null) : h.get('x-real-ip');
  return { ip, userAgent: h.get('user-agent') };
}

/**
 * FR-1.4: re-authentication is required on a new device.
 *
 * The fingerprint is a hash of stable-ish request characteristics, never a
 * tracking identifier and never reversible. It is deliberately coarse — this
 * detects "a session token turned up on hardware we have not seen", which is
 * the case worth flagging, and tolerates browser upgrades causing an
 * occasional extra prompt.
 */
export async function recordDevice(actor: Actor): Promise<{ isNew: boolean }> {
  const h = await headers();
  const material = [
    h.get('user-agent') ?? '',
    h.get('accept-language') ?? '',
    h.get('sec-ch-ua-platform') ?? '',
  ].join('|');
  const fingerprintHash = sha256(`${actor.id}:${material}`);

  const [existing] = await db
    .select({ id: userDevices.id })
    .from(userDevices)
    .where(eq(userDevices.fingerprintHash, fingerprintHash))
    .limit(1);

  if (existing) {
    await db
      .update(userDevices)
      .set({ lastSeenAt: new Date() })
      .where(eq(userDevices.id, existing.id));
    return { isNew: false };
  }

  await db
    .insert(userDevices)
    .values({
      userId: actor.id,
      fingerprintHash,
      label: (h.get('user-agent') ?? 'Unknown device').slice(0, 160),
    })
    .onConflictDoNothing();

  const ctx = await requestContext();
  await audit({
    action: AUDIT_ACTIONS.NEW_DEVICE,
    actorUserId: actor.id,
    actorEmail: actor.email,
    ...ctx,
  });

  return { isNew: true };
}

/**
 * Invalidate every live session for a user (suspend, 2FA reset).
 * Bumping the epoch is what makes an unexpirable JWT effectively revocable.
 */
export async function revokeSessions(userId: string): Promise<void> {
  await db
    .update(users)
    .set({ sessionEpoch: (await currentEpoch(userId)) + 1 })
    .where(eq(users.id, userId));
}

async function currentEpoch(userId: string): Promise<number> {
  const [row] = await db
    .select({ epoch: users.sessionEpoch })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  return row?.epoch ?? 0;
}

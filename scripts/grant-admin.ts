import 'dotenv/config';
import { eq, sql } from 'drizzle-orm';
import { db, stopPool } from '@/lib/db/client';
import { roles, users } from '@/lib/db/schema';
import { audit, AUDIT_ACTIONS } from '@/lib/audit/log';
import { allowedEmailDomains } from '@/lib/config/env';
import { isDomainAllowed } from '@/lib/auth/policy';
import { ROLE_NAMES } from '@/lib/auth/permissions';

/**
 * Grant Managing Partner to an email address.
 *
 *   npm run grant:admin -- someone@example.com
 *
 * Why this exists: there is no password store and therefore no way to "create"
 * a user with a credential. Identity comes entirely from the OIDC provider.
 * What this does is pre-authorise an address — the row is created in `active`
 * state with the Managing Partner role, so the first time that person completes
 * SSO they land straight in with full access, instead of arriving as `invited`
 * and needing someone else to approve them.
 *
 * It refuses an address outside ALLOWED_EMAIL_DOMAINS, because a pre-authorised
 * row for an address that can never sign in is just a misleading artefact.
 *
 * Idempotent: re-running promotes an existing row rather than failing.
 */

async function main(): Promise<void> {
  const email = process.argv[2]?.trim().toLowerCase();
  if (!email) {
    console.error('Usage: npm run grant:admin -- <email>');
    process.exit(1);
  }

  const domains = allowedEmailDomains();
  if (!isDomainAllowed(email, domains)) {
    console.error(
      `Refusing: ${email} is not on the allow-list (${domains.join(', ')}).\n` +
        'Add its domain to ALLOWED_EMAIL_DOMAINS first, or this account could never sign in.',
    );
    process.exit(1);
  }

  const [role] = await db
    .select({ id: roles.id })
    .from(roles)
    .where(eq(roles.name, ROLE_NAMES.MANAGING_PARTNER))
    .limit(1);

  if (!role) {
    console.error('Managing Partner role is missing. Run `npm run db:seed` first.');
    process.exit(1);
  }

  const [existing] = await db
    .select({ id: users.id, status: users.status, roleId: users.roleId })
    .from(users)
    .where(sql`lower(${users.email}) = ${email}`)
    .limit(1);

  if (existing) {
    await db
      .update(users)
      .set({
        roleId: role.id,
        status: 'active',
        // Any live session must re-read the new grants on its next request.
        sessionEpoch: sql`${users.sessionEpoch} + 1`,
      })
      .where(eq(users.id, existing.id));

    await audit({
      action: AUDIT_ACTIONS.USER_UPDATE,
      actorEmail: email,
      entityType: 'user',
      entityId: existing.id,
      metadata: { promotedTo: ROLE_NAMES.MANAGING_PARTNER, via: 'grant-admin script' },
    });

    console.log(`Promoted existing user ${email} to ${ROLE_NAMES.MANAGING_PARTNER} (active).`);
  } else {
    const [created] = await db
      .insert(users)
      .values({
        email,
        fullName: email.split('@')[0] ?? email,
        roleId: role.id,
        office: 'KL',
        status: 'active',
      })
      .returning({ id: users.id });

    if (!created) {
      console.error('Insert failed.');
      process.exit(1);
    }

    await audit({
      action: AUDIT_ACTIONS.USER_CREATE,
      actorEmail: email,
      entityType: 'user',
      entityId: created.id,
      metadata: { role: ROLE_NAMES.MANAGING_PARTNER, via: 'grant-admin script' },
    });

    console.log(`Pre-authorised ${email} as ${ROLE_NAMES.MANAGING_PARTNER} (active).`);
  }

  console.log(
    '\nThere is no password to set. Sign in at /sign-in with the identity provider\n' +
      'for that address; the account is already active with full administrative access.',
  );

  await stopPool();
}

main().catch(async (error: unknown) => {
  console.error('grant-admin failed:', error);
  await stopPool().catch(() => {});
  process.exit(1);
});

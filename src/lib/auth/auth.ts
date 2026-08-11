import NextAuth, { type NextAuthConfig, type Session } from 'next-auth';
import Google from 'next-auth/providers/google';
import MicrosoftEntraID from 'next-auth/providers/microsoft-entra-id';
import { eq, sql } from 'drizzle-orm';
import { db } from '@/lib/db/client';
import { roles, users } from '@/lib/db/schema';
import { allowedEmailDomains, config, optionalSecret, secret } from '@/lib/config/env';
import { audit, AUDIT_ACTIONS } from '@/lib/audit/log';
import { ROLE_NAMES } from '@/lib/auth/permissions';

/**
 * Authentication (M1, FR-1.1 – FR-1.4).
 *
 * Identity is entirely delegated to the firm's Google Workspace or Microsoft
 * 365 tenant. There is no local password store, no password reset flow and no
 * credentials provider — those are the routes an attacker actually uses, and
 * removing them is cheaper than defending them.
 *
 * Session strategy is JWT rather than database-backed, so the edge middleware
 * can authorise without a database round trip. The trade-off is that a JWT
 * cannot be revoked by deleting a row — solved by `sessionEpoch`: every
 * suspend / 2FA reset bumps the counter on the user, and `getActor()` compares
 * the token's epoch against the database on every server request (AT-07).
 */

/** True when the ID token carries evidence the IdP enforced a second factor. */
export function hasMfaClaim(profile: Record<string, unknown> | undefined): boolean {
  if (!profile) return false;

  // Microsoft Entra: amr contains "mfa"; acr "1" historically meant MFA.
  const amr = profile.amr;
  if (Array.isArray(amr) && amr.some((m) => typeof m === 'string' && /mfa|otp|fido|hwk/i.test(m))) {
    return true;
  }
  // Google Workspace does not emit amr; it does not surface an MFA claim at
  // all. Absence is therefore not evidence of absence — see enforceMfa().
  const acr = profile.acr;
  if (typeof acr === 'string' && /mfa|aal2|aal3/i.test(acr)) return true;

  return false;
}

/**
 * FR-1.2: "Reject a session whose token lacks an MFA claim where the provider
 * supplies one; surface a setup prompt on first login otherwise."
 *
 * Entra supplies `amr`, so a missing MFA claim there is a real signal and the
 * session is rejected. Google does not supply one, so rejecting would lock the
 * whole firm out; instead the account is flagged and the dashboard shows a
 * 2-step-verification setup prompt.
 */
export function enforceMfa(
  provider: string,
  profile: Record<string, unknown> | undefined,
): { allowed: boolean; promptSetup: boolean } {
  const providerSuppliesClaim = provider === 'microsoft-entra-id';
  const present = hasMfaClaim(profile);

  if (providerSuppliesClaim) {
    return { allowed: present, promptSetup: false };
  }
  return { allowed: true, promptSetup: !present };
}

export function isDomainAllowed(email: string, domains: string[]): boolean {
  const at = email.lastIndexOf('@');
  if (at < 0) return false;
  const domain = email.slice(at + 1).toLowerCase();
  return domains.includes(domain);
}

async function buildProviders(): Promise<NextAuthConfig['providers']> {
  const providers: NextAuthConfig['providers'] = [];

  const googleId = await optionalSecret('AUTH_GOOGLE_ID');
  const googleSecret = await optionalSecret('AUTH_GOOGLE_SECRET');
  if (googleId && googleSecret) {
    providers.push(
      Google({
        clientId: googleId,
        clientSecret: googleSecret,
        authorization: {
          params: {
            // Restrict the account chooser to the firm's tenant where possible.
            hd: allowedEmailDomains()[0],
            prompt: 'select_account',
          },
        },
      }),
    );
  }

  const msId = await optionalSecret('AUTH_MICROSOFT_ID');
  const msSecret = await optionalSecret('AUTH_MICROSOFT_SECRET');
  const msTenant = await optionalSecret('AUTH_MICROSOFT_TENANT_ID');
  if (msId && msSecret && msTenant) {
    providers.push(
      MicrosoftEntraID({
        clientId: msId,
        clientSecret: msSecret,
        issuer: `https://login.microsoftonline.com/${msTenant}/v2.0`,
      }),
    );
  }

  return providers;
}

/**
 * Find or create the user record for a verified SSO identity (FR-1.3).
 *
 * New users land in `invited` and cannot do anything until the Managing
 * Partner activates and assigns a role — except the very first user on an
 * empty table, who becomes the Managing Partner. That bootstrap avoids
 * needing a seeded password or an invite token to exist anywhere.
 */
async function provisionUser(params: {
  email: string;
  fullName: string;
  provider: string;
  subject: string;
}): Promise<{ id: string; status: string; roleId: string } | null> {
  const email = params.email.toLowerCase();

  const [existing] = await db
    .select({ id: users.id, status: users.status, roleId: users.roleId })
    .from(users)
    .where(sql`lower(${users.email}) = ${email}`)
    .limit(1);

  if (existing) {
    await db
      .update(users)
      .set({
        lastLoginAt: new Date(),
        ssoProvider: params.provider,
        ssoSubject: params.subject,
      })
      .where(eq(users.id, existing.id));
    return existing;
  }

  const [{ count } = { count: 0 }] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(users);
  const isBootstrap = count === 0;

  const roleName = isBootstrap ? ROLE_NAMES.MANAGING_PARTNER : ROLE_NAMES.ASSOCIATE;
  const [role] = await db
    .select({ id: roles.id })
    .from(roles)
    .where(eq(roles.name, roleName))
    .limit(1);

  if (!role) {
    console.error('[auth] cannot provision user: seeded roles are missing. Run `npm run db:seed`.');
    return null;
  }

  const [created] = await db
    .insert(users)
    .values({
      email,
      fullName: params.fullName || email,
      roleId: role.id,
      office: 'KL',
      // Bootstrap user is active immediately; everyone else waits for approval.
      status: isBootstrap ? 'active' : 'invited',
      ssoProvider: params.provider,
      ssoSubject: params.subject,
      lastLoginAt: new Date(),
    })
    .returning({ id: users.id, status: users.status, roleId: users.roleId });

  if (created) {
    await audit({
      action: AUDIT_ACTIONS.USER_CREATE,
      actorUserId: created.id,
      actorEmail: email,
      entityType: 'user',
      entityId: created.id,
      metadata: { provider: params.provider, bootstrap: isBootstrap, status: created.status },
    });
  }

  return created ?? null;
}

export const authConfig: NextAuthConfig = {
  providers: [],
  session: {
    strategy: 'jwt',
    maxAge: config().SESSION_MAX_AGE_SECONDS, // FR-1.4: 12 hours
  },
  pages: {
    signIn: '/sign-in',
    error: '/sign-in',
  },
  trustHost: true,
  callbacks: {
    async signIn({ user, account, profile }) {
      const email = user.email?.toLowerCase();
      if (!email || !account) return false;

      // FR-1.3: allow-list check happens before any record is created.
      if (!isDomainAllowed(email, allowedEmailDomains())) {
        await audit({
          action: AUDIT_ACTIONS.LOGIN_DENIED_DOMAIN,
          actorEmail: email,
          metadata: { provider: account.provider },
        });
        return false;
      }

      // Providers must have verified the address themselves.
      const emailVerified = (profile as { email_verified?: boolean } | undefined)?.email_verified;
      if (account.provider === 'google' && emailVerified === false) {
        return false;
      }

      const mfa = enforceMfa(account.provider, profile as Record<string, unknown> | undefined);
      if (!mfa.allowed) {
        await audit({
          action: AUDIT_ACTIONS.LOGIN_FAILURE,
          actorEmail: email,
          metadata: { provider: account.provider, reason: 'mfa_claim_missing' },
        });
        return false;
      }

      const record = await provisionUser({
        email,
        fullName: user.name ?? email,
        provider: account.provider,
        subject: account.providerAccountId,
      });

      if (!record) return false;

      if (record.status === 'suspended') {
        await audit({
          action: AUDIT_ACTIONS.LOGIN_FAILURE,
          actorUserId: record.id,
          actorEmail: email,
          metadata: { reason: 'suspended' },
        });
        return false;
      }

      await audit({
        action: AUDIT_ACTIONS.LOGIN_SUCCESS,
        actorUserId: record.id,
        actorEmail: email,
        metadata: { provider: account.provider, mfaSetupPrompt: mfa.promptSetup },
      });

      return true;
    },

    async jwt({ token, user, trigger }) {
      // On sign-in, and on explicit refresh, stamp the identity onto the token.
      if (user?.email || trigger === 'update') {
        const email = (user?.email ?? token.email)?.toLowerCase();
        if (email) {
          const [row] = await db
            .select({
              id: users.id,
              roleId: users.roleId,
              status: users.status,
              sessionEpoch: users.sessionEpoch,
            })
            .from(users)
            .where(sql`lower(${users.email}) = ${email}`)
            .limit(1);
          if (row) {
            token.userId = row.id;
            token.roleId = row.roleId;
            token.status = row.status;
            token.sessionEpoch = row.sessionEpoch;
          }
        }
      }
      return token;
    },

    async session({ session, token }) {
      if (session.user) {
        session.user.id = (token.userId as string) ?? '';
        session.user.roleId = (token.roleId as string) ?? '';
        session.user.status = (token.status as string) ?? 'invited';
        session.user.sessionEpoch = (token.sessionEpoch as number) ?? 0;
      }
      return session;
    },
  },
  events: {
    async signOut(message) {
      const token = 'token' in message ? message.token : null;
      if (token?.userId) {
        await audit({
          action: AUDIT_ACTIONS.LOGOUT,
          actorUserId: token.userId as string,
          actorEmail: (token.email as string) ?? null,
        });
      }
    },
  },
};

/**
 * Built lazily because provider secrets may be Infisical handles, which cannot
 * be resolved synchronously at module load.
 */
let handlers: ReturnType<typeof NextAuth> | null = null;

async function getNextAuth(): Promise<ReturnType<typeof NextAuth>> {
  if (handlers) return handlers;
  handlers = NextAuth({
    ...authConfig,
    secret: await secret('AUTH_SECRET'),
    providers: await buildProviders(),
  });
  return handlers;
}

/**
 * Current session, or null. `NextAuth().auth` is overloaded (middleware
 * wrapper / route wrapper / bare session getter); this narrows to the bare
 * getter, which is the only form the app uses.
 */
export async function auth(): Promise<Session | null> {
  const instance = await getNextAuth();
  const getSession = instance.auth as unknown as () => Promise<Session | null>;
  return getSession();
}

export async function signIn(
  ...args: Parameters<ReturnType<typeof NextAuth>['signIn']>
): ReturnType<ReturnType<typeof NextAuth>['signIn']> {
  const instance = await getNextAuth();
  return instance.signIn(...args);
}

export async function signOut(
  ...args: Parameters<ReturnType<typeof NextAuth>['signOut']>
): ReturnType<ReturnType<typeof NextAuth>['signOut']> {
  const instance = await getNextAuth();
  return instance.signOut(...args);
}

export async function authHandlers(): Promise<ReturnType<typeof NextAuth>['handlers']> {
  const instance = await getNextAuth();
  return instance.handlers;
}

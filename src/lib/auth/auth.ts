import NextAuth, { type NextAuthConfig, type Session } from 'next-auth';
import Credentials from 'next-auth/providers/credentials';
import Google from 'next-auth/providers/google';
import MicrosoftEntraID from 'next-auth/providers/microsoft-entra-id';
import { eq, sql } from 'drizzle-orm';
import { db } from '@/lib/db/client';
import { roles, users } from '@/lib/db/schema';
import { allowedEmailDomains, config, optionalSecret, secret } from '@/lib/config/env';
import { audit, AUDIT_ACTIONS } from '@/lib/audit/log';
import { ROLE_NAMES } from '@/lib/auth/permissions';
import { enforceMfa, isDomainAllowed } from '@/lib/auth/policy';
import { readChallenge } from '@/lib/auth/credentials';

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

/** Public providers that can never be a Workspace `hd` value. */
const PUBLIC_EMAIL_DOMAINS = new Set([
  'gmail.com',
  'googlemail.com',
  'outlook.com',
  'hotmail.com',
  'yahoo.com',
  'icloud.com',
]);

export function googleHostedDomain(): string | null {
  const domains = allowedEmailDomains();
  if (domains.length !== 1) return null;
  const only = domains[0]!;
  return PUBLIC_EMAIL_DOMAINS.has(only) ? null : only;
}

async function buildProviders(): Promise<NextAuthConfig['providers']> {
  const providers: NextAuthConfig['providers'] = [];

  /**
   * Local credentials (PRD amendment A1) — the firm's primary sign-in.
   *
   * `authorize` never sees a password. Both factors are checked by the
   * sign-in server actions, which then hand over a short-lived signed
   * challenge; this only verifies that signature. Keeping the factor checks
   * out of `authorize` is what allows the two-step UI without ever holding a
   * half-authenticated session.
   */
  providers.push(
    Credentials({
      id: 'credentials',
      name: 'Firm account',
      credentials: {
        challenge: { label: 'challenge', type: 'text' },
      },
      async authorize(raw) {
        const token = typeof raw?.challenge === 'string' ? raw.challenge : '';
        if (!token) return null;

        // Only a challenge minted after both factors succeeded is accepted.
        const payload = await readChallenge(token, 'session');
        if (!payload) return null;

        const [user] = await db
          .select({
            id: users.id,
            email: users.email,
            fullName: users.fullName,
            status: users.status,
          })
          .from(users)
          .where(eq(users.id, payload.userId))
          .limit(1);

        if (!user || user.status !== 'active') return null;

        await db.update(users).set({ lastLoginAt: new Date() }).where(eq(users.id, user.id));

        return { id: user.id, email: user.email, name: user.fullName };
      },
    }),
  );

  const googleId = await optionalSecret('AUTH_GOOGLE_ID');
  const googleSecret = await optionalSecret('AUTH_GOOGLE_SECRET');
  if (googleId && googleSecret) {
    providers.push(
      Google({
        clientId: googleId,
        clientSecret: googleSecret,
        authorization: {
          params: {
            /**
             * `hd` restricts the Google account chooser to a single Workspace
             * domain. It is a convenience, not a control — the real gate is the
             * server-side allow-list check in the signIn callback.
             *
             * It is only sent when exactly one domain is allow-listed and that
             * domain is a Workspace domain. Sending it while a public provider
             * (gmail.com) or a second domain is allow-listed would lock out
             * accounts the firm has deliberately permitted.
             */
            ...(googleHostedDomain() ? { hd: googleHostedDomain()! } : {}),
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

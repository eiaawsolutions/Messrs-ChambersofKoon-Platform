import 'server-only';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { db } from '@/lib/db/client';
import { recoveryCodes, users } from '@/lib/db/schema';
import { hashPassword, verifyPassword, needsRehash } from '@/lib/auth/password';
import { generateTotpSecret, otpauthUri, verifyTotp } from '@/lib/auth/totp';
import { encryptField, decryptField, sha256, safeEqual } from '@/lib/security/crypto';
import { audit, AUDIT_ACTIONS } from '@/lib/audit/log';
import { config, secret } from '@/lib/config/env';

/**
 * Local credential authentication (PRD amendment A1).
 *
 * Sign-in is two steps, in the shape people already know from Google:
 *
 *   1. email + password
 *   2. six-digit code from an authenticator app — enrolled on first sign-in,
 *      required on every sign-in after that
 *
 * Between the two steps the server holds no session. It issues a short-lived
 * signed **challenge** instead, which proves step 1 succeeded without granting
 * any access. Nothing reads the database as an authenticated user until both
 * factors are satisfied.
 *
 * Two properties are load-bearing and easy to lose:
 *
 * - **No user enumeration.** An unknown address and a wrong password produce
 *   the same result, after the same work. `verifyCredentials` always performs a
 *   full scrypt derivation, against a decoy hash when the account does not
 *   exist, so response timing does not disclose which addresses are real.
 * - **Lockout is per account, not per request.** Rate limiting the endpoint
 *   alone does not stop a slow distributed guess against one known partner's
 *   address.
 */

/** Failed attempts before the account locks. */
const MAX_FAILED_ATTEMPTS = 8;
/** How long a locked account stays locked. */
const LOCKOUT_MINUTES = 15;
/** Life of the between-steps challenge. Long enough to open an app and read a code. */
const CHALLENGE_TTL_SECONDS = 300;
const RECOVERY_CODE_COUNT = 10;

/**
 * A real scrypt hash of a value nobody knows, used when the account does not
 * exist so the wrong-address path costs the same as the wrong-password path.
 * Generated once per process.
 */
let decoyHash: string | null = null;
async function getDecoyHash(): Promise<string> {
  if (!decoyHash) decoyHash = await hashPassword(randomBytes(32).toString('hex'));
  return decoyHash;
}

export type SignInOutcome =
  | { status: 'invalid' }
  | { status: 'locked'; until: Date }
  | { status: 'suspended' }
  | { status: 'no_password' }
  | { status: 'enrol_2fa'; challenge: string }
  | { status: 'verify_2fa'; challenge: string }
  | { status: 'must_change_password'; challenge: string };

interface ChallengePayload {
  userId: string;
  purpose: 'enrol_2fa' | 'verify_2fa' | 'change_password' | 'session';
  exp: number;
}

/**
 * Sign a challenge with AUTH_SECRET. Not a session: it carries no grants, is
 * valid for minutes, and is accepted only by the step it names.
 */
export async function issueChallenge(payload: Omit<ChallengePayload, 'exp'>): Promise<string> {
  const key = await secret('AUTH_SECRET');
  const body: ChallengePayload = {
    ...payload,
    exp: Math.floor(Date.now() / 1000) + CHALLENGE_TTL_SECONDS,
  };
  const encoded = Buffer.from(JSON.stringify(body)).toString('base64url');
  const signature = createHmac('sha256', key).update(encoded).digest('base64url');
  return `${encoded}.${signature}`;
}

export async function readChallenge(
  token: string,
  purpose: ChallengePayload['purpose'],
): Promise<ChallengePayload | null> {
  const [encoded, signature] = token.split('.');
  if (!encoded || !signature) return null;

  const key = await secret('AUTH_SECRET');
  const expected = createHmac('sha256', key).update(encoded).digest('base64url');
  if (!safeEqual(signature, expected)) return null;

  let payload: ChallengePayload;
  try {
    payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as ChallengePayload;
  } catch {
    return null;
  }

  if (payload.exp < Math.floor(Date.now() / 1000)) return null;
  if (payload.purpose !== purpose) return null;
  return payload;
}

/** Step 1: email + password. */
export async function verifyCredentials(params: {
  email: string;
  password: string;
  ip?: string | null;
  userAgent?: string | null;
}): Promise<SignInOutcome> {
  const email = params.email.trim().toLowerCase();

  const [user] = await db
    .select({
      id: users.id,
      email: users.email,
      status: users.status,
      passwordHash: users.passwordHash,
      mustChangePassword: users.mustChangePassword,
      failedLoginAttempts: users.failedLoginAttempts,
      lockedUntil: users.lockedUntil,
      totpEnrolledAt: users.totpEnrolledAt,
    })
    .from(users)
    .where(sql`lower(${users.email}) = ${email}`)
    .limit(1);

  // Always do the work, even when there is no account, so timing does not
  // reveal which addresses exist.
  const hashToCheck = user?.passwordHash ?? (await getDecoyHash());
  const passwordOk = await verifyPassword(params.password, hashToCheck);

  if (!user) {
    await audit({
      action: AUDIT_ACTIONS.LOGIN_FAILURE,
      actorEmail: email,
      metadata: { reason: 'unknown_account' },
      ip: params.ip ?? null,
      userAgent: params.userAgent ?? null,
    });
    return { status: 'invalid' };
  }

  if (user.lockedUntil && user.lockedUntil > new Date()) {
    await audit({
      action: AUDIT_ACTIONS.LOGIN_FAILURE,
      actorUserId: user.id,
      actorEmail: email,
      metadata: { reason: 'locked' },
      ip: params.ip ?? null,
      userAgent: params.userAgent ?? null,
    });
    return { status: 'locked', until: user.lockedUntil };
  }

  if (!user.passwordHash) {
    // Account exists but has never had a password set. Reported as invalid so
    // the distinction is not observable from outside.
    return { status: 'invalid' };
  }

  if (!passwordOk) {
    const attempts = user.failedLoginAttempts + 1;
    const locked = attempts >= MAX_FAILED_ATTEMPTS;
    await db
      .update(users)
      .set({
        failedLoginAttempts: attempts,
        lockedUntil: locked ? new Date(Date.now() + LOCKOUT_MINUTES * 60_000) : null,
      })
      .where(eq(users.id, user.id));

    await audit({
      action: AUDIT_ACTIONS.LOGIN_FAILURE,
      actorUserId: user.id,
      actorEmail: email,
      metadata: { reason: 'bad_password', attempts, locked },
      ip: params.ip ?? null,
      userAgent: params.userAgent ?? null,
    });
    return { status: 'invalid' };
  }

  // Correct password from here on.
  await db
    .update(users)
    .set({ failedLoginAttempts: 0, lockedUntil: null })
    .where(eq(users.id, user.id));

  // Opportunistic upgrade if the stored parameters are below current policy.
  if (needsRehash(user.passwordHash)) {
    await db
      .update(users)
      .set({ passwordHash: await hashPassword(params.password) })
      .where(eq(users.id, user.id));
  }

  if (user.status === 'suspended') return { status: 'suspended' };

  if (user.mustChangePassword) {
    return {
      status: 'must_change_password',
      challenge: await issueChallenge({ userId: user.id, purpose: 'change_password' }),
    };
  }

  // First sign-in enrols the second factor, the way Google does — the account
  // is not usable until it is set up.
  if (!user.totpEnrolledAt) {
    return {
      status: 'enrol_2fa',
      challenge: await issueChallenge({ userId: user.id, purpose: 'enrol_2fa' }),
    };
  }

  return {
    status: 'verify_2fa',
    challenge: await issueChallenge({ userId: user.id, purpose: 'verify_2fa' }),
  };
}

export interface EnrolmentOffer {
  secret: string;
  otpauthUri: string;
  accountName: string;
}

/**
 * Produce (or re-produce) the secret to show on the enrolment screen.
 *
 * The secret is stored immediately but `totp_enrolled_at` stays null until a
 * code is verified, so an interrupted enrolment leaves the account exactly
 * where it was rather than half-configured with a secret nobody has.
 */
export async function beginTotpEnrolment(userId: string): Promise<EnrolmentOffer | null> {
  const [user] = await db
    .select({
      id: users.id,
      email: users.email,
      totpSecretEncrypted: users.totpSecretEncrypted,
      totpEnrolledAt: users.totpEnrolledAt,
    })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);

  if (!user || user.totpEnrolledAt) return null;

  let plainSecret: string;
  if (user.totpSecretEncrypted) {
    // Reuse the pending secret so a refresh does not invalidate a QR code the
    // person has already scanned.
    try {
      plainSecret = await decryptField(user.totpSecretEncrypted);
    } catch {
      plainSecret = generateTotpSecret();
      await db
        .update(users)
        .set({ totpSecretEncrypted: await encryptField(plainSecret) })
        .where(eq(users.id, userId));
    }
  } else {
    plainSecret = generateTotpSecret();
    await db
      .update(users)
      .set({ totpSecretEncrypted: await encryptField(plainSecret) })
      .where(eq(users.id, userId));
  }

  return {
    secret: plainSecret,
    accountName: user.email,
    otpauthUri: otpauthUri({
      secret: plainSecret,
      accountName: user.email,
      issuer: `${config().FIRM_SHORT_NAME} — Matter Velocity`,
    }),
  };
}

export type TotpResult =
  | { ok: true; recoveryCodes?: string[] }
  | { ok: false; reason: 'invalid_code' | 'not_enrolled' | 'no_user' };

/** Complete enrolment by proving a code, then hand over recovery codes once. */
export async function completeTotpEnrolment(params: {
  userId: string;
  token: string;
}): Promise<TotpResult> {
  const [user] = await db
    .select({
      id: users.id,
      email: users.email,
      totpSecretEncrypted: users.totpSecretEncrypted,
      totpEnrolledAt: users.totpEnrolledAt,
    })
    .from(users)
    .where(eq(users.id, params.userId))
    .limit(1);

  if (!user?.totpSecretEncrypted) return { ok: false, reason: 'not_enrolled' };

  const plainSecret = await decryptField(user.totpSecretEncrypted);
  const result = verifyTotp({ secret: plainSecret, token: params.token });
  if (!result.valid) return { ok: false, reason: 'invalid_code' };

  await db
    .update(users)
    .set({ totpEnrolledAt: new Date(), totpLastStep: result.step })
    .where(eq(users.id, user.id));

  const codes = await issueRecoveryCodes(user.id);

  await audit({
    action: AUDIT_ACTIONS.USER_UPDATE,
    actorUserId: user.id,
    actorEmail: user.email,
    entityType: 'user',
    entityId: user.id,
    metadata: { twoFactorEnrolled: true, recoveryCodesIssued: codes.length },
  });

  return { ok: true, recoveryCodes: codes };
}

/** Verify a code at sign-in, rejecting replays. */
export async function verifyTotpForSignIn(params: {
  userId: string;
  token: string;
}): Promise<TotpResult> {
  const [user] = await db
    .select({
      id: users.id,
      totpSecretEncrypted: users.totpSecretEncrypted,
      totpEnrolledAt: users.totpEnrolledAt,
      totpLastStep: users.totpLastStep,
    })
    .from(users)
    .where(eq(users.id, params.userId))
    .limit(1);

  if (!user) return { ok: false, reason: 'no_user' };
  if (!user.totpSecretEncrypted || !user.totpEnrolledAt) {
    return { ok: false, reason: 'not_enrolled' };
  }

  const plainSecret = await decryptField(user.totpSecretEncrypted);
  const result = verifyTotp({
    secret: plainSecret,
    token: params.token,
    lastUsedStep: user.totpLastStep,
  });

  if (!result.valid) return { ok: false, reason: 'invalid_code' };

  await db.update(users).set({ totpLastStep: result.step }).where(eq(users.id, user.id));
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Recovery codes
// ---------------------------------------------------------------------------

function formatRecoveryCode(): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = randomBytes(10);
  let code = '';
  for (let i = 0; i < 10; i += 1) {
    code += alphabet[bytes[i]! % alphabet.length];
  }
  return `${code.slice(0, 5)}-${code.slice(5)}`;
}

/** Replace any existing codes with a fresh set. Returned in clear once only. */
export async function issueRecoveryCodes(userId: string): Promise<string[]> {
  const codes = Array.from({ length: RECOVERY_CODE_COUNT }, formatRecoveryCode);

  await db.delete(recoveryCodes).where(eq(recoveryCodes.userId, userId));
  await db.insert(recoveryCodes).values(
    codes.map((code) => ({
      userId,
      codeHash: sha256(code.replace(/-/g, '').toUpperCase()),
    })),
  );

  return codes;
}

/** Spend a recovery code. Each works once. */
export async function consumeRecoveryCode(params: {
  userId: string;
  code: string;
}): Promise<boolean> {
  const normalised = params.code.replace(/[\s-]/g, '').toUpperCase();
  if (normalised.length < 8) return false;

  const hash = sha256(normalised);

  const [row] = await db
    .select({ id: recoveryCodes.id })
    .from(recoveryCodes)
    .where(
      and(
        eq(recoveryCodes.userId, params.userId),
        eq(recoveryCodes.codeHash, hash),
        isNull(recoveryCodes.usedAt),
      ),
    )
    .limit(1);

  if (!row) return false;

  await db.update(recoveryCodes).set({ usedAt: new Date() }).where(eq(recoveryCodes.id, row.id));

  await audit({
    action: AUDIT_ACTIONS.LOGIN_SUCCESS,
    actorUserId: params.userId,
    entityType: 'user',
    entityId: params.userId,
    metadata: { via: 'recovery_code' },
  });

  return true;
}

export async function remainingRecoveryCodes(userId: string): Promise<number> {
  const [row] = await db
    .select({ value: sql<number>`count(*)::int` })
    .from(recoveryCodes)
    .where(and(eq(recoveryCodes.userId, userId), isNull(recoveryCodes.usedAt)));
  return row?.value ?? 0;
}

// ---------------------------------------------------------------------------
// Password changes
// ---------------------------------------------------------------------------

/**
 * Set a password.
 *
 * `forceChangeOnNextSignIn` is for the admin-issued temporary password path;
 * everything else leaves it false. Named positively because the previous
 * `clearMustChange` phrasing inverted at the call site and was one careless
 * edit away from leaving every reset account permanently stuck on the
 * change-password screen.
 */
export async function setPassword(params: {
  userId: string;
  password: string;
  forceChangeOnNextSignIn?: boolean;
}): Promise<void> {
  await db
    .update(users)
    .set({
      passwordHash: await hashPassword(params.password),
      passwordUpdatedAt: new Date(),
      mustChangePassword: params.forceChangeOnNextSignIn === true,
      failedLoginAttempts: 0,
      lockedUntil: null,
      // Any other live session must not survive a password change.
      sessionEpoch: sql`${users.sessionEpoch} + 1`,
    })
    .where(eq(users.id, params.userId));
}

/** Change with the current password proved. */
export async function changePassword(params: {
  userId: string;
  currentPassword: string;
  newPassword: string;
}): Promise<boolean> {
  const [user] = await db
    .select({ id: users.id, email: users.email, passwordHash: users.passwordHash })
    .from(users)
    .where(eq(users.id, params.userId))
    .limit(1);

  if (!user?.passwordHash) return false;
  if (!(await verifyPassword(params.currentPassword, user.passwordHash))) return false;

  await setPassword({ userId: user.id, password: params.newPassword });

  await audit({
    action: AUDIT_ACTIONS.USER_UPDATE,
    actorUserId: user.id,
    actorEmail: user.email,
    entityType: 'user',
    entityId: user.id,
    metadata: { passwordChanged: true, sessionsRevoked: true },
  });

  return true;
}

/** Timing-safe equality for non-secret comparisons in this module. */
export function constantTimeEquals(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

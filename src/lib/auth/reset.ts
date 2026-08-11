import 'server-only';
import { and, eq, gt, isNull, lt, sql } from 'drizzle-orm';
import { db } from '@/lib/db/client';
import { passwordResetTokens, users } from '@/lib/db/schema';
import { randomToken, sha256 } from '@/lib/security/crypto';
import { setPassword } from '@/lib/auth/credentials';
import { sendEmail, textToHtml } from '@/lib/email/resend';
import { config } from '@/lib/config/env';
import { audit, AUDIT_ACTIONS } from '@/lib/audit/log';

/**
 * Password reset (PRD amendment A1).
 *
 * Properties that matter more than the happy path:
 *
 * - **The token is never stored.** Only its SHA-256 hash is, so a database
 *   disclosure yields no working reset links.
 * - **The response never reveals whether an address exists.** `requestReset`
 *   returns the same value either way; only the mailbox owner learns anything.
 * - **Single use, and superseding.** Issuing a new token invalidates the
 *   outstanding ones, and consuming one invalidates the rest — so a forwarded
 *   or leaked older email is inert.
 * - **A reset revokes live sessions.** Someone resetting a password because
 *   they think an account is compromised expects that to end the intruder's
 *   session, not just change a value.
 *
 * A reset deliberately does **not** clear the second factor. An attacker with
 * mailbox access would otherwise get all the way in; they still need the
 * authenticator or a recovery code.
 */

const TOKEN_TTL_MINUTES = 45;

export interface ResetRequestOutcome {
  /** Always true. Kept explicit so call sites cannot accidentally branch on it. */
  accepted: true;
}

export async function requestPasswordReset(params: {
  email: string;
  ip?: string | null;
}): Promise<ResetRequestOutcome> {
  const email = params.email.trim().toLowerCase();

  const [user] = await db
    .select({ id: users.id, email: users.email, fullName: users.fullName, status: users.status })
    .from(users)
    .where(sql`lower(${users.email}) = ${email}`)
    .limit(1);

  // A suspended account must not be recoverable by its former holder.
  if (!user || user.status === 'suspended') {
    await audit({
      action: AUDIT_ACTIONS.LOGIN_FAILURE,
      actorEmail: email,
      metadata: { reason: 'reset_requested_for_unknown_or_suspended' },
      ip: params.ip ?? null,
    });
    return { accepted: true };
  }

  // Supersede anything outstanding, so only the newest email works.
  await db
    .update(passwordResetTokens)
    .set({ usedAt: new Date() })
    .where(and(eq(passwordResetTokens.userId, user.id), isNull(passwordResetTokens.usedAt)));

  const token = randomToken(32);
  await db.insert(passwordResetTokens).values({
    userId: user.id,
    tokenHash: sha256(token),
    expiresAt: new Date(Date.now() + TOKEN_TTL_MINUTES * 60_000),
    requestedIp: params.ip ?? null,
  });

  const cfg = config();
  const url = `${cfg.APP_BASE_URL}/reset-password?token=${token}`;
  const body = `Hello ${user.fullName},

Someone asked to reset the password for your ${cfg.FIRM_NAME} account.

Use this link within ${TOKEN_TTL_MINUTES} minutes:

${url}

You will still need your authenticator app to sign in afterwards — resetting a
password does not change the second step.

If this was not you, ignore this email; your password has not changed. Tell the
practice manager if you receive several of these.`;

  try {
    await sendEmail({
      to: user.email,
      subject: `Reset your ${cfg.FIRM_SHORT_NAME} password`,
      text: body,
      html: textToHtml(body, cfg.FIRM_NAME),
    });
  } catch (error) {
    // Never surface a send failure to the caller — that would confirm the
    // address exists. It is logged for the operator instead.
    console.error('[reset] could not send reset email:', (error as Error).message);
  }

  await audit({
    action: AUDIT_ACTIONS.USER_UPDATE,
    actorUserId: user.id,
    actorEmail: user.email,
    entityType: 'user',
    entityId: user.id,
    metadata: { passwordResetRequested: true },
    ip: params.ip ?? null,
  });

  return { accepted: true };
}

export type ResetTokenState =
  { valid: true; userId: string; email: string; fullName: string } | { valid: false };

export async function checkResetToken(token: string): Promise<ResetTokenState> {
  if (!token || token.length < 20) return { valid: false };

  const [row] = await db
    .select({
      id: passwordResetTokens.id,
      userId: passwordResetTokens.userId,
      email: users.email,
      fullName: users.fullName,
      status: users.status,
    })
    .from(passwordResetTokens)
    .innerJoin(users, eq(users.id, passwordResetTokens.userId))
    .where(
      and(
        eq(passwordResetTokens.tokenHash, sha256(token)),
        isNull(passwordResetTokens.usedAt),
        gt(passwordResetTokens.expiresAt, new Date()),
      ),
    )
    .limit(1);

  if (!row || row.status === 'suspended') return { valid: false };
  return { valid: true, userId: row.userId, email: row.email, fullName: row.fullName };
}

export type ResetOutcome = { ok: true } | { ok: false; reason: 'invalid_token' };

export async function completePasswordReset(params: {
  token: string;
  newPassword: string;
  ip?: string | null;
}): Promise<ResetOutcome> {
  const hash = sha256(params.token);

  // Consume first, and only if it was still unused. The conditional update is
  // the atomic step that makes a token single-use even if two requests arrive
  // together.
  const consumed = await db
    .update(passwordResetTokens)
    .set({ usedAt: new Date() })
    .where(
      and(
        eq(passwordResetTokens.tokenHash, hash),
        isNull(passwordResetTokens.usedAt),
        gt(passwordResetTokens.expiresAt, new Date()),
      ),
    )
    .returning({ userId: passwordResetTokens.userId });

  const row = consumed[0];
  if (!row) return { ok: false, reason: 'invalid_token' };

  // setPassword bumps sessionEpoch, ending every live session for this user.
  await setPassword({ userId: row.userId, password: params.newPassword });

  // Any other outstanding token for this user is now void.
  await db
    .update(passwordResetTokens)
    .set({ usedAt: new Date() })
    .where(and(eq(passwordResetTokens.userId, row.userId), isNull(passwordResetTokens.usedAt)));

  await audit({
    action: AUDIT_ACTIONS.USER_UPDATE,
    actorUserId: row.userId,
    entityType: 'user',
    entityId: row.userId,
    metadata: { passwordReset: true, sessionsRevoked: true },
    ip: params.ip ?? null,
  });

  return { ok: true };
}

/** Housekeeping: drop tokens that can never be used again. */
export async function pruneResetTokens(): Promise<number> {
  const result = await db
    .delete(passwordResetTokens)
    .where(lt(passwordResetTokens.expiresAt, new Date(Date.now() - 7 * 86_400_000)));
  return result.rowCount ?? 0;
}

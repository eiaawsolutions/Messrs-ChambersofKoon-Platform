'use server';

import { cookies, headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { z } from 'zod';
import { signIn } from '@/lib/auth/auth';
import {
  beginTotpEnrolment,
  changePassword,
  completeTotpEnrolment,
  consumeRecoveryCode,
  issueChallenge,
  readChallenge,
  setPassword,
  verifyCredentials,
  verifyTotpForSignIn,
} from '@/lib/auth/credentials';
import { checkPasswordPolicy } from '@/lib/auth/password';
import { requestPasswordReset, completePasswordReset, checkResetToken } from '@/lib/auth/reset';
import { checkRateLimit, clientIp } from '@/lib/intake/protection';
import { audit, AUDIT_ACTIONS } from '@/lib/audit/log';

/**
 * Sign-in server actions (PRD amendment A1).
 *
 * The two factors are checked here, not inside Auth.js. Between them the
 * server holds only a signed, five-minute challenge in an httpOnly cookie —
 * never a session — so a browser that completes step one and stops has no
 * access to anything.
 *
 * All failure messages are deliberately identical and vague. "No such user"
 * and "wrong password" as distinct messages is how an attacker builds a list
 * of real firm addresses.
 */

const CHALLENGE_COOKIE = 'mv_challenge';
const GENERIC_FAILURE = 'That email address and password combination was not recognised.';

async function setChallengeCookie(token: string): Promise<void> {
  const jar = await cookies();
  jar.set(CHALLENGE_COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.APP_ENV === 'production',
    path: '/',
    maxAge: 300,
  });
}

async function readChallengeCookie(): Promise<string | null> {
  const jar = await cookies();
  return jar.get(CHALLENGE_COOKIE)?.value ?? null;
}

async function clearChallengeCookie(): Promise<void> {
  const jar = await cookies();
  jar.delete(CHALLENGE_COOKIE);
}

async function requestMeta() {
  const h = await headers();
  return { ip: clientIp(h), userAgent: h.get('user-agent') };
}

function backToSignIn(params: Record<string, string>): never {
  redirect(`/sign-in?${new URLSearchParams(params).toString()}`);
}

// ---------------------------------------------------------------------------
// Step 1 — email and password
// ---------------------------------------------------------------------------

const passwordSchema = z.object({
  email: z.string().min(3).max(320),
  password: z.string().min(1).max(200),
});

export async function passwordStepAction(formData: FormData): Promise<void> {
  const parsed = passwordSchema.safeParse({
    email: formData.get('email'),
    password: formData.get('password'),
  });
  if (!parsed.success) backToSignIn({ error: GENERIC_FAILURE });

  const meta = await requestMeta();

  // Per-IP throttle on top of the per-account lockout. The lockout stops a
  // guess against one address; this stops a spray across many.
  const limit = await checkRateLimit(`signin:${meta.ip ?? 'unknown'}`, {
    limit: 30,
    windowSeconds: 900,
  });
  if (!limit.allowed) {
    backToSignIn({ error: 'Too many sign-in attempts. Try again in a few minutes.' });
  }

  const outcome = await verifyCredentials({
    email: parsed.data.email,
    password: parsed.data.password,
    ip: meta.ip,
    userAgent: meta.userAgent,
  });

  switch (outcome.status) {
    case 'invalid':
    case 'no_password':
      backToSignIn({ error: GENERIC_FAILURE });
      break;

    case 'locked':
      backToSignIn({
        error:
          'This account is temporarily locked after several failed attempts. ' +
          'Try again shortly, or ask the practice manager to unlock it.',
      });
      break;

    case 'suspended':
      // Same wording as a bad password — a suspended account should not be
      // confirmable from outside.
      backToSignIn({ error: GENERIC_FAILURE });
      break;

    case 'must_change_password':
      await setChallengeCookie(outcome.challenge);
      backToSignIn({ step: 'change-password' });
      break;

    case 'enrol_2fa':
      await setChallengeCookie(outcome.challenge);
      backToSignIn({ step: 'enrol' });
      break;

    case 'verify_2fa':
      await setChallengeCookie(outcome.challenge);
      backToSignIn({ step: 'verify' });
      break;
  }
}

// ---------------------------------------------------------------------------
// Step 2a — first sign-in: enrol the authenticator
// ---------------------------------------------------------------------------

export async function enrolTwoFactorAction(formData: FormData): Promise<void> {
  const token = String(formData.get('token') ?? '');
  const challenge = await readChallengeCookie();
  if (!challenge) backToSignIn({ error: 'That took too long. Please sign in again.' });

  const payload = await readChallenge(challenge, 'enrol_2fa');
  if (!payload) backToSignIn({ error: 'That took too long. Please sign in again.' });

  const result = await completeTotpEnrolment({ userId: payload.userId, token });
  if (!result.ok) {
    backToSignIn({ step: 'enrol', error: 'That code was not correct. Try the current one.' });
  }

  // Recovery codes are shown exactly once, before the session is created.
  const jar = await cookies();
  jar.set('mv_recovery', (result.recoveryCodes ?? []).join(','), {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.APP_ENV === 'production',
    path: '/',
    maxAge: 600,
  });

  await setChallengeCookie(await issueChallenge({ userId: payload.userId, purpose: 'session' }));
  backToSignIn({ step: 'recovery-codes' });
}

// ---------------------------------------------------------------------------
// Step 2b — returning sign-in: verify the code
// ---------------------------------------------------------------------------

export async function verifyTwoFactorAction(formData: FormData): Promise<void> {
  const token = String(formData.get('token') ?? '').trim();
  const recovery = String(formData.get('recoveryCode') ?? '').trim();

  const challenge = await readChallengeCookie();
  if (!challenge) backToSignIn({ error: 'That took too long. Please sign in again.' });

  const payload = await readChallenge(challenge, 'verify_2fa');
  if (!payload) backToSignIn({ error: 'That took too long. Please sign in again.' });

  const meta = await requestMeta();

  // Throttle the second factor too — six digits is 10^6, which is guessable at
  // speed if nothing stands in the way.
  const limit = await checkRateLimit(`2fa:${payload.userId}`, { limit: 10, windowSeconds: 900 });
  if (!limit.allowed) {
    await clearChallengeCookie();
    backToSignIn({ error: 'Too many codes tried. Please sign in again in a few minutes.' });
  }

  const ok = recovery
    ? await consumeRecoveryCode({ userId: payload.userId, code: recovery })
    : (await verifyTotpForSignIn({ userId: payload.userId, token })).ok;

  if (!ok) {
    await audit({
      action: AUDIT_ACTIONS.LOGIN_FAILURE,
      actorUserId: payload.userId,
      metadata: { reason: recovery ? 'bad_recovery_code' : 'bad_totp' },
      ip: meta.ip,
      userAgent: meta.userAgent,
    });
    backToSignIn({
      step: 'verify',
      error: recovery
        ? 'That recovery code was not recognised, or has already been used.'
        : 'That code was not correct. Check the current code in your app.',
    });
  }

  await finishSignIn(payload.userId);
}

// ---------------------------------------------------------------------------
// Step 2c — forced password change on a temporary password
// ---------------------------------------------------------------------------

export async function forcedPasswordChangeAction(formData: FormData): Promise<void> {
  const password = String(formData.get('password') ?? '');
  const confirm = String(formData.get('confirm') ?? '');

  const challenge = await readChallengeCookie();
  if (!challenge) backToSignIn({ error: 'That took too long. Please sign in again.' });

  const payload = await readChallenge(challenge, 'change_password');
  if (!payload) backToSignIn({ error: 'That took too long. Please sign in again.' });

  if (password !== confirm) {
    backToSignIn({ step: 'change-password', error: 'The two passwords did not match.' });
  }

  const policy = checkPasswordPolicy(password);
  if (!policy.ok) {
    backToSignIn({ step: 'change-password', error: policy.problems.join(' ') });
  }

  await setPassword({ userId: payload.userId, password });

  // Straight into second-factor setup, or verification if already enrolled.
  await setChallengeCookie(await issueChallenge({ userId: payload.userId, purpose: 'enrol_2fa' }));
  backToSignIn({ step: 'enrol' });
}

// ---------------------------------------------------------------------------
// Completion
// ---------------------------------------------------------------------------

/** Both factors satisfied: mint a session challenge and hand it to Auth.js. */
async function finishSignIn(userId: string): Promise<never> {
  const sessionChallenge = await issueChallenge({ userId, purpose: 'session' });
  await clearChallengeCookie();
  await signIn('credentials', { challenge: sessionChallenge, redirectTo: '/dashboard' });
  redirect('/dashboard');
}

/** Called from the recovery-codes screen once the user confirms they are saved. */
export async function completeAfterRecoveryCodesAction(): Promise<void> {
  const challenge = await readChallengeCookie();
  if (!challenge) backToSignIn({ error: 'That took too long. Please sign in again.' });

  const payload = await readChallenge(challenge, 'session');
  if (!payload) backToSignIn({ error: 'That took too long. Please sign in again.' });

  const jar = await cookies();
  jar.delete('mv_recovery');
  await finishSignIn(payload.userId);
}

// ---------------------------------------------------------------------------
// Forgot / reset password
// ---------------------------------------------------------------------------

export async function requestResetAction(formData: FormData): Promise<void> {
  const email = String(formData.get('email') ?? '');
  const meta = await requestMeta();

  await checkRateLimit(`reset:${meta.ip ?? 'unknown'}`, { limit: 5, windowSeconds: 900 });
  await requestPasswordReset({ email, ip: meta.ip });

  // Always the same outcome, whether or not the address exists.
  redirect('/forgot-password?sent=1');
}

export async function completeResetAction(formData: FormData): Promise<void> {
  const token = String(formData.get('token') ?? '');
  const password = String(formData.get('password') ?? '');
  const confirm = String(formData.get('confirm') ?? '');

  const state = await checkResetToken(token);
  if (!state.valid) {
    redirect('/reset-password?error=expired');
  }

  if (password !== confirm) {
    redirect(`/reset-password?token=${token}&error=mismatch`);
  }

  const policy = checkPasswordPolicy(password, { email: state.email, fullName: state.fullName });
  if (!policy.ok) {
    redirect(
      `/reset-password?token=${token}&error=${encodeURIComponent(policy.problems.join(' '))}`,
    );
  }

  const meta = await requestMeta();
  const result = await completePasswordReset({ token, newPassword: password, ip: meta.ip });
  if (!result.ok) {
    redirect('/reset-password?error=expired');
  }

  redirect('/sign-in?reset=1');
}

/** Data for the enrolment screen. */
export async function getEnrolmentOffer() {
  const challenge = await readChallengeCookie();
  if (!challenge) return null;
  const payload = await readChallenge(challenge, 'enrol_2fa');
  if (!payload) return null;
  return beginTotpEnrolment(payload.userId);
}

/** Recovery codes held for the one screen that displays them. */
export async function getRecoveryCodesOnce(): Promise<string[]> {
  const jar = await cookies();
  const raw = jar.get('mv_recovery')?.value;
  return raw ? raw.split(',').filter(Boolean) : [];
}

/**
 * Change your own password. Errors come back through the URL rather than a
 * return value, because a form `action` must resolve to void.
 */
export async function changeOwnPasswordAction(formData: FormData): Promise<void> {
  const { requireActor } = await import('@/lib/auth/session');
  const actor = await requireActor();

  const current = String(formData.get('currentPassword') ?? '');
  const next = String(formData.get('newPassword') ?? '');
  const confirm = String(formData.get('confirm') ?? '');

  const fail = (message: string): never =>
    redirect(`/account?error=${encodeURIComponent(message)}`);

  if (next !== confirm) fail('The two passwords did not match.');

  const policy = checkPasswordPolicy(next, { email: actor.email, fullName: actor.fullName });
  if (!policy.ok) fail(policy.problems.join(' '));

  const ok = await changePassword({
    userId: actor.id,
    currentPassword: current,
    newPassword: next,
  });
  if (!ok) fail('Your current password was not correct.');

  // setPassword bumped the session epoch, so the current session is already dead.
  redirect('/sign-in?changed=1');
}

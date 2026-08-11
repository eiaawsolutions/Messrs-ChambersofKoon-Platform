import type { Metadata } from 'next';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import QRCode from 'qrcode';
import { config } from '@/lib/config/env';
import { getActor } from '@/lib/auth/session';
import { formatSecretForManualEntry } from '@/lib/auth/totp';
import {
  completeAfterRecoveryCodesAction,
  enrolTwoFactorAction,
  forcedPasswordChangeAction,
  getEnrolmentOffer,
  getRecoveryCodesOnce,
  passwordStepAction,
  verifyTwoFactorAction,
} from './actions';

export const metadata: Metadata = { title: 'Sign in' };
export const dynamic = 'force-dynamic';

type Step = 'password' | 'change-password' | 'enrol' | 'verify' | 'recovery-codes';

function Shell({ children, subtitle }: { children: React.ReactNode; subtitle?: string }) {
  const cfg = config();
  return (
    <main
      id="main"
      className="grain relative flex min-h-screen items-center justify-center px-5 py-10"
    >
      <div className="w-full max-w-md">
        <div className="mb-8">
          <p className="text-brass-500 mb-3 font-mono text-xs tracking-[0.2em] uppercase">
            Matter Velocity
          </p>
          <h1 className="font-display text-ink text-3xl leading-tight">{cfg.FIRM_NAME}</h1>
          <div className="bg-brass-500 mt-4 h-px w-10" />
          {subtitle ? <p className="text-ink-muted mt-4 text-sm">{subtitle}</p> : null}
        </div>
        {children}
      </div>
    </main>
  );
}

function ErrorBanner({ message }: { message: string }) {
  return (
    <div
      role="alert"
      className="border-clay-500 bg-clay-100 text-clay-700 mb-5 rounded-sm border-l-2 p-3 text-sm"
    >
      {message}
    </div>
  );
}

export default async function SignInPage({
  searchParams,
}: {
  searchParams: Promise<{ step?: string; error?: string; reset?: string; changed?: string }>;
}) {
  const actor = await getActor();
  if (actor) redirect('/dashboard');

  const params = await searchParams;
  const step = (params.step ?? 'password') as Step;
  const error = params.error;

  // --- First sign-in: enrol an authenticator -------------------------------
  if (step === 'enrol') {
    const offer = await getEnrolmentOffer();
    if (!offer) redirect('/sign-in?error=Please+sign+in+again.');

    const qrSvg = await QRCode.toString(offer.otpauthUri, {
      type: 'svg',
      margin: 1,
      width: 200,
      color: { dark: '#131a24', light: '#ffffff' },
    });

    return (
      <Shell subtitle="One more step before you can use the platform.">
        <div className="surface-raised p-6">
          <h2 className="text-ink text-base font-semibold">Set up two-step verification</h2>
          <p className="text-ink-muted mt-2 text-sm">
            This account holds client matter data, so a password alone is not enough. Scan this with
            Google Authenticator, Microsoft Authenticator, 1Password or any authenticator app, then
            enter the six-digit code it shows.
          </p>

          {error ? (
            <div className="mt-4">
              <ErrorBanner message={error} />
            </div>
          ) : null}

          <div className="mt-5 flex justify-center">
            {/* Rendered server-side and inlined — no external request, so the
                strict CSP needs no exception for this. */}
            <div
              className="rounded-sm border border-[color:var(--color-line)] bg-white p-3"
              // The SVG is produced by the QR encoder from a URI this server
              // built; no user input reaches it.
              dangerouslySetInnerHTML={{ __html: qrSvg }}
            />
          </div>

          <details className="mt-4">
            <summary className="text-navy-600 cursor-pointer text-sm">
              Cannot scan? Enter the key by hand
            </summary>
            <p className="bg-paper-sunken mt-2 rounded-sm p-3 font-mono text-sm break-all">
              {formatSecretForManualEntry(offer.secret)}
            </p>
            <p className="text-ink-faint mt-2 text-xs">
              Account: {offer.accountName} · time-based · 6 digits · 30 seconds
            </p>
          </details>

          <form action={enrolTwoFactorAction} className="mt-6 space-y-4">
            <div>
              <label className="label" htmlFor="token">
                Six-digit code
              </label>
              <input
                className="field text-center font-mono text-lg tracking-[0.4em]"
                id="token"
                name="token"
                inputMode="numeric"
                autoComplete="one-time-code"
                pattern="[0-9 ]*"
                maxLength={7}
                required
                autoFocus
                placeholder="000000"
              />
            </div>
            <button className="btn btn-primary w-full" type="submit">
              Confirm and continue
            </button>
          </form>
        </div>
      </Shell>
    );
  }

  // --- Recovery codes, shown exactly once ----------------------------------
  if (step === 'recovery-codes') {
    const codes = await getRecoveryCodesOnce();
    if (codes.length === 0) redirect('/sign-in?error=Please+sign+in+again.');

    return (
      <Shell subtitle="Two-step verification is on.">
        <div className="surface-raised p-6">
          <h2 className="text-ink text-base font-semibold">Save your recovery codes</h2>
          <p className="text-ink-muted mt-2 text-sm">
            If you lose your phone, these are the only way back into your account without an
            administrator. Each one works once. Print them or put them in your password manager —{' '}
            <strong>they will not be shown again.</strong>
          </p>

          <ul className="bg-paper-sunken mt-5 grid grid-cols-2 gap-2 rounded-sm p-4 font-mono text-sm">
            {codes.map((code) => (
              <li key={code} data-numeric>
                {code}
              </li>
            ))}
          </ul>

          <form action={completeAfterRecoveryCodesAction} className="mt-6">
            <label className="text-ink-muted mb-4 flex items-start gap-2 text-sm">
              <input type="checkbox" required className="mt-1" />
              <span>I have saved these codes somewhere I can reach without my phone.</span>
            </label>
            <button className="btn btn-primary w-full" type="submit">
              Continue to the platform
            </button>
          </form>
        </div>
      </Shell>
    );
  }

  // --- Returning sign-in: second factor ------------------------------------
  if (step === 'verify') {
    return (
      <Shell subtitle="Second step.">
        <div className="surface-raised p-6">
          <h2 className="text-ink text-base font-semibold">Enter your code</h2>
          <p className="text-ink-muted mt-2 text-sm">
            Open your authenticator app and enter the current six-digit code.
          </p>

          {error ? (
            <div className="mt-4">
              <ErrorBanner message={error} />
            </div>
          ) : null}

          <form action={verifyTwoFactorAction} className="mt-5 space-y-4">
            <div>
              <label className="label" htmlFor="token">
                Six-digit code
              </label>
              <input
                className="field text-center font-mono text-lg tracking-[0.4em]"
                id="token"
                name="token"
                inputMode="numeric"
                autoComplete="one-time-code"
                maxLength={7}
                autoFocus
                placeholder="000000"
              />
            </div>
            <button className="btn btn-primary w-full" type="submit">
              Sign in
            </button>

            <details>
              <summary className="text-navy-600 cursor-pointer text-sm">
                Lost your phone? Use a recovery code
              </summary>
              <div className="mt-3">
                <label className="label" htmlFor="recoveryCode">
                  Recovery code
                </label>
                <input
                  className="field font-mono"
                  id="recoveryCode"
                  name="recoveryCode"
                  placeholder="XXXXX-XXXXX"
                  autoComplete="off"
                />
                <p className="text-ink-faint mt-2 text-xs">
                  Each code works once. If you have none left, ask the practice manager to reset
                  your two-step verification.
                </p>
              </div>
            </details>
          </form>
        </div>
      </Shell>
    );
  }

  // --- Forced change on a temporary password -------------------------------
  if (step === 'change-password') {
    return (
      <Shell subtitle="Choose your own password before continuing.">
        <div className="surface-raised p-6">
          <h2 className="text-ink text-base font-semibold">Set a new password</h2>
          <p className="text-ink-muted mt-2 text-sm">
            You signed in with a temporary password. Choose one only you know — at least 12
            characters, and not something connected to you or the firm.
          </p>

          {error ? (
            <div className="mt-4">
              <ErrorBanner message={error} />
            </div>
          ) : null}

          <form action={forcedPasswordChangeAction} className="mt-5 space-y-4">
            <div>
              <label className="label" htmlFor="password">
                New password
              </label>
              <input
                className="field"
                id="password"
                name="password"
                type="password"
                required
                minLength={12}
                autoComplete="new-password"
                autoFocus
              />
            </div>
            <div>
              <label className="label" htmlFor="confirm">
                Confirm
              </label>
              <input
                className="field"
                id="confirm"
                name="confirm"
                type="password"
                required
                minLength={12}
                autoComplete="new-password"
              />
            </div>
            <button className="btn btn-primary w-full" type="submit">
              Save and continue
            </button>
          </form>
        </div>
      </Shell>
    );
  }

  // --- Step 1 --------------------------------------------------------------
  return (
    <Shell>
      <div className="surface-raised p-6">
        <h2 className="text-ink text-base font-semibold">Sign in</h2>
        <p className="text-ink-muted mt-2 text-sm">
          Use the account the firm issued you. Access is limited to members of the firm.
        </p>

        {params.reset ? (
          <div
            role="status"
            className="border-sage-500 bg-sage-100 text-sage-700 mt-5 rounded-sm border-l-2 p-3 text-sm"
          >
            Your password has been changed. Sign in with it now.
          </div>
        ) : null}

        {params.changed ? (
          <div
            role="status"
            className="border-sage-500 bg-sage-100 text-sage-700 mt-5 rounded-sm border-l-2 p-3 text-sm"
          >
            Password updated. Please sign in again.
          </div>
        ) : null}

        {error ? (
          <div className="mt-5">
            <ErrorBanner message={error} />
          </div>
        ) : null}

        <form action={passwordStepAction} className="mt-6 space-y-4">
          <div>
            <label className="label" htmlFor="email">
              Email address
            </label>
            <input
              className="field"
              id="email"
              name="email"
              type="email"
              required
              autoComplete="username"
              autoFocus
            />
          </div>
          <div>
            <label className="label" htmlFor="password">
              Password
            </label>
            <input
              className="field"
              id="password"
              name="password"
              type="password"
              required
              autoComplete="current-password"
            />
          </div>
          <button className="btn btn-primary w-full" type="submit">
            Continue
          </button>
        </form>

        <p className="mt-5 text-sm">
          <Link href="/forgot-password" className="text-navy-600 underline">
            Forgotten your password?
          </Link>
        </p>
      </div>

      <p className="text-ink-faint mt-6 text-xs">
        Every sign-in, matter opened and document generated is recorded in an audit log that cannot
        be edited or deleted.
      </p>
    </Shell>
  );
}

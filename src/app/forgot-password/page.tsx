import type { Metadata } from 'next';
import Link from 'next/link';
import { config } from '@/lib/config/env';
import { requestResetAction } from '../sign-in/actions';

export const metadata: Metadata = { title: 'Forgotten password' };
export const dynamic = 'force-dynamic';

/**
 * Forgotten password (PRD amendment A1).
 *
 * The confirmation is identical whether or not the address exists. Telling a
 * stranger "no account with that email" is how they build a list of who works
 * at the firm.
 */
export default async function ForgotPasswordPage({
  searchParams,
}: {
  searchParams: Promise<{ sent?: string }>;
}) {
  const { sent } = await searchParams;
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
        </div>

        <div className="surface-raised p-6">
          {sent ? (
            <>
              <h2 className="text-ink text-base font-semibold">Check your email</h2>
              <p className="text-ink-muted mt-3 text-sm">
                If there is an account for that address, a reset link is on its way. It is valid for
                45 minutes and can be used once.
              </p>
              <p className="text-ink-muted mt-3 text-sm">
                You will still need your authenticator app to sign in — resetting a password does
                not change the second step.
              </p>
              <p className="text-ink-faint mt-4 text-xs">
                Nothing arrived? Check the spam folder, then ask the practice manager to confirm the
                address on your account.
              </p>
              <Link href="/sign-in" className="btn btn-secondary mt-6 w-full">
                Back to sign in
              </Link>
            </>
          ) : (
            <>
              <h2 className="text-ink text-base font-semibold">Forgotten your password</h2>
              <p className="text-ink-muted mt-2 text-sm">
                Enter the email address on your account and we will send a link to set a new
                password.
              </p>

              <form action={requestResetAction} className="mt-6 space-y-4">
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
                <button className="btn btn-primary w-full" type="submit">
                  Send the reset link
                </button>
              </form>

              <p className="mt-5 text-sm">
                <Link href="/sign-in" className="text-navy-600 underline">
                  Back to sign in
                </Link>
              </p>
            </>
          )}
        </div>
      </div>
    </main>
  );
}

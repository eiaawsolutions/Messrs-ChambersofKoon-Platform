import type { Metadata } from 'next';
import Link from 'next/link';
import { config } from '@/lib/config/env';
import { checkResetToken } from '@/lib/auth/reset';
import { completeResetAction } from '../sign-in/actions';

export const metadata: Metadata = { title: 'Set a new password' };
export const dynamic = 'force-dynamic';

export default async function ResetPasswordPage({
  searchParams,
}: {
  searchParams: Promise<{ token?: string; error?: string }>;
}) {
  const params = await searchParams;
  const cfg = config();
  const state = params.token ? await checkResetToken(params.token) : { valid: false as const };

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
          {!state.valid ? (
            <>
              <h2 className="text-ink text-base font-semibold">That link is no longer valid</h2>
              <p className="text-ink-muted mt-3 text-sm">
                Reset links last 45 minutes and can be used once. Requesting a newer link also
                cancels any older one.
              </p>
              <Link href="/forgot-password" className="btn btn-primary mt-6 w-full">
                Request a new link
              </Link>
            </>
          ) : (
            <>
              <h2 className="text-ink text-base font-semibold">Set a new password</h2>
              <p className="text-ink-muted mt-2 text-sm">
                For {state.email}. Use at least 12 characters, and nothing connected to you or the
                firm.
              </p>

              {params.error ? (
                <div
                  role="alert"
                  className="border-clay-500 bg-clay-100 text-clay-700 mt-5 rounded-sm border-l-2 p-3 text-sm"
                >
                  {params.error === 'mismatch'
                    ? 'The two passwords did not match.'
                    : params.error === 'expired'
                      ? 'That link has expired. Request a new one.'
                      : params.error}
                </div>
              ) : null}

              <form action={completeResetAction} className="mt-6 space-y-4">
                <input type="hidden" name="token" value={params.token ?? ''} />
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
                  Save new password
                </button>
              </form>

              <p className="text-ink-faint mt-4 text-xs">
                Changing your password signs you out everywhere. You will still need your
                authenticator app to sign back in.
              </p>
            </>
          )}
        </div>
      </div>
    </main>
  );
}

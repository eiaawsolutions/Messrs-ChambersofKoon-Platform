import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { config, optionalSecret } from '@/lib/config/env';
import { getActor } from '@/lib/auth/session';
import { signIn } from '@/lib/auth/auth';

export const metadata: Metadata = { title: 'Sign in' };
export const dynamic = 'force-dynamic';

/**
 * Sign-in (FR-1.1).
 *
 * There is no password field, because there is no password store. Both buttons
 * hand off to the firm's identity provider, which is also where 2-step
 * verification is enforced (FR-1.2).
 *
 * The error copy is deliberately identical for "wrong domain", "suspended" and
 * "not invited" — telling an outsider which of those applies confirms whether
 * an address belongs to the firm (penetration-testing.md, user enumeration).
 */
export default async function SignInPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; callbackUrl?: string }>;
}) {
  const actor = await getActor();
  if (actor) redirect('/dashboard');

  const { error } = await searchParams;
  const cfg = config();

  const [googleId, microsoftId] = await Promise.all([
    optionalSecret('AUTH_GOOGLE_ID'),
    optionalSecret('AUTH_MICROSOFT_ID'),
  ]);
  const hasGoogle = Boolean(googleId);
  const hasMicrosoft = Boolean(microsoftId);
  const configured = hasGoogle || hasMicrosoft;

  return (
    <main id="main" className="grain relative flex min-h-screen items-center justify-center px-5">
      <div className="w-full max-w-sm">
        <div className="mb-8">
          <p className="text-brass-500 mb-3 font-mono text-xs tracking-[0.2em] uppercase">
            Matter Velocity
          </p>
          <h1 className="font-display text-ink text-3xl leading-tight">{cfg.FIRM_NAME}</h1>
          <div className="bg-brass-500 mt-4 h-px w-10" />
        </div>

        <div className="surface-raised p-6">
          <h2 className="text-ink text-base font-semibold">Sign in</h2>
          <p className="text-ink-muted mt-2 text-sm">
            Use your firm account. Access is limited to members of the firm.
          </p>

          {error ? (
            <div
              role="alert"
              className="border-clay-500 bg-clay-100 text-clay-700 mt-5 rounded-sm border-l-2 p-3 text-sm"
            >
              We could not sign you in. If you believe you should have access, ask the practice
              manager to check your account.
            </div>
          ) : null}

          <div className="mt-6 space-y-3">
            {hasGoogle ? (
              <form
                action={async () => {
                  'use server';
                  try {
                    await signIn('google', { redirectTo: '/dashboard' });
                  } catch (error) {
                    // next-auth signals a successful redirect by throwing; only
                    // a genuine configuration failure should surface.
                    if ((error as { digest?: string }).digest?.startsWith('NEXT_REDIRECT'))
                      throw error;
                    redirect('/sign-in?error=configuration');
                  }
                }}
              >
                <button className="btn btn-secondary w-full" type="submit">
                  Continue with Google Workspace
                </button>
              </form>
            ) : null}

            {hasMicrosoft ? (
              <form
                action={async () => {
                  'use server';
                  try {
                    await signIn('microsoft-entra-id', { redirectTo: '/dashboard' });
                  } catch (error) {
                    if ((error as { digest?: string }).digest?.startsWith('NEXT_REDIRECT'))
                      throw error;
                    redirect('/sign-in?error=configuration');
                  }
                }}
              >
                <button className="btn btn-secondary w-full" type="submit">
                  Continue with Microsoft 365
                </button>
              </form>
            ) : null}

            {!configured ? (
              <div className="bg-paper-sunken text-ink-muted rounded-sm p-4 text-sm">
                <p className="text-ink font-medium">Identity provider not configured</p>
                <p className="mt-2">
                  Set the Google or Microsoft credentials in Infisical and enable the resolver.
                  Until then no one can sign in — which is the correct closed state.
                </p>
              </div>
            ) : null}
          </div>
        </div>

        <p className="text-ink-faint mt-6 text-xs">
          Every sign-in, matter opened and document generated is recorded in an audit log that
          cannot be edited or deleted.
        </p>
      </div>
    </main>
  );
}

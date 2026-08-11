import type { Metadata } from 'next';
import { requireActor } from '@/lib/auth/session';
import { remainingRecoveryCodes } from '@/lib/auth/credentials';
import { changeOwnPasswordAction } from '@/app/sign-in/actions';
import { regenerateRecoveryCodesAction } from './actions';

export const metadata: Metadata = { title: 'Your account' };
export const dynamic = 'force-dynamic';

/**
 * Account settings.
 *
 * Deliberately narrow: change your own password, and see how many recovery
 * codes you have left. Disabling the second factor is not offered — this
 * account can open client matter files, and a self-service "turn off 2FA"
 * button is the first thing an attacker with a stolen session would look for.
 * Clearing it is an administrator action, and it is audited.
 */
export default async function AccountPage({
  searchParams,
}: {
  searchParams: Promise<{ codes?: string; error?: string }>;
}) {
  const actor = await requireActor();
  const params = await searchParams;
  const remaining = await remainingRecoveryCodes(actor.id);
  const newCodes = params.codes ? params.codes.split(',').filter(Boolean) : [];

  return (
    <div className="max-w-2xl space-y-10">
      <header>
        <h1 className="rule-brass text-3xl">Your account</h1>
        <p className="text-ink-muted mt-4 text-sm">
          {actor.fullName} · {actor.email} · {actor.roleName} · {actor.office}
        </p>
      </header>

      {newCodes.length > 0 ? (
        <section
          aria-labelledby="new-codes"
          className="border-l-brass-500 bg-brass-100 rounded-sm border-l-2 p-5"
        >
          <h2 id="new-codes" className="text-brass-700 text-base font-semibold">
            Your new recovery codes
          </h2>
          <p className="text-brass-700 mt-2 text-sm">
            The previous set no longer works. Save these — they will not be shown again.
          </p>
          <ul className="mt-4 grid grid-cols-2 gap-2 rounded-sm bg-white p-4 font-mono text-sm">
            {newCodes.map((code) => (
              <li key={code} data-numeric>
                {code}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <section aria-labelledby="password" className="surface-raised p-6">
        <h2 id="password" className="text-base font-semibold">
          Change your password
        </h2>
        <p className="text-ink-muted mt-2 text-sm">
          At least 12 characters, and nothing connected to you or the firm. Changing it signs you
          out on every device, including this one.
        </p>

        {params.error ? (
          <div
            role="alert"
            className="border-clay-500 bg-clay-100 text-clay-700 mt-4 rounded-sm border-l-2 p-3 text-sm"
          >
            {params.error}
          </div>
        ) : null}

        <form action={changeOwnPasswordAction} className="mt-5 space-y-4">
          <div>
            <label className="label" htmlFor="currentPassword">
              Current password
            </label>
            <input
              className="field"
              id="currentPassword"
              name="currentPassword"
              type="password"
              required
              autoComplete="current-password"
            />
          </div>
          <div>
            <label className="label" htmlFor="newPassword">
              New password
            </label>
            <input
              className="field"
              id="newPassword"
              name="newPassword"
              type="password"
              required
              minLength={12}
              autoComplete="new-password"
            />
          </div>
          <div>
            <label className="label" htmlFor="confirm">
              Confirm new password
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
          <button className="btn btn-primary" type="submit">
            Change password
          </button>
        </form>
      </section>

      <section aria-labelledby="two-factor" className="surface-raised p-6">
        <h2 id="two-factor" className="text-base font-semibold">
          Two-step verification
        </h2>
        <p className="text-ink-muted mt-2 text-sm">
          Your authenticator app is set up and required at every sign-in.
        </p>

        <p className="mt-4 text-sm">
          Recovery codes remaining:{' '}
          <span
            className={`pill ${remaining === 0 ? 'pill-danger' : remaining <= 3 ? 'pill-warning' : 'pill-success'}`}
            data-numeric
          >
            {remaining} of 10
          </span>
        </p>

        {remaining <= 3 ? (
          <p className="text-ink-muted mt-3 text-sm">
            {remaining === 0
              ? 'You have none left. If you lose your phone now, an administrator will have to reset your second step.'
              : 'Running low. Generate a fresh set while you still have access.'}
          </p>
        ) : null}

        <form action={regenerateRecoveryCodesAction} className="mt-4">
          <button className="btn btn-secondary" type="submit">
            Generate new recovery codes
          </button>
          <p className="text-ink-faint mt-2 text-xs">This invalidates any codes you still hold.</p>
        </form>

        <p className="text-ink-faint mt-5 text-xs">
          Lost your phone and out of codes? Ask the practice manager to reset your two-step
          verification. They will confirm who you are first, and the reset is recorded in the audit
          log.
        </p>
      </section>
    </div>
  );
}

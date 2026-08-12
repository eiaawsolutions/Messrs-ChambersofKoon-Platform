import type { Metadata } from 'next';
import { config } from '@/lib/config/env';
import { lookupRescheduleLink } from '@/lib/scheduling/client-reschedule';
import { resolveLocale, t } from '@/lib/i18n/catalogue';
import { requestRescheduleAction } from './actions';

export const metadata: Metadata = {
  title: 'Move your consultation',
  // A token in the path is a credential. It must never reach an index, a
  // referrer log or a link preview.
  robots: { index: false, follow: false, nocache: true },
};
export const dynamic = 'force-dynamic';

/**
 * Client reschedule link (FR-3.8).
 *
 * "Token-based client reschedule link (no login) that creates a new proposal
 *  for lawyer approval."
 *
 * The last five words are the design. This page never books anything. It takes
 * the client's preference and puts it in the same approval queue an overnight
 * enquiry lands in, and it says so on screen — a client who believes they have
 * moved a confirmed appointment, and then finds they have not, is worse off
 * than one who was never offered the link.
 */

/** One message per outcome. The page owns this text; nothing is reflected. */
const NOTICES: Record<string, { tone: 'ok' | 'warn'; heading: string; body: string }> = {
  requested: {
    tone: 'ok',
    heading: 'Your request is with the firm',
    body: 'We have passed your preferred time to your lawyer. Your existing appointment stands until they confirm the change, and you will receive an updated calendar invitation by email once they do.',
  },
  slot_taken: {
    tone: 'warn',
    heading: 'That time has just gone',
    body: 'Someone else took it while this page was open. The times below are current — please choose again.',
  },
  rate_limited: {
    tone: 'warn',
    heading: 'Too many attempts',
    body: 'Please wait a little while and try again, or telephone the office.',
  },
  no_enquiry: {
    tone: 'warn',
    heading: 'This one needs a phone call',
    body: 'We cannot move this appointment automatically. Please telephone the office and we will arrange it directly.',
  },
};

const BLOCKED: Record<string, { heading: string; body: string }> = {
  unknown: {
    heading: 'This link is no longer valid',
    body: 'It may have expired or been replaced by a newer one. Please check the most recent email from the firm, or telephone the office.',
  },
  cancelled: {
    heading: 'This consultation was cancelled',
    body: 'There is nothing here to move. If you would still like to see a lawyer, please telephone the office or make a new enquiry.',
  },
  passed: {
    heading: 'It is too close to the appointment',
    body: 'This consultation is very soon, or has already taken place. A request made now might not be read in time, so please telephone the office instead.',
  },
  pending_request: {
    heading: 'You have already asked',
    body: 'A request to move this consultation is already with your lawyer. Your existing appointment stands until they confirm the change. Please telephone the office if it is urgent.',
  },
};

export default async function ReschedulePage({
  params,
  searchParams,
}: {
  params: Promise<{ token: string }>;
  searchParams: Promise<{ status?: string; lang?: string }>;
}) {
  const { token } = await params;
  const { status, lang } = await searchParams;
  const cfg = config();
  const locale = resolveLocale(lang);

  const notice = status ? NOTICES[status] : undefined;
  const lookup = await lookupRescheduleLink(token);

  return (
    <main id="main" className="grain relative min-h-screen px-5 py-12">
      <div className="mx-auto w-full max-w-xl">
        <p className="text-ink-muted mb-2 font-mono text-xs tracking-widest uppercase">
          {cfg.FIRM_NAME}
        </p>
        <h1 className="rule-brass text-3xl">{t('reschedule.title', locale)}</h1>

        {notice ? (
          <p
            className={
              notice.tone === 'ok'
                ? 'border-brass-500 bg-brass-100 text-brass-700 mt-6 rounded-sm border-l-2 p-4 text-sm'
                : 'mt-6 rounded-sm border-l-2 border-l-amber-500 bg-amber-100 p-4 text-sm text-amber-700'
            }
            role="status"
          >
            <strong className="block">{notice.heading}</strong>
            <span className="mt-1 block">{notice.body}</span>
          </p>
        ) : null}

        {!lookup.openable ? (
          <div className="surface-raised mt-8 p-6">
            <h2 className="font-display text-lg">{BLOCKED[lookup.code]!.heading}</h2>
            <p className="text-ink-muted mt-3 text-sm">{BLOCKED[lookup.code]!.body}</p>
          </div>
        ) : (
          <>
            <div className="surface mt-8 p-5">
              <p className="text-ink-faint font-mono text-xs tracking-widest uppercase">
                {t('reschedule.current', locale)}
              </p>
              <p className="text-ink mt-2 text-sm font-medium">{lookup.view.currentWhen}</p>
              <p className="text-ink-muted mt-1 text-sm">
                {lookup.view.location} · with {lookup.view.lawyerName}
              </p>
            </div>

            {lookup.view.options.length === 0 ? (
              <div className="surface-raised mt-6 p-6">
                <h2 className="font-display text-lg">Nothing else is free just now</h2>
                <p className="text-ink-muted mt-3 text-sm">
                  {lookup.view.lawyerName} has no other openings in the next few weeks. Please
                  telephone the office and we will find a time with you directly. Your existing
                  appointment is unaffected.
                </p>
              </div>
            ) : (
              <form action={requestRescheduleAction} className="surface-raised mt-6 p-6">
                <input type="hidden" name="token" value={token} />

                <fieldset>
                  <legend className="label">{t('reschedule.choose', locale)}</legend>
                  <p className="text-ink-muted mt-1 mb-4 text-sm">
                    These are {lookup.view.lawyerName}&rsquo;s next available consultations.
                  </p>

                  <ul className="space-y-2">
                    {lookup.view.options.map((option, index) => (
                      <li key={option.startsAtIso}>
                        <label className="border-line hover:border-brass-500 flex cursor-pointer items-center gap-3 rounded-sm border p-3 text-sm">
                          <input
                            type="radio"
                            name="startsAt"
                            value={option.startsAtIso}
                            defaultChecked={index === 0}
                            required
                          />
                          <span className="text-ink">{option.label}</span>
                        </label>
                      </li>
                    ))}
                  </ul>
                </fieldset>

                <p className="text-ink-muted mt-5 text-sm">
                  Choosing a time sends a request to {lookup.view.lawyerName}. It is not confirmed
                  until they accept, and{' '}
                  <strong className="text-ink">your existing appointment stands</strong> until then.
                  You will receive an updated calendar invitation by email if the change is
                  approved.
                </p>

                <button className="btn btn-primary mt-5" type="submit">
                  {t('reschedule.submit', locale)}
                </button>
              </form>
            )}
          </>
        )}

        <p className="text-ink-faint mt-8 text-xs">{t('reschedule.urgent', locale)}</p>
      </div>
    </main>
  );
}

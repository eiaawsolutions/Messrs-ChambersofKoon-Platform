import type { Metadata } from 'next';
import { requireActor } from '@/lib/auth/session';
import { assertCan } from '@/lib/auth/guard';
import { PERMISSIONS } from '@/lib/auth/permissions';
import { searchClients } from '@/lib/privacy/subject-request';
import { RETENTION, retentionDue } from '@/lib/privacy/retention';
import { eraseClientAction } from './actions';

export const metadata: Metadata = { title: 'Data requests' };
export const dynamic = 'force-dynamic';

/**
 * Data subject requests (NFR-2.3) and the retention position (NFR-2.2).
 *
 * The PRD asks for "a documented procedure". This screen is that procedure,
 * placed where the work is done rather than in a file nobody opens when a
 * request actually arrives: what will be exported, what erasure destroys, what
 * survives it and why.
 */

const OUTCOMES: Record<string, { tone: 'ok' | 'warn'; text: string }> = {
  done: {
    tone: 'ok',
    text: 'Erased. The client record is now a tombstone; the audit log is unchanged and records who did this.',
  },
  not_found: { tone: 'warn', text: 'No such client. Nothing was changed.' },
  name_mismatch: {
    tone: 'warn',
    text: 'The confirmation did not match the client name. Nothing was changed.',
  },
};

export default async function PrivacyPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; client?: string; erase?: string }>;
}) {
  const actor = await requireActor();
  assertCan(actor, PERMISSIONS.PRIVACY_MANAGE);

  const params = await searchParams;
  const term = params.q?.trim() ?? '';
  const outcome = params.erase ? OUTCOMES[params.erase] : undefined;

  const [results, due] = await Promise.all([searchClients(term), retentionDue()]);

  return (
    <div className="space-y-10">
      <section>
        <h2 className="text-xl">Data subject requests</h2>
        <p className="text-ink-muted mt-3 max-w-2xl text-sm">
          A client may ask for a copy of what the firm holds about them, or ask for it to be erased.
          Both are answered here, and both are recorded in the audit log.
        </p>
      </section>

      {outcome ? (
        <p
          role="status"
          className={
            outcome.tone === 'ok'
              ? 'rounded-sm border-l-2 border-l-green-500 bg-green-100 p-4 text-sm text-green-700'
              : 'rounded-sm border-l-2 border-l-amber-500 bg-amber-100 p-4 text-sm text-amber-700'
          }
        >
          {outcome.text}
        </p>
      ) : null}

      <form method="get" className="surface-raised flex flex-wrap items-end gap-3 p-5">
        <div className="min-w-64 flex-1">
          <label className="label" htmlFor="q">
            Find the client
          </label>
          <input
            className="field"
            id="q"
            name="q"
            defaultValue={term}
            placeholder="Name or email address"
            autoComplete="off"
          />
        </div>
        <button className="btn btn-primary" type="submit">
          Search
        </button>
      </form>

      {results.length === 0 ? (
        <p className="surface text-ink-muted p-8 text-center text-sm">
          {term ? 'No client matches that.' : 'Search for a client to answer a request.'}
        </p>
      ) : (
        <ul className="space-y-4">
          {results.map((client) => (
            <li key={client.id} className="surface-raised p-5">
              <div className="flex flex-wrap items-start justify-between gap-4">
                <div className="min-w-0">
                  <h3 className="text-ink text-base font-medium">{client.fullName}</h3>
                  <p className="text-ink-muted mt-1 text-sm">
                    {client.email ?? 'no email on file'}
                  </p>
                </div>
                {client.erasedAt ? (
                  <span className="pill pill-neutral">
                    Erased{' '}
                    {new Intl.DateTimeFormat('en-MY', {
                      timeZone: 'Asia/Kuala_Lumpur',
                      dateStyle: 'medium',
                    }).format(client.erasedAt)}
                  </span>
                ) : null}
              </div>

              <div className="border-line mt-4 flex flex-wrap items-end gap-3 border-t pt-4">
                <a
                  className="btn btn-secondary"
                  href={`/api/privacy/export?client=${client.id}`}
                  download
                >
                  Export everything held
                </a>
              </div>

              {client.erasedAt ? null : (
                <details className="mt-4">
                  <summary className="cursor-pointer text-sm font-medium text-red-700">
                    Erase this client&rsquo;s personal data
                  </summary>

                  <div className="mt-3 rounded-sm border-l-2 border-l-red-500 bg-red-50 p-4">
                    <p className="text-sm text-red-700">
                      <strong>This cannot be undone.</strong> Name, email, telephone, identity
                      number and notes are overwritten, and every message ever sent to them is
                      redacted.
                    </p>
                    <p className="mt-3 text-sm text-red-700">
                      What survives, deliberately: the matter references, dates and status history,
                      because the firm must still be able to account for work it did; and the audit
                      log, which is append-only and already holds no client identifiers.
                    </p>

                    <form action={eraseClientAction} className="mt-4 space-y-3">
                      <input type="hidden" name="clientId" value={client.id} />
                      <input type="hidden" name="expectedName" value={client.fullName} />

                      <div>
                        <label className="label" htmlFor={`ref-${client.id}`}>
                          The firm&rsquo;s reference for this request
                        </label>
                        <input
                          className="field"
                          id={`ref-${client.id}`}
                          name="requestReference"
                          required
                          maxLength={120}
                          placeholder="DSR-2026-004"
                          autoComplete="off"
                        />
                      </div>

                      <div>
                        <label className="label" htmlFor={`confirm-${client.id}`}>
                          Type <strong>{client.fullName}</strong> to confirm
                        </label>
                        <input
                          className="field"
                          id={`confirm-${client.id}`}
                          name="confirm"
                          required
                          autoComplete="off"
                        />
                      </div>

                      <button className="btn btn-danger" type="submit">
                        Erase permanently
                      </button>
                    </form>
                  </div>
                </details>
              )}
            </li>
          ))}
        </ul>
      )}

      <section className="surface p-5">
        <h2 className="text-ink text-sm font-semibold">Retention</h2>
        <p className="text-ink-muted mt-2 text-sm">
          A weekly sweep destroys unconverted enquiries older than{' '}
          {RETENTION.UNCONVERTED_ENQUIRY_MONTHS} months and client correspondence older than{' '}
          {RETENTION.MESSAGE_YEARS} years. Enquiries that became matters are client records and are
          not touched.
        </p>
        <p className="text-ink-muted mt-2 text-sm">
          Waiting for the next sweep: <strong data-numeric>{due.enquiries}</strong> enquir
          {due.enquiries === 1 ? 'y' : 'ies'} and <strong data-numeric>{due.messages}</strong>{' '}
          message{due.messages === 1 ? '' : 's'}.
        </p>
        <p className="text-ink-faint mt-2 text-xs">
          Audit events are never destroyed. The table rejects deletion at the database level, so
          seven years is a floor rather than a ceiling — a professional-conduct complaint can
          outlive it.
        </p>
      </section>
    </div>
  );
}

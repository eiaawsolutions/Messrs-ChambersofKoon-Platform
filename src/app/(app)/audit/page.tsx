import type { Metadata } from 'next';
import { requireActor } from '@/lib/auth/session';
import { assertCan, grantedScope } from '@/lib/auth/guard';
import { PERMISSIONS } from '@/lib/auth/permissions';
import { auditActionOptions, listAuditEvents } from '@/lib/queries/audit';

export const metadata: Metadata = { title: 'Audit log' };
export const dynamic = 'force-dynamic';

/**
 * Audit log viewer (FR-1.7).
 *
 * The log is append-only at the database level, so this is a read surface with
 * no mutation path at all — there is deliberately no "delete" or "edit"
 * control anywhere, because the database would reject it.
 */
export default async function AuditPage({
  searchParams,
}: {
  searchParams: Promise<{ actor?: string; action?: string; from?: string; to?: string }>;
}) {
  const actor = await requireActor();
  assertCan(actor, PERMISSIONS.AUDIT_VIEW);

  const params = await searchParams;
  const filters = {
    ...(params.actor ? { actor: params.actor } : {}),
    ...(params.action ? { action: params.action } : {}),
    ...(params.from ? { from: params.from } : {}),
    ...(params.to ? { to: params.to } : {}),
  };

  const [events, actions] = await Promise.all([
    listAuditEvents(actor, filters),
    auditActionOptions(actor),
  ]);

  const query = new URLSearchParams(
    Object.entries(filters).map(([k, v]) => [k, String(v)]),
  ).toString();

  const officeScoped = grantedScope(actor, PERMISSIONS.AUDIT_VIEW) === 'office';

  return (
    <div className="space-y-8">
      <header>
        <h1 className="rule-brass text-3xl">Audit log</h1>
        <p className="text-ink-muted mt-4 max-w-2xl text-sm">
          Every sign-in, matter opened, document generated, draft finalised and permission change.
          The log cannot be edited or deleted — the database rejects both, including by an
          administrator.
          {officeScoped ? ' You see events for your own office.' : ''}
        </p>
      </header>

      <form method="get" className="surface-raised flex flex-wrap items-end gap-4 p-4">
        <div className="min-w-48 flex-1">
          <label className="label" htmlFor="actor">
            Actor email
          </label>
          <input
            className="field"
            id="actor"
            name="actor"
            defaultValue={params.actor ?? ''}
            autoComplete="off"
          />
        </div>
        <div className="min-w-48 flex-1">
          <label className="label" htmlFor="action">
            Action
          </label>
          <select className="field" id="action" name="action" defaultValue={params.action ?? ''}>
            <option value="">Any</option>
            {actions.map((a) => (
              <option key={a} value={a}>
                {a}
              </option>
            ))}
          </select>
        </div>
        <div className="w-40">
          <label className="label" htmlFor="from">
            From
          </label>
          <input
            className="field"
            id="from"
            name="from"
            type="date"
            defaultValue={params.from ?? ''}
          />
        </div>
        <div className="w-40">
          <label className="label" htmlFor="to">
            To
          </label>
          <input className="field" id="to" name="to" type="date" defaultValue={params.to ?? ''} />
        </div>
        <button className="btn btn-primary" type="submit">
          Filter
        </button>
        <a className="btn btn-secondary" href={`/api/audit/export?${query}`}>
          Export CSV
        </a>
      </form>

      {events.length === 0 ? (
        <p className="surface text-ink-muted p-10 text-center text-sm">No events match.</p>
      ) : (
        <>
          <p className="text-ink-faint text-xs" data-numeric>
            Showing the {events.length} most recent matching events. Export for the full set.
          </p>
          <div className="scroll-x surface">
            <table className="table-legal">
              <thead>
                <tr>
                  <th scope="col">When</th>
                  <th scope="col">Action</th>
                  <th scope="col">Actor</th>
                  <th scope="col">Entity</th>
                  <th scope="col">Matter</th>
                  <th scope="col">Detail</th>
                </tr>
              </thead>
              <tbody>
                {events.map((event) => (
                  <tr key={event.id}>
                    <td className="whitespace-nowrap" data-numeric>
                      {new Intl.DateTimeFormat('en-MY', {
                        timeZone: 'Asia/Kuala_Lumpur',
                        day: 'numeric',
                        month: 'short',
                        year: '2-digit',
                        hour: '2-digit',
                        minute: '2-digit',
                        second: '2-digit',
                      }).format(event.occurredAt)}
                    </td>
                    <td className="font-mono text-xs whitespace-nowrap">{event.action}</td>
                    <td className="text-xs">
                      {event.actorName ?? event.actorEmail ?? 'system'}
                      {event.ip ? <span className="text-ink-faint block">{event.ip}</span> : null}
                    </td>
                    <td className="text-xs">{event.entityType ?? '—'}</td>
                    <td className="font-mono text-xs">{event.matterReference ?? '—'}</td>
                    <td className="text-ink-muted max-w-md text-xs break-words">
                      {Object.keys(event.metadata).length > 0
                        ? JSON.stringify(event.metadata)
                        : '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}

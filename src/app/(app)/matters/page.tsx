import type { Metadata } from 'next';
import Link from 'next/link';
import { requireActor } from '@/lib/auth/session';
import { assertCan, grantedScope } from '@/lib/auth/guard';
import { PERMISSIONS } from '@/lib/auth/permissions';
import { listMatters } from '@/lib/queries/matters';

export const metadata: Metadata = { title: 'Matters' };
export const dynamic = 'force-dynamic';

const STATUS_PILL: Record<string, string> = {
  open: 'pill-info',
  on_hold: 'pill-warning',
  closed: 'pill-neutral',
};

export default async function MattersPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; status?: string }>;
}) {
  const actor = await requireActor();
  assertCan(actor, PERMISSIONS.MATTER_VIEW);

  const params = await searchParams;
  const indexOnly = grantedScope(actor, PERMISSIONS.MATTER_VIEW) === 'index';

  const rows = await listMatters(actor, {
    ...(params.q ? { search: params.q } : {}),
    ...(params.status ? { status: params.status } : {}),
  });

  return (
    <div className="space-y-8">
      <header>
        <h1 className="rule-brass text-3xl">Matters</h1>
        <p className="text-ink-muted mt-4 max-w-2xl text-sm">
          {indexOnly
            ? 'You have index access: references, status and dates. Client identity and document contents are not shown.'
            : 'Matters you are assigned to, supervising, or a participant on.'}
        </p>
      </header>

      <form method="get" className="surface-raised flex flex-wrap items-end gap-4 p-4">
        <div className="min-w-56 flex-1">
          <label className="label" htmlFor="q">
            Search
          </label>
          <input
            className="field"
            id="q"
            name="q"
            defaultValue={params.q ?? ''}
            placeholder={indexOnly ? 'Reference or title' : 'Reference, title or client'}
            autoComplete="off"
          />
        </div>
        <div className="w-44">
          <label className="label" htmlFor="status">
            Status
          </label>
          <select className="field" id="status" name="status" defaultValue={params.status ?? ''}>
            <option value="">Any</option>
            <option value="open">Open</option>
            <option value="on_hold">On hold</option>
            <option value="closed">Closed</option>
          </select>
        </div>
        <button className="btn btn-primary" type="submit">
          Filter
        </button>
      </form>

      {rows.length === 0 ? (
        <p className="surface text-ink-muted p-10 text-center text-sm">
          No matters match. If you expect to see one, check you are assigned to it.
        </p>
      ) : (
        <div className="scroll-x surface">
          <table className="table-legal">
            <thead>
              <tr>
                <th scope="col">Reference</th>
                <th scope="col">Matter</th>
                <th scope="col">Client</th>
                <th scope="col">Practice area</th>
                <th scope="col">Office</th>
                <th scope="col">Stage</th>
                <th scope="col">Status</th>
                <th scope="col">Opened</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.id}>
                  <td className="font-mono text-xs whitespace-nowrap">
                    <Link href={`/matters/${row.id}`} className="text-navy-600 underline">
                      {row.reference}
                    </Link>
                  </td>
                  <td>{row.title}</td>
                  <td>{row.clientName}</td>
                  <td className="whitespace-nowrap">{row.practiceArea.replace(/_/g, ' ')}</td>
                  <td>{row.office}</td>
                  <td className="text-ink-muted whitespace-nowrap">
                    {row.latestStage?.replace(/_/g, ' ') ?? '—'}
                  </td>
                  <td>
                    <span className={`pill ${STATUS_PILL[row.status] ?? 'pill-neutral'}`}>
                      {row.status.replace(/_/g, ' ')}
                    </span>
                  </td>
                  <td className="whitespace-nowrap" data-numeric>
                    {new Intl.DateTimeFormat('en-MY', {
                      timeZone: 'Asia/Kuala_Lumpur',
                      day: 'numeric',
                      month: 'short',
                      year: 'numeric',
                    }).format(row.openedAt)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

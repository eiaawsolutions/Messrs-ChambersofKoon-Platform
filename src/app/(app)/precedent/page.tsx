import type { Metadata } from 'next';
import { requireActor } from '@/lib/auth/session';
import { assertCan } from '@/lib/auth/guard';
import { PERMISSIONS } from '@/lib/auth/permissions';
import { retrievePrecedent } from '@/lib/rag/retrieve';
import type { Office, PracticeArea } from '@/lib/db/schema';

export const metadata: Metadata = { title: 'Precedent search' };
export const dynamic = 'force-dynamic';

const PRACTICE_AREAS: PracticeArea[] = [
  'family_matrimonial',
  'debt_recovery',
  'land_property',
  'corporate_disputes',
  'general',
];

/**
 * Precedent retrieval (FR-6.1 – FR-6.6, FR-8.4).
 *
 * Results are always excerpts with a citation — never an uncited summary
 * (FR-6.1), and the page has no generation step that could produce one. The
 * scope filter runs inside the query (FR-6.2), so a pupil's search cannot
 * surface an excerpt from a matter they cannot open.
 */
export default async function PrecedentPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; area?: string; office?: string; from?: string; to?: string }>;
}) {
  const actor = await requireActor();
  assertCan(actor, PERMISSIONS.RAG_SEARCH);

  const params = await searchParams;
  const query = params.q?.trim() ?? '';

  const retrieval = query
    ? await retrievePrecedent({
        actor,
        query,
        filters: {
          ...(params.area ? { practiceArea: params.area as PracticeArea } : {}),
          ...(params.office ? { office: params.office as Office } : {}),
          ...(params.from ? { from: params.from } : {}),
          ...(params.to ? { to: params.to } : {}),
        },
        limit: 15,
      })
    : null;

  return (
    <div className="space-y-8">
      <header>
        <h1 className="rule-brass text-3xl">Precedent</h1>
        <p className="text-ink-muted mt-4 max-w-2xl text-sm">
          Search the firm&rsquo;s own matter archive. Results are excerpts with their source, not a
          summary — you are reading what the file actually says.
          {actor.masksClientIdentifiers ? ' Client identifiers are masked on your account.' : ''}
        </p>
      </header>

      <form method="get" className="surface-raised space-y-4 p-5">
        <div>
          <label className="label" htmlFor="q">
            What are you looking for?
          </label>
          <input
            className="field"
            id="q"
            name="q"
            defaultValue={query}
            placeholder="similar debt recovery matters against Sdn Bhd defendants"
            autoComplete="off"
          />
        </div>

        <div className="grid gap-4 sm:grid-cols-4">
          <div>
            <label className="label" htmlFor="area">
              Practice area
            </label>
            <select className="field" id="area" name="area" defaultValue={params.area ?? ''}>
              <option value="">Any</option>
              {PRACTICE_AREAS.map((area) => (
                <option key={area} value={area}>
                  {area.replace(/_/g, ' ')}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="label" htmlFor="office">
              Office
            </label>
            <select className="field" id="office" name="office" defaultValue={params.office ?? ''}>
              <option value="">Any</option>
              <option value="KL">Kuala Lumpur</option>
              <option value="PJ">Petaling Jaya</option>
              <option value="IPOH">Ipoh</option>
            </select>
          </div>
          <div>
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
          <div>
            <label className="label" htmlFor="to">
              To
            </label>
            <input className="field" id="to" name="to" type="date" defaultValue={params.to ?? ''} />
          </div>
        </div>

        <button className="btn btn-primary" type="submit">
          Search
        </button>
      </form>

      {retrieval ? (
        retrieval.results.length === 0 ? (
          // FR-6.6: zero-result and low-confidence states say so plainly.
          <div className="surface p-8 text-center">
            <p className="font-display text-lg">Nothing in the archive matches that</p>
            <p className="text-ink-muted mx-auto mt-3 max-w-md text-sm">
              No excerpt cleared the relevance threshold. Rather than show you a weak match dressed
              up as a precedent, this returns nothing. Try different terms, widen the filters, or
              check whether the relevant files have been uploaded.
            </p>
          </div>
        ) : (
          <section aria-label="Results">
            {retrieval.lowConfidence ? (
              <p className="mb-5 rounded-sm border-l-2 border-l-amber-500 bg-amber-100 p-3 text-sm text-amber-700">
                These matches are weak. Read them as leads, not authority.
              </p>
            ) : null}

            <p className="text-ink-faint mb-4 text-xs">
              {retrieval.results.length} excerpt{retrieval.results.length === 1 ? '' : 's'} ·
              searched for &ldquo;{retrieval.rewrittenQuery}&rdquo;
            </p>

            <ul className="space-y-4">
              {retrieval.results.map((result) => (
                <li key={result.chunkId} className="surface p-5">
                  <div className="flex flex-wrap items-baseline justify-between gap-3">
                    <p className="text-ink text-sm font-medium">
                      {result.sourceFilename ?? result.matterReference ?? 'Firm precedent'}
                      {result.locator ? (
                        <span className="text-ink-muted font-normal"> · {result.locator}</span>
                      ) : null}
                    </p>
                    <div className="flex flex-wrap gap-1.5">
                      {result.matchedBy.map((arm) => (
                        <span key={arm} className="pill pill-neutral">
                          {arm}
                        </span>
                      ))}
                    </div>
                  </div>

                  {result.matterReference ? (
                    <p className="text-ink-faint mt-1 font-mono text-xs">
                      {result.matterReference}
                      {result.practiceArea ? ` · ${result.practiceArea.replace(/_/g, ' ')}` : ''}
                      {result.office ? ` · ${result.office}` : ''}
                    </p>
                  ) : null}

                  <blockquote className="border-brass-500 text-ink mt-3 border-l-2 pl-4 text-sm whitespace-pre-wrap">
                    {result.text}
                  </blockquote>
                </li>
              ))}
            </ul>
          </section>
        )
      ) : (
        <p className="surface text-ink-muted p-8 text-center text-sm">
          Enter a query to search the archive.
        </p>
      )}
    </div>
  );
}

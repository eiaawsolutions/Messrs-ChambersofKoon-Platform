import type { Metadata } from 'next';
import Link from 'next/link';
import { requireActor } from '@/lib/auth/session';
import { assertCan, getAuthorisedMatter } from '@/lib/auth/guard';
import { PERMISSIONS } from '@/lib/auth/permissions';
import { retrievePrecedent } from '@/lib/rag/retrieve';
import { getDocumentHeader } from '@/lib/queries/documents';
import { INSERT_ERRORS, type InsertErrorCode } from '@/lib/documents/insert-excerpt';
import { listSavedSearches } from '@/lib/rag/saved-searches';
import { insertPrecedentAction, saveSearchAction, deleteSavedSearchAction } from './actions';
import type { Office, PracticeArea } from '@/lib/db/schema';

export const metadata: Metadata = { title: 'Precedent search' };
export const dynamic = 'force-dynamic';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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
 *
 * `?document=` puts the page in insert mode (FR-6.5): each result gains an
 * "Insert into draft" action that appends the excerpt and its citation to that
 * draft. Without the parameter the page is exactly what it was — read-only
 * search — so arriving here from the nav loses nothing.
 */
export default async function PrecedentPage({
  searchParams,
}: {
  searchParams: Promise<{
    q?: string;
    area?: string;
    office?: string;
    from?: string;
    to?: string;
    document?: string;
    insert?: string;
    v?: string;
  }>;
}) {
  const actor = await requireActor();
  assertCan(actor, PERMISSIONS.RAG_SEARCH);

  const params = await searchParams;
  const query = params.q?.trim() ?? '';

  // getDocumentHeader returns null for both "does not exist" and "not yours",
  // so a probed id tells the caller nothing either way.
  const target =
    params.document && UUID.test(params.document)
      ? await getDocumentHeader(actor, params.document)
      : null;

  const mayDraft = target
    ? (await getAuthorisedMatter(actor, target.matterId, PERMISSIONS.DOCUMENT_GENERATE)) !== null
    : false;

  const canInsert = target !== null && mayDraft && target.state !== 'final';

  const insertSaved = params.insert === 'saved';
  const insertedVersion = Number.parseInt(params.v ?? '', 10);
  const insertError =
    params.insert && params.insert in INSERT_ERRORS
      ? INSERT_ERRORS[params.insert as InsertErrorCode]
      : null;

  // FR-8.5. Loaded alongside the search rather than behind a tab: a saved
  // search is only useful if it is visible at the moment you would run one.
  const saved = await listSavedSearches(actor);

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

      {/* Insert mode. The draft is named so it is obvious where an insert
          lands, and the state that blocks it is stated rather than the button
          quietly not appearing. */}
      {target ? (
        <section aria-label="Target draft" className="border-l-navy-600 surface border-l-2 p-5">
          <p className="text-ink text-sm">
            {canInsert ? 'Inserting into' : 'Working from'}{' '}
            <Link href={`/documents/${target.id}`} className="text-navy-600 underline">
              {target.title}
            </Link>
          </p>
          <p className="text-ink-muted mt-2 text-sm">
            {canInsert
              ? 'Each result below can be pulled into that draft as a new version, with its citation attached. The excerpt goes in verbatim — nothing is rewritten or summarised.'
              : target.state === 'final'
                ? 'That document has been finalised, so nothing can be inserted into it. Reopen it first, or work from a new draft.'
                : 'You do not hold drafting permission on that matter, so insert is unavailable. Search still works.'}
          </p>
        </section>
      ) : null}

      {insertSaved ? (
        <section
          role="status"
          className="rounded-sm border-l-2 border-l-green-500 bg-green-100 p-5"
        >
          <p className="text-sm text-green-700">
            Excerpt inserted
            {Number.isFinite(insertedVersion) ? ` as version ${insertedVersion}` : ''}, with its
            citation.{' '}
            {target ? (
              <Link href={`/documents/${target.id}`} className="underline">
                Open the draft
              </Link>
            ) : null}
          </p>
        </section>
      ) : null}

      {insertError ? (
        <section role="alert" className="rounded-sm border-l-2 border-l-amber-500 bg-amber-100 p-5">
          <p className="text-sm text-amber-700">{insertError}</p>
        </section>
      ) : null}

      <form method="get" className="surface-raised space-y-4 p-5">
        {/* Keeps the target draft attached across a re-search. */}
        {target ? <input type="hidden" name="document" value={target.id} /> : null}
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

      {/* FR-8.5. A saved search stores the question, not the answer — reopening
          one re-runs it under the reader's own scope, so sharing a machine or
          a role never carries someone else's permitted excerpts across. */}
      {saved.length > 0 || query ? (
        <section aria-label="Saved searches" className="surface p-5">
          <h2 className="text-ink text-sm font-semibold">Saved searches</h2>

          {saved.length > 0 ? (
            <ul className="mt-3 space-y-2">
              {saved.map((entry) => {
                const search = new URLSearchParams({ q: entry.query });
                if (entry.practiceArea) search.set('area', entry.practiceArea);
                if (entry.office) search.set('office', entry.office);
                if (entry.dateFrom) search.set('from', entry.dateFrom);
                if (entry.dateTo) search.set('to', entry.dateTo);
                if (target) search.set('document', target.id);

                return (
                  <li
                    key={entry.id}
                    className="border-line flex flex-wrap items-center justify-between gap-3 border-b pb-2 last:border-b-0"
                  >
                    <Link
                      href={`/precedent?${search.toString()}`}
                      className="text-navy-600 text-sm underline"
                    >
                      {entry.name}
                    </Link>
                    <div className="flex items-center gap-3">
                      <span className="text-ink-faint text-xs">
                        {[
                          entry.practiceArea?.replace(/_/g, ' '),
                          entry.office,
                          entry.dateFrom || entry.dateTo
                            ? `${entry.dateFrom ?? '…'} – ${entry.dateTo ?? '…'}`
                            : null,
                        ]
                          .filter(Boolean)
                          .join(' · ')}
                      </span>
                      <form action={deleteSavedSearchAction}>
                        <input type="hidden" name="id" value={entry.id} />
                        <button
                          className="text-ink-muted hover:text-ink text-xs underline"
                          type="submit"
                        >
                          Forget
                        </button>
                      </form>
                    </div>
                  </li>
                );
              })}
            </ul>
          ) : (
            <p className="text-ink-muted mt-2 text-sm">
              None yet. Save a search you run often and it will appear here.
            </p>
          )}

          {query ? (
            <form action={saveSearchAction} className="mt-4 flex flex-wrap items-end gap-3">
              <input type="hidden" name="q" value={query} />
              <input type="hidden" name="area" value={params.area ?? ''} />
              <input type="hidden" name="office" value={params.office ?? ''} />
              <input type="hidden" name="from" value={params.from ?? ''} />
              <input type="hidden" name="to" value={params.to ?? ''} />
              <div className="min-w-56 flex-1">
                <label className="label" htmlFor="saved-name">
                  Save this search as
                </label>
                <input
                  className="field"
                  id="saved-name"
                  name="name"
                  required
                  maxLength={120}
                  placeholder="Sdn Bhd debt recovery"
                  autoComplete="off"
                />
              </div>
              <button className="btn btn-secondary" type="submit">
                Save
              </button>
            </form>
          ) : null}
        </section>
      ) : null}

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

                  {/* FR-6.5. Only the chunk id is posted — the excerpt itself is
                      re-read server-side under this actor's own scope, so the
                      form cannot dictate what text enters the document. */}
                  {canInsert && target ? (
                    <form action={insertPrecedentAction} className="mt-4">
                      <input type="hidden" name="documentId" value={target.id} />
                      <input type="hidden" name="matterId" value={target.matterId} />
                      <input type="hidden" name="chunkId" value={result.chunkId} />
                      <input type="hidden" name="q" value={query} />
                      <input type="hidden" name="area" value={params.area ?? ''} />
                      <input type="hidden" name="office" value={params.office ?? ''} />
                      <input type="hidden" name="from" value={params.from ?? ''} />
                      <input type="hidden" name="to" value={params.to ?? ''} />
                      <button className="btn btn-secondary" type="submit">
                        Insert into draft — with citation
                      </button>
                    </form>
                  ) : null}
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

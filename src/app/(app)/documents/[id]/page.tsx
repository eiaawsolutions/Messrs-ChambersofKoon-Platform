import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { requireActor } from '@/lib/auth/session';
import { can, getAuthorisedMatter } from '@/lib/auth/guard';
import { PERMISSIONS } from '@/lib/auth/permissions';
import { documentVersionList } from '@/lib/queries/matters';
import { getDocumentHeader } from '@/lib/queries/documents';
import { finaliseDocumentAction } from '../../matters/actions';

export const metadata: Metadata = { title: 'Document' };
export const dynamic = 'force-dynamic';

function fmt(date: Date): string {
  return new Intl.DateTimeFormat('en-MY', {
    timeZone: 'Asia/Kuala_Lumpur',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(date);
}

interface GenerationInputs {
  missingDeterministic?: string[];
  templateVersion?: number;
  aiBlockNames?: string[];
}

/**
 * Document view (FR-4.4, FR-4.5, FR-4.6).
 *
 * Version history with download of any prior version, the change summary
 * between versions, and the provenance every generation records: model
 * version, prompt hash and the chunks cited. That trail is what makes an
 * AI-assisted draft defensible under professional-conduct review.
 */
export default async function DocumentPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const actor = await requireActor();

  const doc = await getDocumentHeader(actor, id);
  if (!doc) notFound();

  const history = await documentVersionList(actor, id);
  if (!history) notFound();

  const authorised = await getAuthorisedMatter(actor, doc.matterId);
  const mayFinalise = can(actor, PERMISSIONS.DOCUMENT_FINALISE, authorised ?? undefined);

  const latest = history.versions[0];
  const missing = ((latest?.generationInputs ?? {}) as GenerationInputs).missingDeterministic ?? [];

  return (
    <div className="space-y-8">
      <header>
        <Link href={`/matters/${doc.matterId}`} className="text-navy-600 text-sm underline">
          ← Back to matter
        </Link>
        <h1 className="rule-brass mt-3 text-3xl">{doc.title}</h1>
        <div className="mt-4 flex flex-wrap items-center gap-2">
          <span className={`pill ${doc.state === 'final' ? 'pill-success' : 'pill-neutral'}`}>
            {doc.state.replace(/_/g, ' ')}
          </span>
          {doc.finalisedAt ? (
            <span className="text-ink-faint text-xs" data-numeric>
              finalised {fmt(doc.finalisedAt)}
            </span>
          ) : null}
        </div>
      </header>

      {history.versions.length === 0 ? (
        <div className="surface p-8 text-center">
          <p className="font-display text-lg">Generating the first draft</p>
          <p className="text-ink-muted mx-auto mt-3 max-w-md text-sm">
            Drafting runs in the background — a Sonnet call per AI block plus precedent retrieval.
            Refresh in a moment. If it does not appear, the job failed and will be retried; check
            the exceptions on your dashboard.
          </p>
        </div>
      ) : (
        <>
          {/* AT-09: missing deterministic fields are surfaced as a checklist,
              never filled with a plausible-looking guess. */}
          {missing.length > 0 ? (
            <section
              aria-labelledby="missing"
              className="rounded-sm border-l-2 border-l-amber-500 bg-amber-100 p-5"
            >
              <h2 id="missing" className="text-base font-semibold text-amber-700">
                {missing.length} field{missing.length === 1 ? '' : 's'} could not be filled
              </h2>
              <p className="mt-2 text-sm text-amber-700">
                These appear in the document as <code>[TO CONFIRM: …]</code>. Nothing was invented
                for them. Supply the values on the matter and regenerate, or edit them in Word.
              </p>
              <ul className="mt-3 list-disc pl-5 text-sm text-amber-700">
                {missing.map((field) => (
                  <li key={field}>{field}</li>
                ))}
              </ul>
            </section>
          ) : null}

          {mayFinalise && doc.state !== 'final' ? (
            <form action={finaliseDocumentAction} className="surface-raised p-5">
              <input type="hidden" name="documentId" value={doc.id} />
              <input type="hidden" name="matterId" value={doc.matterId} />
              <h2 className="text-base font-semibold">Finalise</h2>
              <p className="text-ink-muted mt-2 text-sm">
                Download the current version, review and amend it in Word, then mark it final.
                Finalisation is recorded in the audit log against your name.
              </p>
              <button className="btn btn-primary mt-4" type="submit">
                Mark final
              </button>
            </form>
          ) : null}

          <section aria-labelledby="versions">
            <h2 id="versions" className="rule-brass text-xl">
              Version history
            </h2>
            <ul className="mt-5 space-y-3">
              {history.versions.map((version) => {
                const inputs = (version.generationInputs ?? {}) as GenerationInputs;
                const isCurrent = version.id === doc.currentVersionId;
                return (
                  <li key={version.id} className="surface p-5">
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div>
                        <p className="text-ink text-sm font-medium">
                          Version {version.versionNo}
                          {isCurrent ? <span className="pill pill-info ml-2">current</span> : null}
                          <span
                            className={`pill ml-2 ${
                              version.generatedBy === 'ai' ? 'pill-neutral' : 'pill-success'
                            }`}
                          >
                            {version.generatedBy === 'ai' ? 'AI-assisted' : 'human'}
                          </span>
                        </p>
                        <p className="text-ink-faint mt-1 text-xs" data-numeric>
                          {fmt(version.createdAt)} · {version.createdBy ?? 'system'}
                        </p>
                      </div>
                      <a
                        className="btn btn-secondary flex-none"
                        href={`/api/documents/${doc.id}/versions/${version.versionNo}/download`}
                      >
                        Download .docx
                      </a>
                    </div>

                    {version.changeSummary ? (
                      <p className="text-ink-muted mt-3 text-sm">{version.changeSummary}</p>
                    ) : null}

                    {/* FR-4.4: provenance for professional-conduct traceability. */}
                    <details className="mt-3">
                      <summary className="text-navy-600 cursor-pointer text-xs">Provenance</summary>
                      <dl className="text-ink-muted mt-2 space-y-1 font-mono text-xs">
                        {version.modelVersion ? (
                          <div>
                            <dt className="inline">model: </dt>
                            <dd className="inline">{version.modelVersion}</dd>
                          </div>
                        ) : null}
                        {version.promptHash ? (
                          <div>
                            <dt className="inline">prompt: </dt>
                            <dd className="inline break-all">{version.promptHash.slice(0, 16)}…</dd>
                          </div>
                        ) : null}
                        {inputs.templateVersion ? (
                          <div>
                            <dt className="inline">template rev: </dt>
                            <dd className="inline">{inputs.templateVersion}</dd>
                          </div>
                        ) : null}
                        <div>
                          <dt className="inline">precedent cited: </dt>
                          <dd className="inline">
                            {version.citedChunkIds?.length ?? 0} excerpt(s)
                          </dd>
                        </div>
                        {inputs.aiBlockNames?.length ? (
                          <div>
                            <dt className="inline">AI blocks: </dt>
                            <dd className="inline">{inputs.aiBlockNames.join(', ')}</dd>
                          </div>
                        ) : null}
                      </dl>
                    </details>
                  </li>
                );
              })}
            </ul>
          </section>
        </>
      )}
    </div>
  );
}

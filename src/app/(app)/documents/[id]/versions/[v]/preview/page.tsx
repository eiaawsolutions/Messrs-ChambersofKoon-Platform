import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { requireActor, requestContext } from '@/lib/auth/session';
import { previewForVersion } from '@/lib/queries/documents';
import { aiShare, type PreviewParagraph } from '@/lib/documents/preview';

export const metadata: Metadata = { title: 'Draft preview' };
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

const ALIGN: Record<PreviewParagraph['align'], string> = {
  left: 'text-left',
  center: 'text-center',
  right: 'text-right',
  justify: 'text-justify',
};

/**
 * Colour-coded draft preview (FR-4.2, FR-4.4).
 *
 * The question a partner asks about an AI-assisted draft is not "is it good" —
 * it is "which parts of this did the machine write." Until now that could only
 * be answered by opening the .docx and remembering which sections the template
 * had delegated. This screen answers it at a glance: the firm's own precedent
 * and the values taken from matter data in navy, everything the model drafted
 * for this version in amber, and the fields the platform refused to invent in
 * clay.
 *
 * The attribution is read from what was recorded at generation time, not
 * guessed from the prose — see preview.ts. Where the record is incomplete the
 * page says so rather than showing a confident, wrong picture.
 */
export default async function DraftPreviewPage({
  params,
}: {
  params: Promise<{ id: string; v: string }>;
}) {
  const { id, v } = await params;
  const versionNo = Number(v);
  if (!Number.isInteger(versionNo) || versionNo < 1) notFound();

  const actor = await requireActor();
  const ctx = await requestContext();

  const result = await previewForVersion({
    actor,
    documentId: id,
    versionNo,
    ip: ctx.ip,
    userAgent: ctx.userAgent,
  });

  // Identical response whether the version does not exist or the actor may not
  // read it — no enumeration.
  if (!result) notFound();

  const { preview } = result;
  const share = aiShare(preview);
  const unmatched = preview.blocks.filter((block) => !block.matched);
  const attributed = preview.blocks.length > 0;

  return (
    <div className="space-y-7">
      <header>
        <Link href={`/documents/${result.documentId}`} className="text-navy-600 text-sm underline">
          ← Back to {result.documentTitle}
        </Link>
        <h1 className="rule-brass mt-3 text-3xl">Draft preview</h1>
        <div className="mt-4 flex flex-wrap items-center gap-2">
          <span className="pill pill-info">Version {result.versionNo}</span>
          {result.isCurrent ? <span className="pill pill-neutral">current</span> : null}
          <span className={`pill ${result.generatedBy === 'ai' ? 'pill-warning' : 'pill-success'}`}>
            {result.generatedBy === 'ai' ? 'AI-assisted' : 'human'}
          </span>
          <span className="text-ink-faint text-xs" data-numeric>
            {fmt(result.createdAt)} · {result.createdBy ?? 'system'}
          </span>
        </div>
        <p className="text-ink-muted mt-4 max-w-2xl text-sm">
          Every run of text below is marked with where it came from. Nothing here is inferred from
          the wording — it is read from what the platform recorded when this version was produced.
        </p>
      </header>

      {/* Legend. Colour is the shorthand; the words are the definition. */}
      <section
        aria-label="Colour key"
        className="surface flex flex-wrap items-center gap-x-6 gap-y-3 p-4"
      >
        <span className="flex items-center gap-2 text-sm">
          <span className="draft-key bg-navy-700" aria-hidden="true" />
          <span>
            <strong className="font-medium">Firm template &amp; matter data</strong>
            <span className="text-ink-muted"> — precedent wording, never model-generated</span>
          </span>
        </span>
        <span className="flex items-center gap-2 text-sm">
          <span className="draft-key bg-amber-500" aria-hidden="true" />
          <span>
            <strong className="font-medium">Drafted by Claude</strong>
            <span className="text-ink-muted"> — review before filing</span>
          </span>
        </span>
        {preview.missingMarkers.length > 0 ? (
          <span className="flex items-center gap-2 text-sm">
            <span className="draft-key bg-clay-500" aria-hidden="true" />
            <span>
              <strong className="font-medium">Not supplied</strong>
              <span className="text-ink-muted"> — left blank, not invented</span>
            </span>
          </span>
        ) : null}
      </section>

      {/* Every way this page can be less than complete, stated before the
          document rather than discovered after trusting it. */}
      {!preview.readable ? (
        <section role="alert" className="border-l-clay-500 bg-clay-100 rounded-sm border-l-2 p-5">
          <h2 className="text-clay-700 text-base font-semibold">
            This version cannot be displayed
          </h2>
          <p className="text-clay-700 mt-2 text-sm">
            The stored file could not be read as a Word document. It is still available to download
            and may open correctly in Word. If it does not, generate a new draft.
          </p>
        </section>
      ) : null}

      {preview.readable && !attributed ? (
        <section className="border-l-navy-600 bg-navy-50 rounded-sm border-l-2 p-5">
          <h2 className="text-navy-700 text-base font-semibold">Nothing is attributed here</h2>
          <p className="text-navy-700 mt-2 text-sm">
            {result.generatedBy === 'human'
              ? 'This version was uploaded by a lawyer, so the platform holds no record of which parts a model wrote. It is shown unmarked rather than shown as though it were all the firm’s own text — some of it may originate from an earlier generated draft.'
              : 'No AI blocks were recorded against this version, so nothing can be marked as model-drafted.'}
          </p>
        </section>
      ) : null}

      {unmatched.length > 0 ? (
        <section role="alert" className="rounded-sm border-l-2 border-l-amber-500 bg-amber-100 p-5">
          <h2 className="text-base font-semibold text-amber-700">
            {unmatched.length} drafted {unmatched.length === 1 ? 'section is' : 'sections are'} no
            longer highlighted
          </h2>
          <p className="mt-2 text-sm text-amber-700">
            The recorded text for {unmatched.map((block) => block.label).join(', ')} does not appear
            in this file — it was most likely edited in Word after generation. Those passages are
            shown unmarked, so treat the highlighting below as incomplete for this version.
          </p>
        </section>
      ) : null}

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_20rem] lg:items-start">
        {/* --- The document ------------------------------------------------ */}
        <article
          className="draft-sheet"
          aria-label={`${result.documentTitle}, version ${result.versionNo}`}
        >
          {preview.paragraphs.map((paragraph, index) => (
            <p
              key={index}
              className={`draft-p ${ALIGN[paragraph.align]} ${
                paragraph.strong ? 'draft-p-strong' : ''
              }`}
            >
              {paragraph.segments.map((segment, segmentIndex) =>
                segment.kind === 'ai' ? (
                  <mark key={segmentIndex} className="draft-ai">
                    {segment.text}
                  </mark>
                ) : (
                  <span
                    key={segmentIndex}
                    className={segment.kind === 'missing' ? 'draft-missing' : 'draft-template'}
                  >
                    {segment.text}
                  </span>
                ),
              )}
            </p>
          ))}

          {preview.truncated ? (
            <p className="border-line text-ink-faint mt-6 border-t pt-4 text-sm">
              This document is longer than the preview shows. Download it to read the remainder.
            </p>
          ) : null}
        </article>

        {/* --- What the record says ---------------------------------------- */}
        <aside className="space-y-5 lg:sticky lg:top-20">
          <section className="surface p-5">
            <h2 className="text-base font-semibold">Composition</h2>

            {attributed ? (
              <>
                <p className="text-ink-muted mt-2 text-sm">
                  <strong className="text-ink" data-numeric>
                    {share}%
                  </strong>{' '}
                  of this draft was written by the model.
                </p>
                <div
                  className="bg-navy-700 mt-3 flex h-2 overflow-hidden rounded-full"
                  role="img"
                  aria-label={`${share} per cent drafted by the model, ${100 - share} per cent from the firm's template and matter data`}
                >
                  <span className="block h-full bg-amber-500" style={{ width: `${share}%` }} />
                </div>
              </>
            ) : (
              <p className="text-ink-muted mt-2 text-sm">
                No attribution is recorded for this version.
              </p>
            )}

            {preview.blocks.length > 0 ? (
              <>
                <h3 className="text-ink-muted mt-5 text-xs font-semibold tracking-wide uppercase">
                  Sections drafted by Claude
                </h3>
                <ul className="mt-2 space-y-2">
                  {preview.blocks.map((block) => (
                    <li key={block.name} className="flex items-start gap-2 text-sm">
                      <span
                        className={`draft-key mt-1.5 ${block.matched ? 'bg-amber-500' : 'bg-line-strong'}`}
                        aria-hidden="true"
                      />
                      <span className="min-w-0 flex-1">
                        <span className="block">{block.label}</span>
                        <span className="text-ink-faint text-xs" data-numeric>
                          {block.chars.toLocaleString('en-MY')} characters
                          {block.matched ? '' : ' · not found in this file'}
                        </span>
                      </span>
                    </li>
                  ))}
                </ul>
              </>
            ) : null}
          </section>

          {/* AT-09: the gaps, restated as a checklist beside the document. */}
          {result.missingDeterministic.length > 0 ? (
            <section className="border-l-clay-500 bg-clay-100 rounded-sm border-l-2 p-5">
              <h2 className="text-clay-700 text-base font-semibold">
                {result.missingDeterministic.length} field
                {result.missingDeterministic.length === 1 ? '' : 's'} not supplied
              </h2>
              <p className="text-clay-700 mt-2 text-sm">
                Left as <code>[TO CONFIRM: …]</code> in the document. No value was invented.
              </p>
              <ul className="text-clay-700 mt-3 list-disc space-y-1 pl-5 text-sm">
                {result.missingDeterministic.map((field) => (
                  <li key={field}>{field}</li>
                ))}
              </ul>
            </section>
          ) : null}

          <section className="surface p-5">
            <h2 className="text-base font-semibold">Provenance</h2>
            {result.changeSummary ? (
              <p className="text-ink-muted mt-2 text-sm">{result.changeSummary}</p>
            ) : null}
            <dl className="text-ink-muted mt-3 space-y-1 font-mono text-xs">
              {result.modelVersion ? (
                <div>
                  <dt className="inline">model: </dt>
                  <dd className="inline">{result.modelVersion}</dd>
                </div>
              ) : null}
              {result.promptHash ? (
                <div>
                  <dt className="inline">prompt: </dt>
                  <dd className="inline break-all">{result.promptHash.slice(0, 16)}…</dd>
                </div>
              ) : null}
              <div>
                <dt className="inline">precedent cited: </dt>
                <dd className="inline">{result.citedChunkCount} excerpt(s)</dd>
              </div>
            </dl>
          </section>

          <a
            className="btn btn-secondary w-full"
            href={`/api/documents/${result.documentId}/versions/${result.versionNo}/download`}
          >
            Download .docx
          </a>
        </aside>
      </div>
    </div>
  );
}

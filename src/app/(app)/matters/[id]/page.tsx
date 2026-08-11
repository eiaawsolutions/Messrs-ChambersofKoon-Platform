import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { requireActor } from '@/lib/auth/session';
import { can, getAuthorisedMatter } from '@/lib/auth/guard';
import { PERMISSIONS } from '@/lib/auth/permissions';
import {
  getMatterDetail,
  matterAppointments,
  matterDocuments,
  matterMessages,
  matterParticipantList,
  matterTimeline,
  stagesForMatter,
} from '@/lib/queries/matters';
import { activeTemplatesFor } from '@/lib/queries/documents';
import { generateDraftAction, recordStatusAction, setCommsHoldAction } from '../actions';

export const metadata: Metadata = { title: 'Matter' };
export const dynamic = 'force-dynamic';

const MESSAGE_PILL: Record<string, string> = {
  sent: 'pill-info',
  delivered: 'pill-success',
  bounced: 'pill-danger',
  failed: 'pill-danger',
  queued: 'pill-neutral',
  suppressed: 'pill-warning',
};

function fmt(date: Date | null): string {
  if (!date) return '—';
  return new Intl.DateTimeFormat('en-MY', {
    timeZone: 'Asia/Kuala_Lumpur',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(date);
}

/**
 * Matter view (FR-8.2): client, status timeline, documents, appointments,
 * messages, participants.
 */
export default async function MatterPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const actor = await requireActor();

  const detail = await getMatterDetail(actor, id);
  // Indistinguishable from "does not exist" — prevents matter enumeration.
  if (!detail) notFound();

  const authorised = await getAuthorisedMatter(actor, id);
  const mayRecordStatus = can(actor, PERMISSIONS.MATTER_STATUS_RECORD, authorised ?? undefined);
  const mayGenerate = can(actor, PERMISSIONS.DOCUMENT_GENERATE, authorised ?? undefined);
  const mayEdit = can(actor, PERMISSIONS.MATTER_EDIT, authorised ?? undefined);

  const [timeline, docs, appts, msgs, participants, stages, templates] = await Promise.all([
    matterTimeline(actor, id),
    matterDocuments(actor, id),
    matterAppointments(actor, id),
    matterMessages(actor, id),
    matterParticipantList(actor, id),
    stagesForMatter(id),
    mayGenerate ? activeTemplatesFor(detail.practiceArea as 'general') : Promise.resolve([]),
  ]);

  return (
    <div className="space-y-10">
      <header>
        <p className="text-ink-faint font-mono text-xs tracking-widest">{detail.reference}</p>
        <h1 className="rule-brass mt-1 text-3xl">{detail.title}</h1>
        <div className="mt-4 flex flex-wrap gap-2">
          <span className="pill pill-neutral">{detail.practiceArea.replace(/_/g, ' ')}</span>
          <span className="pill pill-neutral">{detail.office}</span>
          <span className="pill pill-info">{detail.status.replace(/_/g, ' ')}</span>
          {detail.commsHold ? (
            <span className="pill pill-warning">client communications on hold</span>
          ) : null}
        </div>
      </header>

      <div className="grid gap-8 lg:grid-cols-[2fr_1fr]">
        <div className="space-y-10">
          {/* --- Status recorder ------------------------------------------ */}
          {mayRecordStatus ? (
            <section aria-labelledby="record" className="surface-raised p-5">
              <h2 id="record" className="text-lg">
                Record a procedural stage
              </h2>
              <p className="text-ink-muted mt-2 text-sm">
                Recording a stage sends the matching client update within a minute, unless you
                suppress it or the matter is on hold. The platform does not read court systems —
                this is your record of what happened.
              </p>
              <form action={recordStatusAction} className="mt-4 space-y-4">
                <input type="hidden" name="matterId" value={id} />
                <div className="grid gap-4 sm:grid-cols-2">
                  <div>
                    <label className="label" htmlFor="stage">
                      Stage
                    </label>
                    <select className="field" id="stage" name="stage" required>
                      {stages.map((stage) => (
                        <option key={stage.key} value={stage.key}>
                          {stage.label}
                          {stage.hasTemplate ? ' (emails the client)' : ''}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label className="label" htmlFor="notes">
                      Detail (appears in the client email where the template uses it)
                    </label>
                    <input className="field" id="notes" name="notes" maxLength={2000} />
                  </div>
                </div>
                <label className="text-ink-muted flex items-center gap-2 text-sm">
                  <input type="checkbox" name="suppress" />
                  Do not email the client about this one
                </label>
                <button className="btn btn-primary" type="submit">
                  Record stage
                </button>
              </form>
            </section>
          ) : null}

          {/* --- Timeline -------------------------------------------------- */}
          <section aria-labelledby="timeline">
            <h2 id="timeline" className="rule-brass text-xl">
              Timeline
            </h2>
            {timeline.length === 0 ? (
              <p className="surface text-ink-muted mt-5 p-6 text-sm">
                No procedural stages recorded yet.
              </p>
            ) : (
              <ol className="border-line mt-5 space-y-0 border-l pl-5">
                {timeline.map((event) => (
                  <li key={event.id} className="relative pb-6">
                    <span className="bg-brass-500 absolute top-1.5 -left-[23px] h-2 w-2 rounded-full" />
                    <p className="text-ink text-sm font-medium">
                      {event.label ?? event.stage.replace(/_/g, ' ')}
                      {event.suppressed ? (
                        <span className="pill pill-warning ml-2">no client email</span>
                      ) : null}
                    </p>
                    {event.notes ? (
                      <p className="text-ink-muted mt-1 text-sm">{event.notes}</p>
                    ) : null}
                    <p className="text-ink-faint mt-1 text-xs" data-numeric>
                      {fmt(event.occurredAt)} · {event.recordedBy ?? 'system'}
                    </p>
                  </li>
                ))}
              </ol>
            )}
          </section>

          {/* --- Documents ------------------------------------------------- */}
          <section aria-labelledby="documents">
            <h2 id="documents" className="rule-brass text-xl">
              Documents
            </h2>

            {!detail.canReadContents ? (
              <p className="surface text-ink-muted mt-5 p-6 text-sm">
                Your role does not include document contents on this matter.
              </p>
            ) : (
              <>
                {docs.length === 0 ? (
                  <p className="surface text-ink-muted mt-5 p-6 text-sm">No documents yet.</p>
                ) : (
                  <ul className="mt-5 space-y-2">
                    {docs.map((doc) => (
                      <li key={doc.id} className="surface flex flex-wrap items-center gap-3 p-4">
                        <div className="min-w-0 flex-1">
                          <Link
                            href={`/documents/${doc.id}`}
                            className="text-navy-600 text-sm font-medium underline"
                          >
                            {doc.title}
                          </Link>
                          <p className="text-ink-faint mt-0.5 text-xs" data-numeric>
                            {doc.versionCount} version{doc.versionCount === 1 ? '' : 's'} · updated{' '}
                            {fmt(doc.updatedAt)}
                          </p>
                        </div>
                        <span
                          className={`pill ${doc.state === 'final' ? 'pill-success' : 'pill-neutral'}`}
                        >
                          {doc.state.replace(/_/g, ' ')}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}

                {mayGenerate ? (
                  templates.length === 0 ? (
                    <p className="surface text-ink-muted mt-4 p-4 text-sm">
                      No active precedent template for {detail.practiceArea.replace(/_/g, ' ')}.
                      Upload one in the admin console before generating a draft.
                    </p>
                  ) : (
                    <form
                      action={generateDraftAction}
                      className="surface-raised mt-4 flex flex-wrap items-end gap-3 p-4"
                    >
                      <input type="hidden" name="matterId" value={id} />
                      <div className="min-w-48 flex-1">
                        <label className="label" htmlFor="templateId">
                          Template
                        </label>
                        <select className="field" id="templateId" name="templateId" required>
                          {templates.map((t) => (
                            <option key={t.id} value={t.id}>
                              {t.name}
                            </option>
                          ))}
                        </select>
                      </div>
                      <div className="min-w-48 flex-1">
                        <label className="label" htmlFor="title">
                          Document title
                        </label>
                        <input className="field" id="title" name="title" required maxLength={300} />
                      </div>
                      <button className="btn btn-primary" type="submit">
                        Generate first draft
                      </button>
                    </form>
                  )
                ) : null}
              </>
            )}
          </section>

          {/* --- Client communications ------------------------------------ */}
          {detail.canReadContents ? (
            <section aria-labelledby="messages">
              <h2 id="messages" className="rule-brass text-xl">
                Client communications
              </h2>
              {msgs.length === 0 ? (
                <p className="surface text-ink-muted mt-5 p-6 text-sm">
                  Nothing has been sent to the client from this matter.
                </p>
              ) : (
                <div className="scroll-x surface mt-5">
                  <table className="table-legal">
                    <thead>
                      <tr>
                        <th scope="col">Subject</th>
                        <th scope="col">To</th>
                        <th scope="col">State</th>
                        <th scope="col">Sent</th>
                        <th scope="col">Delivered</th>
                      </tr>
                    </thead>
                    <tbody>
                      {msgs.map((m) => (
                        <tr key={m.id}>
                          <td>{m.subject}</td>
                          <td className="text-xs">{m.toEmail || '—'}</td>
                          <td>
                            <span className={`pill ${MESSAGE_PILL[m.state] ?? 'pill-neutral'}`}>
                              {m.state}
                            </span>
                            {m.error ? (
                              <p className="text-clay-700 mt-1 text-xs">{m.error}</p>
                            ) : null}
                          </td>
                          <td className="whitespace-nowrap" data-numeric>
                            {fmt(m.sentAt)}
                          </td>
                          <td className="whitespace-nowrap" data-numeric>
                            {fmt(m.deliveredAt)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </section>
          ) : null}
        </div>

        {/* --- Sidebar ----------------------------------------------------- */}
        <aside className="space-y-6">
          <section className="surface-raised p-5">
            <h2 className="text-base font-semibold">Client</h2>
            <dl className="mt-3 space-y-2 text-sm">
              <div>
                <dt className="text-ink-faint text-xs uppercase">Name</dt>
                <dd>{detail.client.name}</dd>
              </div>
              {detail.client.email ? (
                <div>
                  <dt className="text-ink-faint text-xs uppercase">Email</dt>
                  <dd className="break-all">{detail.client.email}</dd>
                </div>
              ) : null}
              {detail.client.phone ? (
                <div>
                  <dt className="text-ink-faint text-xs uppercase">Phone</dt>
                  <dd data-numeric>{detail.client.phone}</dd>
                </div>
              ) : null}
            </dl>
            {actor.masksClientIdentifiers ? (
              <p className="text-ink-faint mt-3 text-xs">
                Client identifiers are masked on your account.
              </p>
            ) : null}
          </section>

          <section className="surface-raised p-5">
            <h2 className="text-base font-semibold">Handling</h2>
            <dl className="mt-3 space-y-2 text-sm">
              <div>
                <dt className="text-ink-faint text-xs uppercase">Assigned</dt>
                <dd>{detail.assignedName ?? 'Unassigned'}</dd>
              </div>
              <div>
                <dt className="text-ink-faint text-xs uppercase">Supervising</dt>
                <dd>{detail.supervisingName ?? '—'}</dd>
              </div>
              <div>
                <dt className="text-ink-faint text-xs uppercase">Opened</dt>
                <dd data-numeric>{fmt(detail.openedAt)}</dd>
              </div>
              {participants.length > 0 ? (
                <div>
                  <dt className="text-ink-faint text-xs uppercase">Participants</dt>
                  <dd>{participants.map((p) => p.name).join(', ')}</dd>
                </div>
              ) : null}
            </dl>
          </section>

          <section className="surface-raised p-5">
            <h2 className="text-base font-semibold">Appointments</h2>
            {appts.length === 0 ? (
              <p className="text-ink-muted mt-3 text-sm">None scheduled.</p>
            ) : (
              <ul className="mt-3 space-y-3 text-sm">
                {appts.map((a) => (
                  <li key={a.id}>
                    <p data-numeric>{fmt(a.startsAt)}</p>
                    <p className="text-ink-faint text-xs">
                      {a.lawyerName ?? '—'} · {a.state}
                      {a.icsSequence > 0 ? ` · rev ${a.icsSequence}` : ''}
                    </p>
                  </li>
                ))}
              </ul>
            )}
          </section>

          {mayEdit ? (
            <section className="surface-raised p-5">
              <h2 className="text-base font-semibold">Client communications</h2>
              <p className="text-ink-muted mt-2 text-sm">
                {detail.commsHold
                  ? 'All automated client updates are held on this matter.'
                  : 'Automated updates are sent as stages are recorded.'}
              </p>
              <form action={setCommsHoldAction} className="mt-3">
                <input type="hidden" name="matterId" value={id} />
                <input type="hidden" name="hold" value={detail.commsHold ? 'off' : 'on'} />
                <button
                  className={`btn ${detail.commsHold ? 'btn-secondary' : 'btn-danger'} w-full`}
                  type="submit"
                >
                  {detail.commsHold ? 'Resume client updates' : 'Hold all client updates'}
                </button>
              </form>
            </section>
          ) : null}
        </aside>
      </div>
    </div>
  );
}

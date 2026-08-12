import type { Metadata } from 'next';
import { requireActor } from '@/lib/auth/session';
import { enquiriesNeedingReview, pendingProposalsFor } from '@/lib/queries/dashboard';
import { assertCan, can } from '@/lib/auth/guard';
import { PERMISSIONS } from '@/lib/auth/permissions';
import { formatSlotForClient } from '@/lib/scheduling/slots';
import { confidenceBand } from '@/lib/intake/triage';
import type { Office } from '@/lib/db/schema';
import { heldEnquiries } from '@/lib/intake/duplicate-check';
import {
  acceptProposalAction,
  declineProposalAction,
  proposeForEnquiryAction,
  releaseEnquiryAction,
  retriageEnquiryAction,
} from './actions';

export const metadata: Metadata = { title: 'Intake' };
export const dynamic = 'force-dynamic';

/**
 * Intake queue (FR-8.3): case briefs with one-tap approve / reschedule /
 * decline, plus the human review queue that low-confidence triage routes to
 * (FR-2.6).
 */
const OFFICES: Array<{ value: Office; label: string }> = [
  { value: 'KL', label: 'Kuala Lumpur' },
  { value: 'PJ', label: 'Petaling Jaya' },
  { value: 'IPOH', label: 'Ipoh' },
];

export default async function IntakePage({
  searchParams,
}: {
  searchParams: Promise<{ office?: string }>;
}) {
  const actor = await requireActor();
  assertCan(actor, PERMISSIONS.INTAKE_VIEW);

  const mayDecide = can(actor, PERMISSIONS.PROPOSAL_DECIDE);

  /*
   * FR-8.5, the per-office view.
   *
   * Only offered to a reader whose scope already spans the firm — for everyone
   * else the queries have narrowed to their own office before this parameter
   * is read, and it can only narrow further. So the control is a convenience
   * for a managing partner, never a way to widen anyone's reach.
   */
  const seesAllOffices = actor.grants[PERMISSIONS.INTAKE_VIEW] === 'all';
  const params = await searchParams;
  const officeFilter =
    seesAllOffices && OFFICES.some((o) => o.value === params.office)
      ? (params.office as Office)
      : null;

  const canTriage = can(actor, PERMISSIONS.INTAKE_TRIAGE);

  const [proposals, review, held] = await Promise.all([
    pendingProposalsFor(actor, officeFilter),
    enquiriesNeedingReview(actor, officeFilter),
    canTriage ? heldEnquiries() : Promise.resolve([]),
  ]);

  return (
    <div className="space-y-12">
      <header>
        <h1 className="rule-brass text-3xl">Intake</h1>
        <p className="text-ink-muted mt-4 max-w-2xl text-sm">
          Enquiries triaged by the intake agent. Nothing has been sent to any enquirer — a
          consultation is confirmed only when you accept it.
        </p>

        {seesAllOffices ? (
          <form method="get" className="mt-5 flex flex-wrap items-end gap-3">
            <div>
              <label className="label" htmlFor="office">
                Office
              </label>
              <select className="field" id="office" name="office" defaultValue={officeFilter ?? ''}>
                <option value="">All offices</option>
                {OFFICES.map((office) => (
                  <option key={office.value} value={office.value}>
                    {office.label}
                  </option>
                ))}
              </select>
            </div>
            <button className="btn btn-secondary" type="submit">
              Apply
            </button>
          </form>
        ) : (
          <p className="text-ink-faint mt-3 text-xs">
            Showing {actor.office} enquiries — the offices your role covers.
          </p>
        )}
      </header>

      <section aria-labelledby="awaiting">
        <h2 id="awaiting" className="text-xl">
          Awaiting decision
          <span className="pill pill-info ml-3 align-middle" data-numeric>
            {proposals.length}
          </span>
        </h2>

        {proposals.length === 0 ? (
          <p className="surface text-ink-muted mt-5 p-8 text-center text-sm">
            No consultations are waiting for a decision.
          </p>
        ) : (
          <ul className="mt-5 space-y-4">
            {proposals.map((proposal) => (
              <li key={proposal.id} className="surface-raised p-5">
                <div className="flex flex-wrap items-start justify-between gap-4">
                  <div className="min-w-0">
                    <h3 className="font-display text-lg">
                      {proposal.contactName ?? 'Enquirer (name not given)'}
                    </h3>
                    <p className="text-ink-muted mt-1 text-sm">
                      {(proposal.practiceArea ?? 'general').replace(/_/g, ' ')} · with{' '}
                      {proposal.lawyerName}
                    </p>
                    <p className="text-ink mt-2 text-sm font-medium" data-numeric>
                      {formatSlotForClient(proposal)}
                    </p>
                  </div>

                  <div className="flex flex-none flex-wrap gap-2">
                    <span
                      className={`pill ${
                        proposal.urgency === 'critical'
                          ? 'pill-danger'
                          : proposal.urgency === 'high'
                            ? 'pill-warning'
                            : 'pill-neutral'
                      }`}
                    >
                      {proposal.urgency}
                    </span>
                    {typeof proposal.confidence === 'number' ? (
                      <span className="pill pill-neutral" data-numeric>
                        Confidence: {confidenceBand(proposal.confidence)} · {proposal.confidence}%
                      </span>
                    ) : null}
                  </div>
                </div>

                {proposal.caseBriefMd ? (
                  <details className="mt-4">
                    <summary className="text-navy-600 cursor-pointer text-sm font-medium">
                      Case brief
                    </summary>
                    <div className="bg-paper-sunken mt-3 rounded-sm p-4 text-sm whitespace-pre-wrap">
                      {proposal.caseBriefMd}
                    </div>
                  </details>
                ) : null}

                {mayDecide ? (
                  <div className="border-line mt-5 flex flex-wrap items-center gap-3 border-t pt-4">
                    <form action={acceptProposalAction}>
                      <input type="hidden" name="proposalId" value={proposal.id} />
                      <button className="btn btn-primary" type="submit">
                        Accept and send invitation
                      </button>
                    </form>

                    <details className="relative">
                      <summary className="btn btn-danger list-none">Decline</summary>
                      <form
                        action={declineProposalAction}
                        className="surface-raised absolute right-0 z-10 mt-2 w-80 space-y-3 p-4 shadow-[var(--shadow-float)]"
                      >
                        <input type="hidden" name="proposalId" value={proposal.id} />
                        <label className="label" htmlFor={`reason-${proposal.id}`}>
                          Reason (internal only)
                        </label>
                        <textarea
                          id={`reason-${proposal.id}`}
                          name="reason"
                          required
                          maxLength={1000}
                          rows={3}
                          className="field"
                          placeholder="Conflict of interest, outside practice area, …"
                        />
                        <p className="text-ink-faint text-xs">
                          The enquirer is not told. The enquiry returns to the review queue.
                        </p>
                        <button className="btn btn-danger w-full" type="submit">
                          Confirm decline
                        </button>
                      </form>
                    </details>

                    <p className="text-ink-faint ml-auto text-xs">
                      Expires{' '}
                      {new Intl.DateTimeFormat('en-MY', {
                        timeZone: 'Asia/Kuala_Lumpur',
                        weekday: 'short',
                        day: 'numeric',
                        month: 'short',
                        hour: 'numeric',
                        minute: '2-digit',
                      }).format(proposal.expiresAt)}
                    </p>
                  </div>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section aria-labelledby="review">
        <h2 id="review" className="text-xl">
          Needs a human
          <span className="pill pill-warning ml-3 align-middle" data-numeric>
            {review.length}
          </span>
        </h2>
        <p className="text-ink-muted mt-3 max-w-2xl text-sm">
          Triage was not confident enough to propose a slot, the enquirer disclosed a safety
          concern, or a proposal was declined or expired.
        </p>

        {review.length === 0 ? (
          <p className="surface text-ink-muted mt-5 p-8 text-center text-sm">Nothing waiting.</p>
        ) : (
          <ul className="mt-5 space-y-4">
            {review.map((enquiry) => (
              <li key={enquiry.id} className="surface border-l-2 border-l-amber-500 p-5">
                <div className="flex flex-wrap items-start justify-between gap-4">
                  <div className="min-w-0">
                    <h3 className="text-ink text-base font-medium">
                      {enquiry.contactName ?? 'Enquirer (name not given)'}
                    </h3>
                    <p className="text-ink-muted mt-1 text-sm">
                      {(enquiry.practiceArea ?? 'not yet classified').replace(/_/g, ' ')}
                      {typeof enquiry.confidence === 'number'
                        ? ` · Confidence: ${confidenceBand(enquiry.confidence)} · ${enquiry.confidence}%`
                        : ''}
                      {' · '}
                      {new Intl.DateTimeFormat('en-MY', {
                        timeZone: 'Asia/Kuala_Lumpur',
                        day: 'numeric',
                        month: 'short',
                        hour: 'numeric',
                        minute: '2-digit',
                      }).format(enquiry.createdAt)}
                    </p>
                  </div>
                  <div className="flex flex-none flex-wrap gap-2">
                    {/* FR-2.8. Shown as context for the person reading it, not
                        as a verdict — the enquiry is worked either way. */}
                    {enquiry.duplicateOfEnquiryId ? (
                      <span className="pill pill-warning">Repeat within 24h</span>
                    ) : null}
                    <span className="pill pill-neutral">{enquiry.status}</span>
                  </div>
                </div>

                {enquiry.duplicateOfEnquiryId ? (
                  <p className="text-ink-muted mt-3 text-sm">
                    Same email as an earlier enquiry today. Read them together before replying — it
                    is usually one person adding something they forgot, not two matters.
                  </p>
                ) : null}

                {enquiry.caseBriefMd ? (
                  <details className="mt-4">
                    <summary className="text-navy-600 cursor-pointer text-sm font-medium">
                      Case brief
                    </summary>
                    <div className="bg-paper-sunken mt-3 rounded-sm p-4 text-sm whitespace-pre-wrap">
                      {enquiry.caseBriefMd}
                    </div>
                  </details>
                ) : (
                  <p className="text-ink-faint mt-3 text-sm">
                    No brief yet — triage has not run or did not complete.
                  </p>
                )}

                {can(actor, PERMISSIONS.INTAKE_TRIAGE) ? (
                  <div className="border-line mt-4 flex flex-wrap gap-2 border-t pt-4">
                    <form action={retriageEnquiryAction}>
                      <input type="hidden" name="enquiryId" value={enquiry.id} />
                      <button className="btn btn-secondary" type="submit">
                        Re-run triage
                      </button>
                    </form>
                    {mayDecide ? (
                      <form action={proposeForEnquiryAction}>
                        <input type="hidden" name="enquiryId" value={enquiry.id} />
                        <button className="btn btn-secondary" type="submit">
                          Propose a slot
                        </button>
                      </form>
                    ) : null}
                  </div>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* FR-2.8. Held, never deleted — the section exists so that is true in
          practice and not only in the commit message. */}
      {canTriage && held.length > 0 ? (
        <section aria-labelledby="held">
          <h2 id="held" className="text-xl">
            Held
            <span className="pill pill-neutral ml-3 align-middle" data-numeric>
              {held.length}
            </span>
          </h2>
          <p className="text-ink-muted mt-3 max-w-2xl text-sm">
            More enquiries arrived from one address in a day than a person sends. Nothing was
            deleted and nobody was told. Release anything genuine and it rejoins the queue above.
          </p>

          <ul className="mt-5 space-y-3">
            {held.map((enquiry) => (
              <li
                key={enquiry.id}
                className="surface flex flex-wrap items-center justify-between gap-4 p-4"
              >
                <div className="min-w-0">
                  <p className="text-ink text-sm font-medium">
                    {enquiry.contactName ?? 'Enquirer (name not given)'}
                  </p>
                  <p className="text-ink-faint mt-1 text-xs">
                    {enquiry.office ?? 'no office'} ·{' '}
                    {new Intl.DateTimeFormat('en-MY', {
                      timeZone: 'Asia/Kuala_Lumpur',
                      day: 'numeric',
                      month: 'short',
                      hour: 'numeric',
                      minute: '2-digit',
                    }).format(enquiry.createdAt)}
                  </p>
                </div>
                <form action={releaseEnquiryAction}>
                  <input type="hidden" name="enquiryId" value={enquiry.id} />
                  <button className="btn btn-secondary" type="submit">
                    Release to the queue
                  </button>
                </form>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}

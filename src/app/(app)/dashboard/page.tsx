import type { Metadata } from 'next';
import Link from 'next/link';
import { requireActor } from '@/lib/auth/session';
import {
  draftsAwaitingReview,
  needsHumanReviewCount,
  openExceptionsFor,
  pendingProposalsFor,
} from '@/lib/queries/dashboard';
import { formatSlotForClient } from '@/lib/scheduling/slots';

export const metadata: Metadata = { title: 'Today' };
export const dynamic = 'force-dynamic';

/**
 * FR-8.1: "Home: pending slot approvals, drafts awaiting review, matters with
 * milestones due, unread exceptions."
 *
 * Every count is scoped through the permission layer. An associate's "today"
 * is their caseload, not the firm's.
 */
export default async function DashboardPage() {
  const actor = await requireActor();

  const [pendingProposals, draftsAwaiting, openExceptions, needsReview] = await Promise.all([
    pendingProposalsFor(actor),
    draftsAwaitingReview(actor),
    openExceptionsFor(actor),
    needsHumanReviewCount(actor),
  ]);

  const stats = [
    { label: 'Slots to approve', value: pendingProposals.length, href: '/intake' },
    { label: 'Drafts in progress', value: draftsAwaiting.length, href: '/matters' },
    { label: 'Needs human triage', value: needsReview, href: '/intake' },
    { label: 'Open exceptions', value: openExceptions.length, href: '/dashboard' },
  ];

  return (
    <div className="space-y-10">
      <header>
        <p className="text-ink-faint font-mono text-xs tracking-widest uppercase">
          {new Intl.DateTimeFormat('en-MY', {
            timeZone: 'Asia/Kuala_Lumpur',
            weekday: 'long',
            day: 'numeric',
            month: 'long',
          }).format(new Date())}
        </p>
        <h1 className="rule-brass mt-1 text-3xl">Good day, {actor.fullName.split(' ')[0]}</h1>
      </header>

      <section aria-label="Summary">
        <ul className="grid gap-px overflow-hidden rounded-md border border-[color:var(--color-line)] bg-[color:var(--color-line)] sm:grid-cols-2 lg:grid-cols-4">
          {stats.map((stat) => (
            <li key={stat.label} className="bg-paper-raised p-5">
              <Link href={stat.href} className="block">
                <p className="font-display text-ink text-3xl leading-none" data-numeric>
                  {stat.value}
                </p>
                <p className="text-ink-muted mt-2 text-sm">{stat.label}</p>
              </Link>
            </li>
          ))}
        </ul>
      </section>

      {pendingProposals.length > 0 ? (
        <section aria-labelledby="proposals-heading">
          <h2 id="proposals-heading" className="rule-brass text-xl">
            Consultations awaiting your decision
          </h2>
          <p className="text-ink-muted mt-3 text-sm">
            Nothing has been sent to the enquirer. They hear from us only once you accept.
          </p>
          <ul className="mt-5 space-y-3">
            {pendingProposals.map((proposal) => (
              <li key={proposal.id} className="surface flex flex-wrap items-center gap-4 p-4">
                <div className="min-w-0 flex-1">
                  <p className="text-ink text-sm font-medium">
                    {proposal.contactName ?? 'New enquiry'}
                    {proposal.urgency === 'critical' || proposal.urgency === 'high' ? (
                      <span className="pill pill-warning ml-2">{proposal.urgency}</span>
                    ) : null}
                  </p>
                  <p className="text-ink-muted mt-1 text-sm" data-numeric>
                    {formatSlotForClient(proposal)}
                  </p>
                  <p className="text-ink-faint mt-0.5 text-xs">
                    {(proposal.practiceArea ?? 'general').replace(/_/g, ' ')} · expires{' '}
                    {new Intl.DateTimeFormat('en-MY', {
                      timeZone: 'Asia/Kuala_Lumpur',
                      day: 'numeric',
                      month: 'short',
                      hour: 'numeric',
                      minute: '2-digit',
                    }).format(proposal.expiresAt)}
                  </p>
                </div>
                <Link href={`/intake/${proposal.id}`} className="btn btn-primary flex-none">
                  Review
                </Link>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {openExceptions.length > 0 ? (
        <section aria-labelledby="exceptions-heading">
          <h2 id="exceptions-heading" className="rule-brass text-xl">
            Exceptions
          </h2>
          <ul className="mt-5 space-y-2">
            {openExceptions.map((task) => (
              <li key={task.id} className="surface border-l-clay-500 border-l-2 p-4">
                <p className="text-ink text-sm">{task.title}</p>
                <p className="text-ink-faint mt-1 font-mono text-xs">{task.kind}</p>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {draftsAwaiting.length > 0 ? (
        <section aria-labelledby="drafts-heading">
          <h2 id="drafts-heading" className="rule-brass text-xl">
            Drafts in progress
          </h2>
          <div className="scroll-x mt-5">
            <table className="table-legal">
              <thead>
                <tr>
                  <th scope="col">Document</th>
                  <th scope="col">Matter</th>
                  <th scope="col">Last updated</th>
                </tr>
              </thead>
              <tbody>
                {draftsAwaiting.map((draft) => (
                  <tr key={draft.id}>
                    <td>
                      <Link href={`/matters/${draft.matterId}`} className="text-navy-600 underline">
                        {draft.title}
                      </Link>
                    </td>
                    <td className="font-mono text-xs">{draft.reference}</td>
                    <td data-numeric>
                      {new Intl.DateTimeFormat('en-MY', {
                        timeZone: 'Asia/Kuala_Lumpur',
                        day: 'numeric',
                        month: 'short',
                      }).format(draft.updatedAt)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ) : null}

      {pendingProposals.length === 0 &&
      openExceptions.length === 0 &&
      draftsAwaiting.length === 0 ? (
        <section className="surface p-10 text-center">
          <p className="font-display text-ink text-xl">Nothing needs you right now</p>
          <p className="text-ink-muted mx-auto mt-3 max-w-md text-sm">
            New enquiries are triaged as they arrive. When one is ready for a consultation, the
            proposed slot appears here for your decision.
          </p>
        </section>
      ) : null}
    </div>
  );
}

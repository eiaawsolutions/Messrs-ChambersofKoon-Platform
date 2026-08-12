import type { Metadata } from 'next';
import { requireActor } from '@/lib/auth/session';
import { assertCan } from '@/lib/auth/guard';
import { PERMISSIONS } from '@/lib/auth/permissions';
import { operationsSnapshot } from '@/lib/queries/operations';

export const metadata: Metadata = { title: 'Operations' };
export const dynamic = 'force-dynamic';

/**
 * Operational dashboard (NFR-4.3).
 *
 * Counts and sums only — no client name, no brief, no message body. This is
 * the screen most likely to be left open on a shared monitor, and it answers
 * one question: is the platform working.
 *
 * Where a number is bad it is coloured and says what to do. A dashboard whose
 * every tile looks the same trains people to stop reading it.
 */

function Tile({
  label,
  value,
  hint,
  tone = 'neutral',
}: {
  label: string;
  value: string | number;
  hint?: string;
  tone?: 'neutral' | 'warn' | 'bad';
}) {
  const border =
    tone === 'bad' ? 'border-l-red-500' : tone === 'warn' ? 'border-l-amber-500' : 'border-l-line';

  return (
    <div className={`surface border-l-2 p-5 ${border}`}>
      <p className="text-ink-faint font-mono text-xs tracking-widest uppercase">{label}</p>
      <p className="font-display text-ink mt-2 text-3xl" data-numeric>
        {value}
      </p>
      {hint ? <p className="text-ink-muted mt-2 text-sm">{hint}</p> : null}
    </div>
  );
}

export default async function OperationsPage() {
  const actor = await requireActor();
  assertCan(actor, PERMISSIONS.AUDIT_VIEW);

  const ops = await operationsSnapshot();

  const peak = Math.max(1, ...ops.enquiriesPerDay.map((d) => d.count));
  const spendTone =
    ops.aiSpend.percentOfCeiling >= 90
      ? 'bad'
      : ops.aiSpend.percentOfCeiling >= 75
        ? 'warn'
        : 'neutral';
  const failedJobs = ops.queues.reduce((sum, q) => sum + q.failed, 0);
  const queuedJobs = ops.queues.reduce((sum, q) => sum + q.queued, 0);

  return (
    <div className="space-y-10">
      <section>
        <h2 className="text-xl">Operations</h2>
        <p className="text-ink-muted mt-3 max-w-2xl text-sm">
          Volumes and health. Nothing on this page identifies a client, so it is safe to leave open.
        </p>
      </section>

      <section aria-label="Headline figures" className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Tile
          label="Enquiries today"
          value={ops.enquiriesToday}
          hint={`${ops.enquiriesPerDay.reduce((s, d) => s + d.count, 0)} in the last 14 days`}
        />
        <Tile
          label="Proposals pending"
          value={ops.proposalsPending}
          hint={
            ops.proposalsExpiringToday > 0
              ? `${ops.proposalsExpiringToday} expire within 24 hours`
              : 'None expiring today'
          }
          tone={ops.proposalsExpiringToday > 0 ? 'warn' : 'neutral'}
        />
        <Tile
          label="Drafts generated"
          value={ops.draftsGenerated30d}
          hint="Model-written versions, last 30 days"
        />
        <Tile
          label="AI spend"
          value={`$${ops.aiSpend.monthToDateUsd.toFixed(2)}`}
          hint={`${ops.aiSpend.percentOfCeiling}% of the $${ops.aiSpend.ceilingUsd} monthly ceiling`}
          tone={spendTone}
        />
      </section>

      <section aria-labelledby="volume">
        <h3 id="volume" className="text-ink text-sm font-semibold">
          Enquiries per day
        </h3>
        <p className="text-ink-muted mt-2 text-sm">
          Quiet days are shown as zero rather than omitted — a widget that has stopped working looks
          like a run of empty columns, not a shorter chart.
        </p>

        <ul className="surface mt-4 flex items-end gap-1.5 p-5" style={{ height: '11rem' }}>
          {ops.enquiriesPerDay.map((day) => (
            <li
              key={day.day}
              className="flex flex-1 flex-col items-center justify-end gap-2"
              title={`${day.day}: ${day.count}`}
            >
              <span className="text-ink-faint text-xs" data-numeric>
                {day.count}
              </span>
              <span
                className="bg-brass-500 w-full rounded-t-sm"
                style={{ height: `${Math.max(2, (day.count / peak) * 100)}%` }}
                aria-hidden="true"
              />
              <span className="text-ink-faint font-mono text-[0.625rem]">
                {day.day.slice(8, 10)}
              </span>
            </li>
          ))}
        </ul>
      </section>

      <section
        aria-label="Delivery and processing"
        className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4"
      >
        <Tile
          label="Emails sent"
          value={ops.email30d.sent}
          hint={`${ops.email30d.delivered} confirmed delivered, last 30 days`}
        />
        <Tile
          label="Bounced"
          value={ops.email30d.bounced + ops.email30d.failed}
          hint={
            ops.email30d.bounced + ops.email30d.failed > 0
              ? 'Each one raised a clerk task — check the exception list'
              : 'Nothing bounced'
          }
          tone={ops.email30d.bounced + ops.email30d.failed > 0 ? 'warn' : 'neutral'}
        />
        <Tile
          label="Jobs failed"
          value={ops.queueUnavailable ? '—' : failedJobs}
          hint={
            ops.queueUnavailable
              ? 'Queue statistics unavailable — is the worker running?'
              : failedJobs > 0
                ? 'Exhausted their retries and are parked in the dead-letter queue'
                : `${queuedJobs} waiting, none failed`
          }
          tone={ops.queueUnavailable ? 'warn' : failedJobs > 0 ? 'bad' : 'neutral'}
        />
        <Tile
          label="Extractions failed"
          value={ops.extractionsFailed}
          hint={
            ops.extractionsFailed > 0
              ? 'Retryable from the archive screen — never silently dropped'
              : 'Every uploaded file extracted'
          }
          tone={ops.extractionsFailed > 0 ? 'warn' : 'neutral'}
        />
      </section>

      <section aria-labelledby="queues">
        <h3 id="queues" className="text-ink text-sm font-semibold">
          Job queues
        </h3>

        {ops.queueUnavailable ? (
          <p className="mt-3 rounded-sm border-l-2 border-l-amber-500 bg-amber-100 p-4 text-sm text-amber-700">
            Queue statistics could not be read. That usually means the worker service is not running
            — triage and slot proposal both depend on it, so enquiries will be recorded and nothing
            further will happen until it is back.
          </p>
        ) : (
          <div className="scroll-x surface mt-3">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-line border-b">
                  <th className="text-ink-muted p-3 text-left font-medium">Queue</th>
                  <th className="text-ink-muted p-3 text-right font-medium">Waiting</th>
                  <th className="text-ink-muted p-3 text-right font-medium">Running</th>
                  <th className="text-ink-muted p-3 text-right font-medium">Failed</th>
                </tr>
              </thead>
              <tbody>
                {ops.queues.map((queue) => (
                  <tr key={queue.name} className="border-line border-b last:border-b-0">
                    <td className="text-ink p-3 font-mono text-xs">{queue.name}</td>
                    <td className="p-3 text-right" data-numeric>
                      {queue.queued}
                    </td>
                    <td className="p-3 text-right" data-numeric>
                      {queue.active}
                    </td>
                    <td
                      className={`p-3 text-right ${queue.failed > 0 ? 'font-medium text-red-700' : ''}`}
                      data-numeric
                    >
                      {queue.failed}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {ops.exceptionsOpen > 0 ? (
        <p className="rounded-sm border-l-2 border-l-amber-500 bg-amber-100 p-4 text-sm text-amber-700">
          {ops.exceptionsOpen} open exception{ops.exceptionsOpen === 1 ? '' : 's'} assigned to staff
          — bounced client emails and matters past their stage SLA. They appear on the handling
          lawyer&rsquo;s dashboard, never to the client.
        </p>
      ) : null}
    </div>
  );
}

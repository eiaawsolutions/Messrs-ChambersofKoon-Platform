import 'server-only';
import { and, eq, isNull, or, sql } from 'drizzle-orm';
import { db } from '@/lib/db/client';
import {
  clients,
  exceptionTasks,
  matterStatusEvents,
  matters,
  messageSuppressions,
  messages,
  procedureStages,
  users,
} from '@/lib/db/schema';
import { loadTemplate } from '@/lib/comms/templates';
import { renderTemplate, sendEmail, textToHtml, EmailSendError } from '@/lib/email/resend';
import { config } from '@/lib/config/env';
import { audit, AUDIT_ACTIONS } from '@/lib/audit/log';

/**
 * Milestone communication (M7, FR-7.1 – FR-7.6).
 *
 * Triggered by a status event a member of firm staff recorded. The platform
 * never reads from or writes to court systems (FR-7.2) — a hearing date exists
 * here because a clerk typed it, and the copy is written to say so.
 *
 * Suppression is checked at send time rather than at enqueue time, so putting
 * a matter on hold stops emails that are already queued.
 */

export interface MilestoneOutcome {
  sent: boolean;
  reason: string;
  messageId?: string;
}

/** FR-7.4: per-matter hold and per-stage suppression. */
async function isSuppressed(matterId: string, stage: string): Promise<string | null> {
  const [matter] = await db
    .select({ commsHold: matters.commsHold })
    .from(matters)
    .where(eq(matters.id, matterId))
    .limit(1);

  if (matter?.commsHold) return 'matter is on communications hold';

  const [suppression] = await db
    .select({ id: messageSuppressions.id, stage: messageSuppressions.stage })
    .from(messageSuppressions)
    .where(
      and(
        eq(messageSuppressions.matterId, matterId),
        or(isNull(messageSuppressions.stage), eq(messageSuppressions.stage, stage)),
      ),
    )
    .limit(1);

  return suppression ? 'stage is suppressed on this matter' : null;
}

/**
 * Send the client email for a recorded status change (FR-7.3: within 60s).
 *
 * Idempotent on the status event id: a retry after a partial failure will not
 * send twice, because the unique idempotency key on `messages` rejects the
 * duplicate insert before the send happens.
 */
export async function dispatchMilestone(statusEventId: string): Promise<MilestoneOutcome> {
  const [event] = await db
    .select({
      id: matterStatusEvents.id,
      matterId: matterStatusEvents.matterId,
      stage: matterStatusEvents.stage,
      notes: matterStatusEvents.notes,
      suppressed: matterStatusEvents.suppressed,
    })
    .from(matterStatusEvents)
    .where(eq(matterStatusEvents.id, statusEventId))
    .limit(1);

  if (!event) return { sent: false, reason: 'status event not found' };
  if (event.suppressed) return { sent: false, reason: 'suppressed at the point of recording' };

  const idempotencyKey = `milestone-${event.id}`;

  const [existing] = await db
    .select({ id: messages.id, state: messages.state })
    .from(messages)
    .where(eq(messages.idempotencyKey, idempotencyKey))
    .limit(1);
  if (existing) {
    return {
      sent: existing.state !== 'failed',
      reason: 'already dispatched',
      messageId: existing.id,
    };
  }

  const suppressedReason = await isSuppressed(event.matterId, event.stage);
  if (suppressedReason) {
    await db
      .insert(messages)
      .values({
        matterId: event.matterId,
        toEmail: '',
        templateKey: null,
        subject: '(suppressed)',
        bodyRendered: '',
        state: 'suppressed',
        idempotencyKey,
      })
      .onConflictDoNothing();
    return { sent: false, reason: suppressedReason };
  }

  const [matter] = await db
    .select({
      id: matters.id,
      reference: matters.reference,
      practiceArea: matters.practiceArea,
      clientName: clients.fullName,
      clientEmail: clients.email,
      lawyerName: users.fullName,
      lawyerEmail: users.email,
    })
    .from(matters)
    .innerJoin(clients, eq(clients.id, matters.clientId))
    .leftJoin(users, eq(users.id, matters.assignedUserId))
    .where(eq(matters.id, event.matterId))
    .limit(1);

  if (!matter) return { sent: false, reason: 'matter not found' };
  if (!matter.clientEmail) {
    await raiseException({
      matterId: matter.id,
      kind: 'missing_client_email',
      title: `No client email on ${matter.reference}`,
      detail: `Stage "${event.stage}" was recorded but the client has no email address, so no update could be sent.`,
    });
    return { sent: false, reason: 'client has no email address' };
  }

  const [stage] = await db
    .select({
      messageTemplateKey: procedureStages.messageTemplateKey,
      label: procedureStages.label,
    })
    .from(procedureStages)
    .where(
      and(
        eq(procedureStages.practiceArea, matter.practiceArea),
        eq(procedureStages.key, event.stage),
      ),
    )
    .limit(1);

  if (!stage?.messageTemplateKey) {
    return { sent: false, reason: 'stage has no client-facing template' };
  }

  const template = await loadTemplate(stage.messageTemplateKey);
  if (!template) return { sent: false, reason: 'template not found or inactive' };

  const cfg = config();
  const variables = {
    clientName: matter.clientName,
    matterReference: matter.reference,
    lawyerName: matter.lawyerName ?? cfg.FIRM_NAME,
    firmName: cfg.FIRM_NAME,
    stageLabel: stage.label,
    stageDetail: event.notes ?? '',
  };

  const subject = renderTemplate(template.subject, variables);
  const text = renderTemplate(template.bodyMd, variables);

  const [row] = await db
    .insert(messages)
    .values({
      matterId: matter.id,
      toEmail: matter.clientEmail,
      templateKey: template.key,
      subject,
      bodyRendered: text,
      state: 'queued',
      idempotencyKey,
    })
    .onConflictDoNothing()
    .returning({ id: messages.id });

  if (!row) return { sent: false, reason: 'already dispatched (raced)' };

  try {
    const result = await sendEmail({
      to: matter.clientEmail,
      subject,
      text,
      html: textToHtml(text, cfg.FIRM_NAME),
      idempotencyKey,
    });

    await db
      .update(messages)
      .set({ state: 'sent', sentAt: new Date(), resendMessageId: result.id || null })
      .where(eq(messages.id, row.id));

    await audit({
      action: AUDIT_ACTIONS.MESSAGE_SEND,
      entityType: 'message',
      entityId: row.id,
      matterId: matter.id,
      metadata: { templateKey: template.key, stage: event.stage },
    });

    return { sent: true, reason: 'sent', messageId: row.id };
  } catch (error) {
    const message = (error as Error).message;
    await db
      .update(messages)
      .set({ state: 'failed', error: message })
      .where(eq(messages.id, row.id));

    // FR-7.6: exceptions escalate to the handling lawyer, never to the client.
    await raiseException({
      matterId: matter.id,
      messageId: row.id,
      kind: 'send_failed',
      title: `Client update failed to send on ${matter.reference}`,
      detail: message,
    });

    // Retryable errors are rethrown so pg-boss backs off and tries again.
    if (error instanceof EmailSendError && !error.retryable) {
      return { sent: false, reason: `permanent failure: ${message}` };
    }
    throw error;
  }
}

export async function raiseException(params: {
  matterId: string | null;
  messageId?: string;
  kind: string;
  title: string;
  detail?: string;
}): Promise<void> {
  let assignedUserId: string | null = null;
  if (params.matterId) {
    const [matter] = await db
      .select({ assigned: matters.assignedUserId, supervising: matters.supervisingUserId })
      .from(matters)
      .where(eq(matters.id, params.matterId))
      .limit(1);
    assignedUserId = matter?.assigned ?? matter?.supervising ?? null;
  }

  await db.insert(exceptionTasks).values({
    matterId: params.matterId,
    messageId: params.messageId ?? null,
    kind: params.kind,
    title: params.title,
    detail: params.detail ?? null,
    assignedUserId,
    state: 'open',
  });
}

/**
 * FR-7.6: a matter that has not moved past a stage within its SLA raises a
 * task for the handling lawyer. The client is never told about the delay —
 * that is a conversation for the lawyer to have, if they choose to.
 */
export async function sweepSlaBreaches(): Promise<number> {
  const rows = await db.execute<{
    matter_id: string;
    reference: string;
    stage: string;
    label: string;
    sla_days: number;
    days_elapsed: number;
  }>(sql`
    with latest as (
      select distinct on (e.matter_id)
        e.matter_id, e.stage, e.occurred_at
      from matter_status_events e
      order by e.matter_id, e.occurred_at desc
    )
    select
      m.id as matter_id,
      m.reference,
      latest.stage,
      s.label,
      s.sla_days,
      extract(day from now() - latest.occurred_at)::int as days_elapsed
    from latest
    join matters m on m.id = latest.matter_id
    join procedure_stages s
      on s.practice_area = m.practice_area and s.key = latest.stage
    where m.status = 'open'
      and s.sla_days is not null
      and latest.occurred_at < now() - (s.sla_days || ' days')::interval
      and not exists (
        select 1 from exception_tasks t
        where t.matter_id = m.id
          and t.kind = 'sla_breach'
          and t.state <> 'resolved'
      )
  `);

  for (const row of rows.rows) {
    await raiseException({
      matterId: row.matter_id,
      kind: 'sla_breach',
      title: `${row.reference} has sat at "${row.label}" for ${row.days_elapsed} days`,
      detail:
        `The configured SLA for this stage is ${row.sla_days} days. ` +
        `No status change has been recorded since. The client has not been contacted about this.`,
    });
  }

  return rows.rows.length;
}

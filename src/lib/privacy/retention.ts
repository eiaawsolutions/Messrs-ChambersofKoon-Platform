import 'server-only';
import { sql } from 'drizzle-orm';
import { db } from '@/lib/db/client';
import { audit, AUDIT_ACTIONS } from '@/lib/audit/log';

/**
 * Retention (NFR-2.2).
 *
 * "Documented retention: audit events 7 years, messages 7 years, unconverted
 *  enquiries 24 months then purge."
 *
 * ## Audit events are not purged, and that is deliberate
 *
 * The PRD gives audit events a seven-year retention. It does not say destroy
 * them afterwards, and this build does not: `audit_events` is append-only at
 * the database level — migration `post/0002` installs triggers that reject
 * UPDATE, DELETE and TRUNCATE regardless of who is connected, including the
 * table owner. Deleting a seven-year-old audit row is therefore impossible
 * without a migration that removes that guarantee.
 *
 * That is the stronger position and the intended one. Seven years is the floor
 * a firm must meet, not a ceiling it must not exceed, and a limitation period
 * on a professional-conduct complaint can outrun it. If the firm ever adopts a
 * policy requiring destruction, it needs a deliberate migration, a documented
 * decision and a signature — not a nightly job that quietly does it.
 *
 * ## What is purged
 *
 * - **Unconverted enquiries past 24 months.** Someone who enquired and never
 *   became a client has no continuing relationship with the firm, and holding
 *   their account of a marriage breakdown indefinitely is the thing PDPA
 *   §7.2 is about. Rows that became a matter are excluded — those are client
 *   records and live under the matter's own retention.
 * - **Messages past 7 years.** Sent client correspondence, matching the audit
 *   floor.
 *
 * Both run as a single statement each so a partial sweep cannot leave an
 * enquiry without its transcript. Counts are audited so the firm can show what
 * was destroyed and when.
 */

export const RETENTION = {
  /** NFR-2.2: unconverted enquiries. */
  UNCONVERTED_ENQUIRY_MONTHS: 24,
  /** NFR-2.2: client correspondence. */
  MESSAGE_YEARS: 7,
} as const;

export interface PurgeResult {
  enquiries: number;
  messages: number;
}

/**
 * Delete what is past its retention date.
 *
 * `enquiry_messages`, `appointment_proposals` and `chunks` carry ON DELETE
 * CASCADE from the enquiry, so the transcript goes with the enquiry rather
 * than being orphaned. `appointments.enquiry_id` and `messages.enquiry_id` are
 * ON DELETE SET NULL — a consultation that actually happened is a record of
 * the firm's own activity and survives the enquiry that produced it.
 */
export async function purgeExpiredData(): Promise<PurgeResult> {
  const enquiryRows = await db.execute(sql`
    delete from enquiries
    where matter_id is null
      and status <> 'booked'
      and created_at < now() - (${RETENTION.UNCONVERTED_ENQUIRY_MONTHS} || ' months')::interval
  `);

  const messageRows = await db.execute(sql`
    delete from messages
    where created_at < now() - (${RETENTION.MESSAGE_YEARS} || ' years')::interval
  `);

  const result: PurgeResult = {
    enquiries: enquiryRows.rowCount ?? 0,
    messages: messageRows.rowCount ?? 0,
  };

  // Only when something happened. A nightly no-op event for the life of the
  // deployment would bury the sweeps that did destroy something.
  if (result.enquiries > 0 || result.messages > 0) {
    await audit({
      action: AUDIT_ACTIONS.RETENTION_PURGE,
      entityType: 'retention',
      metadata: {
        enquiriesPurged: result.enquiries,
        messagesPurged: result.messages,
        enquiryRetentionMonths: RETENTION.UNCONVERTED_ENQUIRY_MONTHS,
        messageRetentionYears: RETENTION.MESSAGE_YEARS,
      },
    });
  }

  return result;
}

export interface RetentionDue {
  enquiries: number;
  messages: number;
}

/** What the next sweep would remove. Read-only, for the operations screen. */
export async function retentionDue(): Promise<RetentionDue> {
  const rows = await db.execute<{ enquiries: string; messages: string }>(sql`
    select
      (
        select count(*) from enquiries
        where matter_id is null
          and status <> 'booked'
          and created_at < now() - (${RETENTION.UNCONVERTED_ENQUIRY_MONTHS} || ' months')::interval
      ) as enquiries,
      (
        select count(*) from messages
        where created_at < now() - (${RETENTION.MESSAGE_YEARS} || ' years')::interval
      ) as messages
  `);

  const row = rows.rows[0];
  return { enquiries: Number(row?.enquiries ?? 0), messages: Number(row?.messages ?? 0) };
}

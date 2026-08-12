import 'server-only';
import { desc, eq, inArray, isNull, or, sql } from 'drizzle-orm';
import { db } from '@/lib/db/client';
import { appointments, clients, matterStatusEvents, matters, messages } from '@/lib/db/schema';
import { audit, AUDIT_ACTIONS } from '@/lib/audit/log';
import { decryptField } from '@/lib/security/crypto';
import type { Actor } from '@/lib/auth/guard';

/**
 * Data subject requests — export and erasure (NFR-2.3).
 *
 * "Export and delete a client's personal data with a documented procedure that
 *  preserves audit integrity (tombstone, not hard delete of audit rows)."
 *
 * ## Erasure is a tombstone, not a DELETE
 *
 * Deleting the `clients` row is not available and would not be right if it
 * were. Matters reference it with ON DELETE RESTRICT, and a firm cannot
 * truthfully say a matter existed while being unable to say whose it was — the
 * professional-conduct record and the client's erasure right both have to
 * survive the same operation.
 *
 * So the personal data is overwritten in place and the row is stamped
 * `erasedAt`. What remains is a shell: the matter references, the dates, the
 * fact that a consultation happened. What goes is everything that identifies
 * the person — name, email, telephone, identity number, free-text notes, and
 * the rendered body of every message ever sent to them.
 *
 * `audit_events` is untouched by design. It is append-only at the database
 * level and its metadata is already scrubbed of client identifiers on write
 * (see `scrubMetadata`), so it records that things happened without recording
 * who to. The erasure itself is appended to it.
 *
 * ## Both halves are audited
 *
 * An export is a disclosure of everything the firm holds about a person and is
 * logged as one. An erasure is irreversible and is logged with the counts it
 * changed, so the firm can evidence its response to a regulator.
 */

export interface ClientDataExport {
  generatedAt: string;
  client: {
    id: string;
    fullName: string;
    email: string | null;
    phone: string | null;
    /** Decrypted for the subject's own copy; never rendered in the app. */
    idNumber: string | null;
    notes: string | null;
    createdAt: string;
    erasedAt: string | null;
  };
  matters: Array<{
    reference: string;
    title: string;
    practiceArea: string;
    office: string;
    status: string;
    openedAt: string;
    closedAt: string | null;
    statusHistory: Array<{ stage: string; occurredAt: string; notes: string | null }>;
  }>;
  appointments: Array<{
    startsAt: string;
    endsAt: string;
    location: string;
    title: string;
    state: string;
  }>;
  messages: Array<{
    subject: string;
    body: string;
    toEmail: string;
    state: string;
    sentAt: string | null;
  }>;
}

/**
 * Everything the firm holds about one client, as a portable document.
 *
 * Scoped by the caller's `privacy.manage` grant rather than by matter access:
 * answering a subject request is a firm-level obligation, and a Managing
 * Partner must be able to answer it for a matter they are not personally on.
 * That is why the permission is separate and narrowly granted.
 */
export async function exportClientData(params: {
  actor: Actor;
  clientId: string;
}): Promise<ClientDataExport | null> {
  const [client] = await db.select().from(clients).where(eq(clients.id, params.clientId)).limit(1);

  if (!client) return null;

  const clientMatters = await db
    .select({
      id: matters.id,
      reference: matters.reference,
      title: matters.title,
      practiceArea: matters.practiceArea,
      office: matters.office,
      status: matters.status,
      openedAt: matters.openedAt,
      closedAt: matters.closedAt,
    })
    .from(matters)
    .where(eq(matters.clientId, client.id))
    .orderBy(desc(matters.openedAt));

  const matterIds = clientMatters.map((m) => m.id);

  const [history, appointmentRows, messageRows] = await Promise.all([
    matterIds.length
      ? db
          .select({
            matterId: matterStatusEvents.matterId,
            stage: matterStatusEvents.stage,
            notes: matterStatusEvents.notes,
            occurredAt: matterStatusEvents.occurredAt,
          })
          .from(matterStatusEvents)
          .where(inArray(matterStatusEvents.matterId, matterIds))
          .orderBy(matterStatusEvents.occurredAt)
      : Promise.resolve([]),
    matterIds.length
      ? db
          .select({
            startsAt: appointments.startsAt,
            endsAt: appointments.endsAt,
            location: appointments.location,
            title: appointments.title,
            state: appointments.state,
          })
          .from(appointments)
          .where(inArray(appointments.matterId, matterIds))
          .orderBy(appointments.startsAt)
      : Promise.resolve([]),
    matterIds.length
      ? db
          .select({
            subject: messages.subject,
            body: messages.bodyRendered,
            toEmail: messages.toEmail,
            state: messages.state,
            sentAt: messages.sentAt,
          })
          .from(messages)
          .where(inArray(messages.matterId, matterIds))
          .orderBy(messages.createdAt)
      : Promise.resolve([]),
  ]);

  await audit({
    action: AUDIT_ACTIONS.CLIENT_DATA_EXPORT,
    actorUserId: params.actor.id,
    actorEmail: params.actor.email,
    entityType: 'client',
    entityId: client.id,
    metadata: {
      matters: clientMatters.length,
      appointments: appointmentRows.length,
      messages: messageRows.length,
    },
  });

  return {
    generatedAt: new Date().toISOString(),
    client: {
      id: client.id,
      fullName: client.fullName,
      email: client.email,
      phone: client.phone,
      idNumber: await safeDecrypt(client.idNumberEncrypted),
      notes: client.notes,
      createdAt: client.createdAt.toISOString(),
      erasedAt: client.erasedAt?.toISOString() ?? null,
    },
    matters: clientMatters.map((matter) => ({
      reference: matter.reference,
      title: matter.title,
      practiceArea: matter.practiceArea,
      office: matter.office,
      status: matter.status,
      openedAt: matter.openedAt.toISOString(),
      closedAt: matter.closedAt?.toISOString() ?? null,
      statusHistory: history
        .filter((event) => event.matterId === matter.id)
        .map((event) => ({
          stage: event.stage,
          occurredAt: event.occurredAt.toISOString(),
          notes: event.notes,
        })),
    })),
    appointments: appointmentRows.map((row) => ({
      startsAt: row.startsAt.toISOString(),
      endsAt: row.endsAt.toISOString(),
      location: row.location,
      title: row.title,
      state: row.state,
    })),
    messages: messageRows.map((row) => ({
      subject: row.subject,
      body: row.body,
      toEmail: row.toEmail,
      state: row.state,
      sentAt: row.sentAt?.toISOString() ?? null,
    })),
  };
}

/**
 * An identity number that will not decrypt is reported as absent rather than
 * failing the export. A subject request answered late because one field was
 * encrypted under a rotated key is a worse outcome than one field missing, and
 * the gap is visible in the document.
 */
async function safeDecrypt(payload: string | null): Promise<string | null> {
  if (!payload) return null;
  try {
    return await decryptField(payload);
  } catch {
    return null;
  }
}

export interface EraseResult {
  clientId: string;
  messagesRedacted: number;
  appointmentsRedacted: number;
}

/** Stands in the erased fields so a reader knows the gap is intentional. */
const TOMBSTONE = '[erased at the data subject’s request]';

export async function eraseClientData(params: {
  actor: Actor;
  clientId: string;
  /** The firm's own reference for the request. Recorded, never a free-text leak. */
  requestReference: string;
}): Promise<EraseResult | null> {
  const [client] = await db
    .select({ id: clients.id, erasedAt: clients.erasedAt })
    .from(clients)
    .where(eq(clients.id, params.clientId))
    .limit(1);

  if (!client) return null;

  const clientMatters = await db
    .select({ id: matters.id })
    .from(matters)
    .where(eq(matters.clientId, client.id));
  const matterIds = clientMatters.map((m) => m.id);

  // The body of a milestone email names the client and quotes their matter.
  // Leaving those behind would make the erasure cosmetic.
  const messagesRedacted = matterIds.length
    ? (
        await db
          .update(messages)
          .set({ bodyRendered: TOMBSTONE, subject: TOMBSTONE, toEmail: TOMBSTONE })
          .where(inArray(messages.matterId, matterIds))
          .returning({ id: messages.id })
      ).length
    : 0;

  const appointmentsRedacted = matterIds.length
    ? (
        await db
          .update(appointments)
          .set({ clientEmail: null, clientName: TOMBSTONE })
          .where(inArray(appointments.matterId, matterIds))
          .returning({ id: appointments.id })
      ).length
    : 0;

  await db
    .update(clients)
    .set({
      fullName: TOMBSTONE,
      email: null,
      phone: null,
      idNumberEncrypted: null,
      notes: null,
      erasedAt: new Date(),
    })
    .where(eq(clients.id, client.id));

  await audit({
    action: AUDIT_ACTIONS.CLIENT_DATA_ERASE,
    actorUserId: params.actor.id,
    actorEmail: params.actor.email,
    entityType: 'client',
    entityId: client.id,
    metadata: {
      requestReference: params.requestReference.slice(0, 120),
      matters: matterIds.length,
      messagesRedacted,
      appointmentsRedacted,
      // Re-erasing an already-erased client is harmless but worth recording.
      alreadyErased: client.erasedAt !== null,
    },
  });

  return { clientId: client.id, messagesRedacted, appointmentsRedacted };
}

/** Clients a request can name. Erased ones stay listed so the state is visible. */
export async function searchClients(term: string, limit = 20) {
  const needle = `%${term.trim()}%`;
  return db
    .select({
      id: clients.id,
      fullName: clients.fullName,
      email: clients.email,
      erasedAt: clients.erasedAt,
    })
    .from(clients)
    .where(
      term.trim()
        ? or(sql`${clients.fullName} ilike ${needle}`, sql`${clients.email} ilike ${needle}`)
        : isNull(clients.erasedAt),
    )
    .orderBy(clients.fullName)
    .limit(limit);
}

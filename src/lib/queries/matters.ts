import 'server-only';
import { and, desc, eq, ilike, or, sql, type SQL } from 'drizzle-orm';
import { db } from '@/lib/db/client';
import {
  appointments,
  clients,
  documentVersions,
  documents,
  matterParticipants,
  matterStatusEvents,
  matters,
  messages,
  procedureStages,
  users,
} from '@/lib/db/schema';
import {
  canReadMatterContents,
  getAuthorisedMatter,
  matterScopeFilter,
  grantedScope,
  type Actor,
} from '@/lib/auth/guard';
import { PERMISSIONS } from '@/lib/auth/permissions';
import { maskEmail, maskName, maskPhone } from '@/lib/security/crypto';

/**
 * Matter read models (FR-8.2).
 *
 * Every function takes an `Actor` and applies scope itself. Two behaviours
 * here are load-bearing:
 *
 *  - **Index scope** (practice manager) gets reference, status and dates but
 *    never client identifiers or document contents.
 *  - **Masking roles** (pupils) get identifiers redacted *here*, server-side at
 *    query time, so a masked value never reaches the client — not even in a
 *    payload the UI chooses not to render (PRD §2.2).
 */

export interface MatterListRow {
  id: string;
  reference: string;
  title: string;
  practiceArea: string;
  office: string;
  status: string;
  clientName: string;
  assignedName: string | null;
  openedAt: Date;
  latestStage: string | null;
}

export async function listMatters(
  actor: Actor,
  options: { search?: string; status?: string; limit?: number } = {},
): Promise<MatterListRow[]> {
  const scope = matterScopeFilter(actor, PERMISSIONS.MATTER_VIEW);
  const indexOnly = grantedScope(actor, PERMISSIONS.MATTER_VIEW) === 'index';

  const filters: SQL[] = [];
  if (scope) filters.push(scope);
  if (options.status) filters.push(eq(matters.status, options.status as 'open'));
  if (options.search) {
    const term = `%${options.search}%`;
    const match = or(
      ilike(matters.reference, term),
      ilike(matters.title, term),
      // Index scope may search by reference and title but not by client name,
      // since it may not see client identity at all.
      ...(indexOnly ? [] : [ilike(clients.fullName, term)]),
    );
    if (match) filters.push(match);
  }

  const rows = await db
    .select({
      id: matters.id,
      reference: matters.reference,
      title: matters.title,
      practiceArea: matters.practiceArea,
      office: matters.office,
      status: matters.status,
      clientName: clients.fullName,
      assignedName: users.fullName,
      openedAt: matters.openedAt,
      latestStage: sql<string | null>`(
        select e.stage from matter_status_events e
        where e.matter_id = ${matters.id}
        order by e.occurred_at desc limit 1
      )`,
    })
    .from(matters)
    .innerJoin(clients, eq(clients.id, matters.clientId))
    .leftJoin(users, eq(users.id, matters.assignedUserId))
    .where(filters.length > 0 ? and(...filters) : undefined)
    .orderBy(desc(matters.openedAt))
    .limit(options.limit ?? 100);

  return rows.map((row) => ({
    ...row,
    clientName: indexOnly
      ? '—'
      : actor.masksClientIdentifiers
        ? maskName(row.clientName)
        : row.clientName,
  }));
}

export interface MatterDetail {
  id: string;
  reference: string;
  title: string;
  practiceArea: string;
  office: string;
  status: string;
  commsHold: boolean;
  openedAt: Date;
  closedAt: Date | null;
  client: { name: string; email: string | null; phone: string | null; notes: string | null };
  assignedName: string | null;
  supervisingName: string | null;
  canReadContents: boolean;
}

export async function getMatterDetail(
  actor: Actor,
  matterId: string,
): Promise<MatterDetail | null> {
  const authorised = await getAuthorisedMatter(actor, matterId);
  if (!authorised) return null;

  const [row] = await db
    .select({
      id: matters.id,
      reference: matters.reference,
      title: matters.title,
      practiceArea: matters.practiceArea,
      office: matters.office,
      status: matters.status,
      commsHold: matters.commsHold,
      openedAt: matters.openedAt,
      closedAt: matters.closedAt,
      clientName: clients.fullName,
      clientEmail: clients.email,
      clientPhone: clients.phone,
      clientNotes: clients.notes,
      assignedUserId: matters.assignedUserId,
      supervisingUserId: matters.supervisingUserId,
    })
    .from(matters)
    .innerJoin(clients, eq(clients.id, matters.clientId))
    .where(eq(matters.id, matterId))
    .limit(1);

  if (!row) return null;

  const names = await db
    .select({ id: users.id, fullName: users.fullName })
    .from(users)
    .where(
      or(
        row.assignedUserId ? eq(users.id, row.assignedUserId) : sql`false`,
        row.supervisingUserId ? eq(users.id, row.supervisingUserId) : sql`false`,
      ),
    );
  const nameOf = (id: string | null) => names.find((n) => n.id === id)?.fullName ?? null;

  const readContents = canReadMatterContents(actor, authorised);
  const mask = actor.masksClientIdentifiers;
  const indexOnly = grantedScope(actor, PERMISSIONS.MATTER_VIEW) === 'index';

  return {
    id: row.id,
    reference: row.reference,
    title: row.title,
    practiceArea: row.practiceArea,
    office: row.office,
    status: row.status,
    commsHold: row.commsHold,
    openedAt: row.openedAt,
    closedAt: row.closedAt,
    client: {
      name: indexOnly ? '—' : mask ? maskName(row.clientName) : row.clientName,
      email:
        indexOnly || !row.clientEmail ? null : mask ? maskEmail(row.clientEmail) : row.clientEmail,
      phone:
        indexOnly || !row.clientPhone ? null : mask ? maskPhone(row.clientPhone) : row.clientPhone,
      notes: indexOnly || !readContents ? null : row.clientNotes,
    },
    assignedName: nameOf(row.assignedUserId),
    supervisingName: nameOf(row.supervisingUserId),
    canReadContents: readContents,
  };
}

export async function matterTimeline(actor: Actor, matterId: string) {
  const authorised = await getAuthorisedMatter(actor, matterId);
  if (!authorised) return [];

  return (
    db
      .select({
        id: matterStatusEvents.id,
        stage: matterStatusEvents.stage,
        label: procedureStages.label,
        notes: matterStatusEvents.notes,
        suppressed: matterStatusEvents.suppressed,
        occurredAt: matterStatusEvents.occurredAt,
        recordedBy: users.fullName,
      })
      .from(matterStatusEvents)
      // `matters` must be joined before procedure_stages, because the stage join
      // condition reads matters.practice_area. Joining it afterwards produced
      // "missing FROM-clause entry for table matters" (42P01) and broke the
      // whole matter page — SQL resolves joins in order, unlike the object graph
      // this reads like.
      .innerJoin(matters, eq(matters.id, matterStatusEvents.matterId))
      .leftJoin(users, eq(users.id, matterStatusEvents.recordedByUserId))
      .leftJoin(
        procedureStages,
        and(
          eq(procedureStages.key, matterStatusEvents.stage),
          eq(procedureStages.practiceArea, matters.practiceArea),
        ),
      )
      .where(eq(matterStatusEvents.matterId, matterId))
      .orderBy(desc(matterStatusEvents.occurredAt))
      .limit(100)
  );
}

export async function matterDocuments(actor: Actor, matterId: string) {
  const authorised = await getAuthorisedMatter(actor, matterId);
  if (!authorised || !canReadMatterContents(actor, authorised)) return [];

  return db
    .select({
      id: documents.id,
      title: documents.title,
      state: documents.state,
      currentVersionId: documents.currentVersionId,
      updatedAt: documents.updatedAt,
      versionCount: sql<number>`(
        select count(*)::int from document_versions v where v.document_id = ${documents.id}
      )`,
    })
    .from(documents)
    .where(eq(documents.matterId, matterId))
    .orderBy(desc(documents.updatedAt));
}

export async function documentVersionList(actor: Actor, documentId: string) {
  const [doc] = await db
    .select({ matterId: documents.matterId })
    .from(documents)
    .where(eq(documents.id, documentId))
    .limit(1);
  if (!doc) return null;

  const authorised = await getAuthorisedMatter(actor, doc.matterId);
  if (!authorised || !canReadMatterContents(actor, authorised)) return null;

  const versions = await db
    .select({
      id: documentVersions.id,
      versionNo: documentVersions.versionNo,
      generatedBy: documentVersions.generatedBy,
      modelVersion: documentVersions.modelVersion,
      promptHash: documentVersions.promptHash,
      changeSummary: documentVersions.changeSummary,
      citedChunkIds: documentVersions.citedChunkIds,
      generationInputs: documentVersions.generationInputs,
      createdAt: documentVersions.createdAt,
      createdBy: users.fullName,
    })
    .from(documentVersions)
    .leftJoin(users, eq(users.id, documentVersions.createdByUserId))
    .where(eq(documentVersions.documentId, documentId))
    .orderBy(desc(documentVersions.versionNo));

  return { matterId: doc.matterId, versions };
}

export async function matterAppointments(actor: Actor, matterId: string) {
  const authorised = await getAuthorisedMatter(actor, matterId);
  if (!authorised) return [];

  return db
    .select({
      id: appointments.id,
      startsAt: appointments.startsAt,
      endsAt: appointments.endsAt,
      location: appointments.location,
      state: appointments.state,
      icsSequence: appointments.icsSequence,
      lawyerName: users.fullName,
    })
    .from(appointments)
    .leftJoin(users, eq(users.id, appointments.userId))
    .where(eq(appointments.matterId, matterId))
    .orderBy(desc(appointments.startsAt));
}

export async function matterMessages(actor: Actor, matterId: string) {
  const authorised = await getAuthorisedMatter(actor, matterId);
  if (!authorised || !canReadMatterContents(actor, authorised)) return [];

  return db
    .select({
      id: messages.id,
      subject: messages.subject,
      toEmail: messages.toEmail,
      state: messages.state,
      templateKey: messages.templateKey,
      sentAt: messages.sentAt,
      deliveredAt: messages.deliveredAt,
      error: messages.error,
      createdAt: messages.createdAt,
    })
    .from(messages)
    .where(eq(messages.matterId, matterId))
    .orderBy(desc(messages.createdAt))
    .limit(50);
}

export async function matterParticipantList(actor: Actor, matterId: string) {
  const authorised = await getAuthorisedMatter(actor, matterId);
  if (!authorised) return [];

  return db
    .select({
      userId: matterParticipants.userId,
      role: matterParticipants.role,
      name: users.fullName,
    })
    .from(matterParticipants)
    .innerJoin(users, eq(users.id, matterParticipants.userId))
    .where(eq(matterParticipants.matterId, matterId));
}

/** Stages configured for a matter's practice area, for the status recorder. */
export async function stagesForMatter(matterId: string) {
  return db
    .select({
      key: procedureStages.key,
      label: procedureStages.label,
      sortOrder: procedureStages.sortOrder,
      hasTemplate: sql<boolean>`${procedureStages.messageTemplateKey} is not null`,
    })
    .from(procedureStages)
    .innerJoin(matters, eq(matters.practiceArea, procedureStages.practiceArea))
    .where(and(eq(matters.id, matterId), eq(procedureStages.isActive, true)))
    .orderBy(procedureStages.sortOrder);
}

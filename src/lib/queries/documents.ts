import 'server-only';
import { and, eq } from 'drizzle-orm';
import { db } from '@/lib/db/client';
import { documentTemplates, documentVersions, documents, type PracticeArea } from '@/lib/db/schema';
import { canReadMatterContents, getAuthorisedMatter, type Actor } from '@/lib/auth/guard';
import { presignedDownloadUrl } from '@/lib/storage/s3';
import { audit, AUDIT_ACTIONS } from '@/lib/audit/log';

/**
 * Authorised, audited access to a stored document version.
 *
 * Returns null both when the version does not exist and when the actor may not
 * read it, so the caller cannot distinguish the two (IDOR hardening).
 */
export async function downloadUrlForVersion(params: {
  actor: Actor;
  documentId: string;
  versionNo: number;
  ip?: string | null;
  userAgent?: string | null;
}): Promise<string | null> {
  const [row] = await db
    .select({
      versionId: documentVersions.id,
      storageKey: documentVersions.storageKey,
      matterId: documents.matterId,
      title: documents.title,
    })
    .from(documentVersions)
    .innerJoin(documents, eq(documents.id, documentVersions.documentId))
    .where(
      and(
        eq(documentVersions.documentId, params.documentId),
        eq(documentVersions.versionNo, params.versionNo),
      ),
    )
    .limit(1);

  if (!row) return null;

  const matter = await getAuthorisedMatter(params.actor, row.matterId);
  if (!matter || !canReadMatterContents(params.actor, matter)) return null;

  // FR-1.8: document download is an audited event.
  await audit({
    action: AUDIT_ACTIONS.DOCUMENT_DOWNLOAD,
    actorUserId: params.actor.id,
    actorEmail: params.actor.email,
    entityType: 'document_version',
    entityId: row.versionId,
    matterId: row.matterId,
    metadata: { documentId: params.documentId, versionNo: params.versionNo },
    ip: params.ip ?? null,
    userAgent: params.userAgent ?? null,
  });

  const filename = `${row.title} v${params.versionNo}.docx`.replace(/[\\/:*?"<>|]/g, '_');

  return presignedDownloadUrl({ key: row.storageKey, downloadFilename: filename });
}

/** Document header for the document screen. */
export async function getDocumentHeader(actor: Actor, documentId: string) {
  const [row] = await db
    .select({
      id: documents.id,
      matterId: documents.matterId,
      title: documents.title,
      state: documents.state,
      currentVersionId: documents.currentVersionId,
      finalisedAt: documents.finalisedAt,
    })
    .from(documents)
    .where(eq(documents.id, documentId))
    .limit(1);

  if (!row) return null;

  const matter = await getAuthorisedMatter(actor, row.matterId);
  if (!matter || !canReadMatterContents(actor, matter)) return null;

  return row;
}

/** Active precedent templates for a practice area (FR-4.1). */
export async function activeTemplatesFor(practiceArea: PracticeArea) {
  return db
    .select({ id: documentTemplates.id, name: documentTemplates.name })
    .from(documentTemplates)
    .where(
      and(eq(documentTemplates.isActive, true), eq(documentTemplates.practiceArea, practiceArea)),
    )
    .orderBy(documentTemplates.name);
}

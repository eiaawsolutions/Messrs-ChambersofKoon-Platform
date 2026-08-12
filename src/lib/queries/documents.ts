import 'server-only';
import { and, eq } from 'drizzle-orm';
import { db } from '@/lib/db/client';
import {
  documentTemplates,
  documentVersions,
  documents,
  users,
  type PracticeArea,
} from '@/lib/db/schema';
import { canReadMatterContents, getAuthorisedMatter, type Actor } from '@/lib/auth/guard';
import { getObject, presignedDownloadUrl } from '@/lib/storage/s3';
import { audit, AUDIT_ACTIONS } from '@/lib/audit/log';
import { aiShare, buildDraftPreview, type DraftPreview } from '@/lib/documents/preview';

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

export interface VersionPreview {
  documentId: string;
  documentTitle: string;
  matterId: string;
  versionId: string;
  versionNo: number;
  generatedBy: 'ai' | 'human';
  modelVersion: string | null;
  promptHash: string | null;
  createdAt: Date;
  createdBy: string | null;
  changeSummary: string | null;
  citedChunkCount: number;
  missingDeterministic: string[];
  isCurrent: boolean;
  preview: DraftPreview;
}

/**
 * The on-screen, colour-coded reading of a stored version (FR-4.4).
 *
 * Authorised and audited on exactly the same terms as the download it stands
 * beside: reading the draft on screen is reading the matter's contents, and it
 * is recorded as such. Returns null both when the version does not exist and
 * when the actor may not read it, so the two are indistinguishable to a caller
 * probing for ids (IDOR hardening).
 */
export async function previewForVersion(params: {
  actor: Actor;
  documentId: string;
  versionNo: number;
  ip?: string | null;
  userAgent?: string | null;
}): Promise<VersionPreview | null> {
  const [row] = await db
    .select({
      versionId: documentVersions.id,
      versionNo: documentVersions.versionNo,
      storageKey: documentVersions.storageKey,
      aiBlocks: documentVersions.aiBlocks,
      generatedBy: documentVersions.generatedBy,
      modelVersion: documentVersions.modelVersion,
      promptHash: documentVersions.promptHash,
      generationInputs: documentVersions.generationInputs,
      citedChunkIds: documentVersions.citedChunkIds,
      changeSummary: documentVersions.changeSummary,
      createdAt: documentVersions.createdAt,
      createdBy: users.fullName,
      documentId: documents.id,
      documentTitle: documents.title,
      matterId: documents.matterId,
      currentVersionId: documents.currentVersionId,
    })
    .from(documentVersions)
    .innerJoin(documents, eq(documents.id, documentVersions.documentId))
    .leftJoin(users, eq(users.id, documentVersions.createdByUserId))
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

  // A stored object that cannot be fetched or parsed produces an unreadable
  // preview, not a 500. The lawyer is told the file could not be rendered and
  // can still download it.
  let preview: DraftPreview;
  try {
    const buffer = await getObject(row.storageKey);
    preview = buildDraftPreview({ docxBuffer: buffer, aiBlocks: row.aiBlocks });
  } catch {
    preview = buildDraftPreview({ docxBuffer: Buffer.alloc(0), aiBlocks: row.aiBlocks });
  }

  await audit({
    action: AUDIT_ACTIONS.DOCUMENT_VIEW,
    actorUserId: params.actor.id,
    actorEmail: params.actor.email,
    entityType: 'document_version',
    entityId: row.versionId,
    matterId: row.matterId,
    metadata: {
      documentId: params.documentId,
      versionNo: params.versionNo,
      surface: 'draft_preview',
      aiBlockCount: preview.blocks.length,
      aiSharePercent: aiShare(preview),
    },
    ip: params.ip ?? null,
    userAgent: params.userAgent ?? null,
  });

  const inputs = row.generationInputs as { missingDeterministic?: string[] };

  return {
    documentId: row.documentId,
    documentTitle: row.documentTitle,
    matterId: row.matterId,
    versionId: row.versionId,
    versionNo: row.versionNo,
    generatedBy: row.generatedBy,
    modelVersion: row.modelVersion,
    promptHash: row.promptHash,
    createdAt: row.createdAt,
    createdBy: row.createdBy,
    changeSummary: row.changeSummary,
    citedChunkCount: row.citedChunkIds?.length ?? 0,
    missingDeterministic: Array.isArray(inputs.missingDeterministic)
      ? inputs.missingDeterministic
      : [],
    isCurrent: row.currentVersionId === row.versionId,
    preview,
  };
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

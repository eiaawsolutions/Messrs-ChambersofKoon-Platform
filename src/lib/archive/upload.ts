import 'server-only';
import { desc, eq, sql } from 'drizzle-orm';
import { db } from '@/lib/db/client';
import { archiveFiles, matters, type PracticeArea } from '@/lib/db/schema';
import { putObject, storageKey } from '@/lib/storage/s3';
import { sha256 } from '@/lib/security/crypto';
import { enqueue, JOBS } from '@/lib/jobs/queue';
import { audit, AUDIT_ACTIONS } from '@/lib/audit/log';
import { getAuthorisedMatter, type Actor } from '@/lib/auth/guard';
import { PERMISSIONS } from '@/lib/auth/permissions';

/**
 * Archive ingest entry point (FR-5.1 – FR-5.6).
 *
 * Idempotency is by content hash (FR-5.6): the same bytes uploaded twice
 * return the existing row rather than creating a second one, so re-running a
 * partially failed 200-file batch is safe and produces no duplicate chunks.
 */

export interface IngestResult {
  id: string;
  filename: string;
  status: 'queued' | 'duplicate';
  ocrState: string;
}

export async function ingestUpload(params: {
  actor: Actor;
  filename: string;
  mimeType: string;
  bytes: Buffer;
  practiceArea: PracticeArea | null;
  matterId: string | null;
  batchId: string | null;
  ip?: string | null;
  userAgent?: string | null;
}): Promise<IngestResult> {
  // A file may only be attached to a matter the uploader can already open.
  if (params.matterId) {
    const matter = await getAuthorisedMatter(
      params.actor,
      params.matterId,
      PERMISSIONS.ARCHIVE_UPLOAD,
    );
    if (!matter) throw new Error('Not authorised for that matter');
  }

  const contentHash = sha256(params.bytes);

  const [existing] = await db
    .select({ id: archiveFiles.id, ocrState: archiveFiles.ocrState })
    .from(archiveFiles)
    .where(eq(archiveFiles.contentHash, contentHash))
    .limit(1);

  if (existing) {
    return {
      id: existing.id,
      filename: params.filename,
      status: 'duplicate',
      ocrState: existing.ocrState,
    };
  }

  const [row] = await db
    .insert(archiveFiles)
    .values({
      matterId: params.matterId,
      practiceArea: params.practiceArea,
      originalFilename: params.filename.slice(0, 400),
      // Placeholder; replaced below once the row id exists so the key cannot
      // be derived from a user-supplied name alone.
      storageKey: `pending/${contentHash}`,
      mimeType: params.mimeType,
      byteSize: params.bytes.byteLength,
      contentHash,
      ocrState: 'pending',
      uploadedByUserId: params.actor.id,
      batchId: params.batchId,
    })
    .returning({ id: archiveFiles.id });

  if (!row) throw new Error('Could not record the upload');

  const key = storageKey({
    kind: 'archive',
    matterId: params.matterId,
    id: row.id,
    filename: params.filename,
  });

  await putObject({ key, body: params.bytes, contentType: params.mimeType });
  await db.update(archiveFiles).set({ storageKey: key }).where(eq(archiveFiles.id, row.id));

  await audit({
    action: AUDIT_ACTIONS.ARCHIVE_UPLOAD,
    actorUserId: params.actor.id,
    actorEmail: params.actor.email,
    entityType: 'archive_file',
    entityId: row.id,
    matterId: params.matterId,
    metadata: {
      filename: params.filename,
      mimeType: params.mimeType,
      bytes: params.bytes.byteLength,
      batchId: params.batchId,
    },
    ip: params.ip ?? null,
    userAgent: params.userAgent ?? null,
  });

  await enqueue(
    JOBS.EXTRACT_TEXT,
    { archiveFileId: row.id },
    { singletonKey: `extract-${row.id}` },
  );

  return { id: row.id, filename: params.filename, status: 'queued', ocrState: 'pending' };
}

/** Queue view for the upload screen (FR-5.1 per-file status). */
export async function recentUploads(actor: Actor, limit = 60) {
  return db
    .select({
      id: archiveFiles.id,
      filename: archiveFiles.originalFilename,
      ocrState: archiveFiles.ocrState,
      ocrError: archiveFiles.ocrError,
      ocrAttempts: archiveFiles.ocrAttempts,
      pageCount: archiveFiles.pageCount,
      practiceArea: archiveFiles.practiceArea,
      matterReference: matters.reference,
      createdAt: archiveFiles.createdAt,
      chunkCount: sql<number>`(
        select count(*)::int from chunks c
        where c.source_type = 'archive_file' and c.source_id = ${archiveFiles.id}
      )`,
    })
    .from(archiveFiles)
    .leftJoin(matters, eq(matters.id, archiveFiles.matterId))
    .where(
      // Uploaders see their own batches; anyone who may view all matters sees
      // everything, which is what the review queue needs.
      actor.grants[PERMISSIONS.MATTER_VIEW] === 'all'
        ? sql`true`
        : eq(archiveFiles.uploadedByUserId, actor.id),
    )
    .orderBy(desc(archiveFiles.createdAt))
    .limit(limit);
}

/** FR-5.3: retry a failed extraction from the UI. */
export async function retryExtraction(actor: Actor, archiveFileId: string): Promise<boolean> {
  const [file] = await db
    .select({
      id: archiveFiles.id,
      matterId: archiveFiles.matterId,
      uploadedBy: archiveFiles.uploadedByUserId,
    })
    .from(archiveFiles)
    .where(eq(archiveFiles.id, archiveFileId))
    .limit(1);

  if (!file) return false;

  const isUploader = file.uploadedBy === actor.id;
  const seesAll = actor.grants[PERMISSIONS.MATTER_VIEW] === 'all';
  if (!isUploader && !seesAll) return false;

  await db
    .update(archiveFiles)
    .set({ ocrState: 'pending', ocrError: null })
    .where(eq(archiveFiles.id, archiveFileId));

  await enqueue(
    JOBS.EXTRACT_TEXT,
    { archiveFileId },
    { singletonKey: `extract-${archiveFileId}-${Date.now()}` },
  );

  return true;
}

import 'server-only';
import { and, desc, eq } from 'drizzle-orm';
import PizZip from 'pizzip';
import { db } from '@/lib/db/client';
import { documentVersions, documents, draftEditSignals } from '@/lib/db/schema';
import { putObject, storageKey } from '@/lib/storage/s3';
import { buildDraftPreview } from '@/lib/documents/preview';
import { detectEditedBlocks } from '@/lib/documents/edit-signal';
import { audit, AUDIT_ACTIONS } from '@/lib/audit/log';
import type { Actor } from '@/lib/auth/guard';

/**
 * A lawyer's own revision, recorded as the next version (FR-4.6).
 *
 * The drafting loop is: generate v1 → download → amend in Word → upload the
 * amended file back. Until now the last step had nowhere to go, so a lawyer's
 * edits lived on their desktop and the platform's version history recorded
 * only what the model had produced. That is the wrong way round — the version
 * a client eventually receives is the lawyer's, and it is the one that has to
 * be in the record.
 *
 * A revision is never a generation. `generatedBy` is 'human', no model or
 * prompt hash is recorded, and no AI blocks are stored: the platform did not
 * write this text and does not claim to know which parts changed. What it
 * records is who uploaded it, when, and the note they gave.
 */

/** Word's own limit is far higher; this is about what a pleading can plausibly be. */
const MAX_BYTES = 25 * 1024 * 1024;

const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

/**
 * Rejection reasons are a closed set with stable codes. The action passes the
 * code through the URL and the page renders its own text — nothing the caller
 * supplied is ever reflected back onto the page.
 */
export const REVISION_ERRORS = {
  empty: 'That file is empty.',
  too_large: 'That file exceeds 25 MB.',
  not_docx: 'That file is not a Word document. Upload the .docx you edited in Word.',
  unreadable: 'That file could not be read as a Word document.',
  not_found: 'Document not found on this matter.',
  finalised: 'This document has been finalised. Reopen it before uploading a revision.',
  no_draft: 'Generate the first draft before uploading a revision.',
  no_file: 'Choose the .docx you edited before uploading.',
} as const;

export type RevisionErrorCode = keyof typeof REVISION_ERRORS;

export class RevisionRejected extends Error {
  constructor(readonly code: RevisionErrorCode) {
    super(REVISION_ERRORS[code]);
    this.name = 'RevisionRejected';
  }
}

export interface ReviseInput {
  actor: Actor;
  documentId: string;
  matterId: string;
  filename: string;
  bytes: Buffer;
  /** The lawyer's description of what they changed. Shown in version history. */
  note: string | null;
}

export interface ReviseResult {
  documentVersionId: string;
  versionNo: number;
}

/**
 * A .docx is a zip. Trusting the browser's Content-Type on an authenticated
 * upload would still let a renamed file through, and this one is handed to
 * docxtemplater and to whoever downloads it next — so the bytes are checked,
 * not the label.
 */
function assertIsDocx(bytes: Buffer): void {
  if (bytes.length < 4 || bytes[0] !== 0x50 || bytes[1] !== 0x4b) {
    throw new RevisionRejected('not_docx');
  }
  try {
    const zip = new PizZip(bytes);
    if (!zip.file('word/document.xml')) {
      throw new RevisionRejected('not_docx');
    }
  } catch (error) {
    if (error instanceof RevisionRejected) throw error;
    throw new RevisionRejected('unreadable');
  }
}

export async function recordRevision(input: ReviseInput): Promise<ReviseResult> {
  if (input.bytes.length === 0) throw new RevisionRejected('empty');
  if (input.bytes.length > MAX_BYTES) throw new RevisionRejected('too_large');
  assertIsDocx(input.bytes);

  const [document] = await db
    .select({
      id: documents.id,
      title: documents.title,
      matterId: documents.matterId,
      state: documents.state,
    })
    .from(documents)
    .where(eq(documents.id, input.documentId))
    .limit(1);

  if (!document || document.matterId !== input.matterId) {
    throw new RevisionRejected('not_found');
  }

  // A finalised document is the firm's position of record. Replacing its
  // contents silently would make the audit trail say a lawyer finalised
  // something other than what is now stored.
  if (document.state === 'final') {
    throw new RevisionRejected('finalised');
  }

  const [previous] = await db
    .select({ versionNo: documentVersions.versionNo })
    .from(documentVersions)
    .where(eq(documentVersions.documentId, document.id))
    .orderBy(desc(documentVersions.versionNo))
    .limit(1);

  if (!previous) {
    throw new RevisionRejected('no_draft');
  }

  const versionNo = previous.versionNo + 1;
  const key = storageKey({
    kind: 'document',
    matterId: document.matterId,
    id: document.id,
    filename: `${document.title} v${versionNo}.docx`,
  });

  await putObject({ key, body: input.bytes, contentType: DOCX_MIME });

  const [version] = await db
    .insert(documentVersions)
    .values({
      documentId: document.id,
      versionNo,
      storageKey: key,
      generatedBy: 'human',
      generationInputs: {
        source: 'lawyer_revision',
        originalFilename: input.filename.slice(0, 200),
        bytes: input.bytes.length,
      },
      changeSummary: input.note?.trim()
        ? input.note.trim().slice(0, 2000)
        : `Revised in Word by ${input.actor.fullName}`,
      createdByUserId: input.actor.id,
    })
    .returning({ id: documentVersions.id });

  if (!version) throw new Error('Could not record the revision');

  await db
    .update(documents)
    .set({ currentVersionId: version.id, state: 'draft' })
    .where(eq(documents.id, document.id));

  const edits = await recordEditSignals({
    actor: input.actor,
    documentId: document.id,
    documentVersionId: version.id,
    bytes: input.bytes,
  });

  await audit({
    action: AUDIT_ACTIONS.DOCUMENT_REVISE,
    actorUserId: input.actor.id,
    actorEmail: input.actor.email,
    entityType: 'document_version',
    entityId: version.id,
    matterId: document.matterId,
    metadata: {
      versionNo,
      originalFilename: input.filename.slice(0, 200),
      bytes: input.bytes.length,
      // The count only. The wording itself is in draft_edit_signals, which is
      // not append-only and can be purged; audit metadata cannot (NFR-4.1).
      aiBlocksEdited: edits,
    },
  });

  return { documentVersionId: version.id, versionNo };
}

/**
 * Capture which of the model's blocks the lawyer rewrote (FR-4.8).
 *
 * Compared against the last version that actually holds AI blocks, not simply
 * the previous one: a lawyer who uploads two revisions in a row would
 * otherwise be compared against their own first revision, which stores no
 * blocks, and every edit after the first would go unrecorded.
 *
 * Never allowed to fail the revision. A lawyer's amended pleading is the
 * document of record; losing it because a prompt-refinement note could not be
 * written would be a poor trade.
 */
async function recordEditSignals(params: {
  actor: Actor;
  documentId: string;
  documentVersionId: string;
  bytes: Buffer;
}): Promise<number> {
  try {
    const [generated] = await db
      .select({ aiBlocks: documentVersions.aiBlocks })
      .from(documentVersions)
      .where(
        and(
          eq(documentVersions.documentId, params.documentId),
          eq(documentVersions.generatedBy, 'ai'),
        ),
      )
      .orderBy(desc(documentVersions.versionNo))
      .limit(1);

    const aiBlocks = generated?.aiBlocks ?? {};
    if (Object.keys(aiBlocks).length === 0) return 0;

    const preview = buildDraftPreview({ docxBuffer: params.bytes, aiBlocks });
    if (!preview.readable) return 0;

    const signals = detectEditedBlocks({
      aiBlocks,
      revisedParagraphs: preview.paragraphs.map((p) =>
        p.segments.map((segment) => segment.text).join(''),
      ),
    });

    if (signals.length === 0) return 0;

    await db.insert(draftEditSignals).values(
      signals.map((signal) => ({
        documentVersionId: params.documentVersionId,
        blockName: signal.blockName.slice(0, 120),
        aiText: signal.aiText,
        editedText: signal.editedText,
        editedByUserId: params.actor.id,
      })),
    );

    return signals.length;
  } catch (error) {
    console.error(
      '[documents] revision %s stored but the edit signal was not: %s',
      params.documentVersionId,
      (error as Error).message,
    );
    return 0;
  }
}

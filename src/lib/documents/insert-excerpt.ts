import 'server-only';
import { desc, eq } from 'drizzle-orm';
import PizZip from 'pizzip';
import { db } from '@/lib/db/client';
import { documentVersions, documents } from '@/lib/db/schema';
import { getObject, putObject, storageKey } from '@/lib/storage/s3';
import { permittedChunk } from '@/lib/rag/retrieve';
import { audit, AUDIT_ACTIONS } from '@/lib/audit/log';
import type { Actor } from '@/lib/auth/guard';

/**
 * Insert a cited precedent excerpt into the current draft (FR-6.5, FR-8.4).
 *
 * The rule the PRD states is "pulls a cited excerpt into the current document
 * with the citation retained", and every word of it is load-bearing:
 *
 * 1. **Excerpt, not summary.** The verbatim archive text is appended. No model
 *    runs here — there is no generation step that could paraphrase the source
 *    into something the file does not say.
 *
 * 2. **Re-read, not reposted.** The text comes from `permittedChunk`, which
 *    re-reads the chunk under the caller's own scope. Nothing the browser sent
 *    but the chunk id reaches the document, so a forged form cannot write
 *    arbitrary text — or another matter's text — into a draft.
 *
 * 3. **Citation travels with it.** Source, locator, matter reference and a
 *    short chunk ref are written into the document itself, and the chunk id is
 *    recorded on the version. The provenance survives the .docx leaving the
 *    platform.
 *
 * A new version is written rather than the current one being edited: the
 * generated draft stays in the record beside the amended one, as with FR-4.6.
 * `generatedBy` is 'human' — a lawyer chose this excerpt, and the platform did
 * not write a word of it.
 *
 * Caveat, deliberate and documented: regenerating a draft re-renders it from
 * the template, so an inserted excerpt is not carried into the next generated
 * version. It stays in the version it was inserted into, which remains
 * downloadable from version history. This is the same trade-off a lawyer's
 * uploaded Word revision already makes.
 */

const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

/**
 * Closed set of rejection reasons, mirroring `REVISION_ERRORS`. The action
 * passes the code through the URL and the page renders its own text — nothing
 * the caller supplied is ever reflected back onto the page.
 */
export const INSERT_ERRORS = {
  not_found: 'That draft is not one you can work on.',
  finalised: 'This document has been finalised. Reopen it before inserting precedent.',
  no_draft: 'Generate the first draft before inserting precedent into it.',
  no_excerpt: 'That excerpt is no longer available to you.',
  unreadable: 'The current version could not be read as a Word document.',
} as const;

export type InsertErrorCode = keyof typeof INSERT_ERRORS;

export class InsertRejected extends Error {
  constructor(readonly code: InsertErrorCode) {
    super(INSERT_ERRORS[code]);
    this.name = 'InsertRejected';
  }
}

// ---------------------------------------------------------------------------
// OOXML
// ---------------------------------------------------------------------------

export interface ExcerptCitation {
  /** Filename where there is one, otherwise the matter reference. */
  source: string;
  /** Page or section within the source document. */
  locator: string | null;
  matterReference: string | null;
  practiceArea: string | null;
  /** Short handle back to the chunk row, so the .docx can be traced to it. */
  ref: string;
  insertedBy: string;
  insertedOn: string;
  /** True when the excerpt was masked for this reader (PRD §2.2). */
  masked: boolean;
}

/** Local rather than shared: a seven-line escape is not worth a module hop. */
function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * Strip characters XML 1.0 cannot carry. Archive material goes through OCR,
 * which occasionally emits them, and one would make the .docx unopenable.
 * Tab, newline and carriage return are legal and are kept.
 */
function sanitise(value: string): string {
  return value.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '');
}

interface RunStyle {
  bold?: boolean;
  italic?: boolean;
  /** Half-points, as OOXML counts them. 22 = 11pt. */
  size?: number;
  colour?: string;
}

function paragraph(text: string, style: RunStyle & { indent?: number } = {}): string {
  const indent = style.indent ? `<w:ind w:left="${style.indent}"/>` : '';
  const rPr =
    `${style.bold ? '<w:b/>' : ''}${style.italic ? '<w:i/>' : ''}` +
    `${style.colour ? `<w:color w:val="${style.colour}"/>` : ''}` +
    `${style.size ? `<w:sz w:val="${style.size}"/>` : ''}`;

  return (
    `<w:p><w:pPr><w:spacing w:before="120" w:after="120"/>${indent}</w:pPr>` +
    `<w:r><w:rPr>${rPr}</w:rPr>` +
    `<w:t xml:space="preserve">${escapeXml(sanitise(text))}</w:t></w:r></w:p>`
  );
}

/** The citation line, assembled so every part that exists is present exactly once. */
export function citationLine(citation: ExcerptCitation): string {
  return [
    `Source: ${citation.source}`,
    citation.locator,
    citation.matterReference ? `matter ${citation.matterReference}` : null,
    citation.practiceArea?.replace(/_/g, ' ') ?? null,
    `inserted by ${citation.insertedBy} on ${citation.insertedOn}`,
    `ref ${citation.ref}`,
    citation.masked ? 'identifiers masked' : null,
  ]
    .filter(Boolean)
    .join(' · ');
}

/**
 * Splice the excerpt into `word/document.xml`.
 *
 * Word requires the body-level `<w:sectPr>` to be the last child of `<w:body>`,
 * so the paragraphs go *before* it rather than before `</w:body>`. Only
 * paragraphs with direct formatting are added — no style references, no
 * numbering — so nothing here depends on the template's styles.xml and the
 * firm's own styles are left exactly as they were (FR-4.3).
 */
export function appendCitedExcerpt(
  docx: Buffer,
  params: { excerpt: string; citation: ExcerptCitation },
): Buffer {
  let zip: PizZip;
  try {
    zip = new PizZip(docx);
  } catch {
    throw new InsertRejected('unreadable');
  }

  const xml = zip.file('word/document.xml')?.asText();
  if (!xml) throw new InsertRejected('unreadable');

  const lines = params.excerpt
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  const fragment =
    paragraph('PRECEDENT EXCERPT — for review. Not part of the draft until you adopt it.', {
      bold: true,
      size: 20,
      colour: '9A7B2F',
    }) +
    (lines.length > 0
      ? lines.map((line) => paragraph(line, { italic: true, indent: 720 })).join('')
      : paragraph('[excerpt was empty]', { italic: true, indent: 720 })) +
    paragraph(citationLine(params.citation), { size: 18, colour: '595959', indent: 720 });

  zip.file('word/document.xml', spliceIntoBody(xml, fragment));

  return zip.generate({ type: 'nodebuffer', compression: 'DEFLATE' }) as Buffer;
}

function spliceIntoBody(xml: string, fragment: string): string {
  const bodyEnd = xml.lastIndexOf('</w:body>');
  if (bodyEnd === -1) throw new InsertRejected('unreadable');

  // `lastIndexOf` finds the final sectPr; the test then confirms it really is
  // the trailing body-level one, and not a section break nested in a paragraph
  // — inserting inside a <w:pPr> would corrupt the document.
  const head = xml.slice(0, bodyEnd);
  const open = head.lastIndexOf('<w:sectPr');
  const trailing =
    open !== -1 && /^<w:sectPr(?:\s[^>]*)?(?:\/>|>[\s\S]*<\/w:sectPr>)\s*$/.test(head.slice(open));

  const at = trailing ? open : bodyEnd;
  return xml.slice(0, at) + fragment + xml.slice(at);
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

export interface InsertInput {
  actor: Actor;
  documentId: string;
  /** Bound by the caller and re-checked here, as in `recordRevision`. */
  matterId: string;
  chunkId: string;
}

export interface InsertResult {
  documentVersionId: string;
  versionNo: number;
  /** Rendered into the confirmation, so the lawyer sees where it landed. */
  source: string;
}

function today(): string {
  return new Intl.DateTimeFormat('en-MY', {
    timeZone: 'Asia/Kuala_Lumpur',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  }).format(new Date());
}

export async function insertCitedExcerpt(input: InsertInput): Promise<InsertResult> {
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
    throw new InsertRejected('not_found');
  }

  // A finalised document is the firm's position of record. Appending research
  // to it would make the audit trail say a lawyer finalised something other
  // than what is now stored.
  if (document.state === 'final') throw new InsertRejected('finalised');

  const [previous] = await db
    .select({
      versionNo: documentVersions.versionNo,
      storageKey: documentVersions.storageKey,
      aiBlocks: documentVersions.aiBlocks,
      citedChunkIds: documentVersions.citedChunkIds,
      generationInputs: documentVersions.generationInputs,
    })
    .from(documentVersions)
    .where(eq(documentVersions.documentId, document.id))
    .orderBy(desc(documentVersions.versionNo))
    .limit(1);

  if (!previous) throw new InsertRejected('no_draft');

  const chunk = await permittedChunk(input.actor, input.chunkId);
  if (!chunk) throw new InsertRejected('no_excerpt');

  const source = chunk.sourceFilename ?? chunk.matterReference ?? 'firm precedent';

  const amended = appendCitedExcerpt(await getObject(previous.storageKey), {
    excerpt: chunk.text,
    citation: {
      source,
      locator: chunk.locator,
      matterReference: chunk.matterReference,
      practiceArea: chunk.practiceArea,
      ref: chunk.chunkId.slice(0, 8),
      insertedBy: input.actor.fullName,
      insertedOn: today(),
      masked: chunk.masked,
    },
  });

  const versionNo = previous.versionNo + 1;
  const key = storageKey({
    kind: 'document',
    matterId: document.matterId,
    id: document.id,
    filename: `${document.title} v${versionNo}.docx`,
  });

  await putObject({ key, body: amended, contentType: DOCX_MIME });

  const [version] = await db
    .insert(documentVersions)
    .values({
      documentId: document.id,
      versionNo,
      storageKey: key,
      // No model ran. The lawyer chose the excerpt and the platform copied it.
      generatedBy: 'human',
      generationInputs: {
        // Carried forward so the "fields could not be filled" checklist on the
        // document page still describes this version — the body is byte-for-byte
        // the previous one plus an appended excerpt, so it remains true.
        ...previous.generationInputs,
        source: 'precedent_insert',
        basedOnVersionNo: previous.versionNo,
        insertedChunkId: chunk.chunkId,
        insertedFrom: source,
        insertedLocator: chunk.locator,
        excerptMasked: chunk.masked,
      },
      // The document still contains the AI text those earlier chunks informed,
      // so their citations carry forward rather than being replaced.
      citedChunkIds: [...new Set([...(previous.citedChunkIds ?? []), chunk.chunkId])],
      aiBlocks: previous.aiBlocks,
      changeSummary: `Inserted a cited excerpt from ${source}${chunk.locator ? `, ${chunk.locator}` : ''}`,
      createdByUserId: input.actor.id,
    })
    .returning({ id: documentVersions.id });

  if (!version) throw new Error('Could not record the inserted excerpt');

  await db
    .update(documents)
    .set({ currentVersionId: version.id, state: 'draft' })
    .where(eq(documents.id, document.id));

  await audit({
    action: AUDIT_ACTIONS.DOCUMENT_PRECEDENT_INSERT,
    actorUserId: input.actor.id,
    actorEmail: input.actor.email,
    entityType: 'document_version',
    entityId: version.id,
    matterId: document.matterId,
    metadata: {
      documentId: document.id,
      versionNo,
      chunkId: chunk.chunkId,
      sourceMatterId: chunk.matterId,
      excerptMasked: chunk.masked,
    },
  });

  return { documentVersionId: version.id, versionNo, source };
}

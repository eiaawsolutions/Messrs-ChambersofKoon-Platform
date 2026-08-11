import 'server-only';
import { and, eq, isNull, sql } from 'drizzle-orm';
import mammoth from 'mammoth';
import { db } from '@/lib/db/client';
import { archiveFiles, chunks } from '@/lib/db/schema';
import { getObject } from '@/lib/storage/s3';
import { chunkText } from '@/lib/rag/chunk';
import { embed, toVectorLiteral } from '@/lib/rag/embed';
import { generateText } from '@/lib/ai/client';
import { OCR_SYSTEM } from '@/lib/ai/prompts';
import { config } from '@/lib/config/env';

/**
 * Archive ingest (M5, FR-5.2 – FR-5.6).
 *
 * Native-text PDFs and DOCX extract directly; scans and images go through
 * Claude vision. Deciding which is which is done by *trying* the cheap path
 * first and measuring what came back — a scanned PDF still parses, it just
 * yields almost no text, and that is the reliable signal.
 *
 * Idempotency (FR-5.6): chunks are deleted and rewritten for the file being
 * processed, and `archive_files.content_hash` is unique, so re-uploading the
 * same bytes cannot duplicate anything.
 */

/** Below this many characters per page, treat the PDF as a scan. */
const NATIVE_TEXT_CHARS_PER_PAGE = 120;

/** Guard against a pathological file consuming the whole vision budget. */
const MAX_OCR_PAGES = 60;

export interface ExtractionResult {
  text: string;
  pageCount: number | null;
  method: 'native_pdf' | 'docx' | 'plain' | 'vision_ocr';
}

async function extractPdf(buffer: Buffer): Promise<{ text: string; pageCount: number }> {
  // unpdf bundles a serverless-safe pdf.js build.
  const { extractText, getDocumentProxy } = await import('unpdf');
  const pdf = await getDocumentProxy(new Uint8Array(buffer));
  const { text, totalPages } = await extractText(pdf, { mergePages: false });

  const pages = Array.isArray(text) ? text : [String(text)];
  // Page markers survive into chunking and become the citation locator.
  const marked = pages.map((page, index) => `[[page:${index + 1}]]\n${page}`).join('\n\n');

  return { text: marked, pageCount: totalPages };
}

async function extractDocx(buffer: Buffer): Promise<string> {
  const result = await mammoth.extractRawText({ buffer });
  return result.value;
}

/** Vision OCR for scans and images (PRD §6.1, vision-capable model). */
async function extractViaVision(params: {
  buffer: Buffer;
  mimeType: string;
  archiveFileId: string;
}): Promise<string> {
  const mediaType = params.mimeType === 'image/png' ? 'image/png' : 'image/jpeg';

  const result = await generateText({
    system: OCR_SYSTEM,
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'image',
            source: {
              type: 'base64',
              media_type: mediaType,
              data: params.buffer.toString('base64'),
            },
          },
          { type: 'text', text: 'Transcribe this page.' },
        ],
      },
    ],
    maxTokens: 8192,
    temperature: 0,
    ctx: { task: 'ocr.extract' },
  });

  const text = result.text.trim();
  return text === '[no text]' ? '' : text;
}

export async function extractArchiveText(archiveFileId: string): Promise<ExtractionResult> {
  const [file] = await db
    .select()
    .from(archiveFiles)
    .where(eq(archiveFiles.id, archiveFileId))
    .limit(1);

  if (!file) throw new Error(`Archive file ${archiveFileId} not found`);
  if (file.ocrState === 'done' && file.extractedText) {
    return {
      text: file.extractedText,
      pageCount: file.pageCount,
      method: 'native_pdf',
    };
  }

  await db
    .update(archiveFiles)
    .set({ ocrState: 'processing', ocrAttempts: file.ocrAttempts + 1 })
    .where(eq(archiveFiles.id, archiveFileId));

  try {
    const buffer = await getObject(file.storageKey);
    let result: ExtractionResult;

    if (file.mimeType === 'application/pdf') {
      const native = await extractPdf(buffer);
      const density = native.text.length / Math.max(native.pageCount, 1);

      if (density >= NATIVE_TEXT_CHARS_PER_PAGE) {
        result = { text: native.text, pageCount: native.pageCount, method: 'native_pdf' };
      } else if (native.pageCount > MAX_OCR_PAGES) {
        // Better to record the little native text we have and flag it than to
        // spend a large vision budget silently.
        throw new Error(
          `Scanned PDF has ${native.pageCount} pages, above the ${MAX_OCR_PAGES}-page OCR limit. ` +
            'Split the file or raise the limit deliberately.',
        );
      } else {
        // A scan. Rendering PDF pages to images requires a rasteriser that is
        // not available in this runtime, so the file is flagged for the
        // dedicated OCR path rather than silently indexed as empty.
        throw new Error(
          'PDF appears to be a scan with no embedded text layer. ' +
            'Re-upload as page images (JPG/PNG), or enable the dedicated OCR service.',
        );
      }
    } else if (
      file.mimeType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' ||
      file.originalFilename.toLowerCase().endsWith('.docx')
    ) {
      result = { text: await extractDocx(buffer), pageCount: null, method: 'docx' };
    } else if (file.mimeType.startsWith('image/')) {
      result = {
        text: await extractViaVision({
          buffer,
          mimeType: file.mimeType,
          archiveFileId,
        }),
        pageCount: 1,
        method: 'vision_ocr',
      };
    } else if (file.mimeType.startsWith('text/')) {
      result = { text: buffer.toString('utf8'), pageCount: null, method: 'plain' };
    } else {
      throw new Error(`Unsupported file type: ${file.mimeType}`);
    }

    await db
      .update(archiveFiles)
      .set({
        extractedText: result.text,
        pageCount: result.pageCount,
        ocrState: 'done',
        ocrError: null,
      })
      .where(eq(archiveFiles.id, archiveFileId));

    return result;
  } catch (error) {
    // FR-5.3: failures are retryable from the UI and never silently dropped.
    await db
      .update(archiveFiles)
      .set({ ocrState: 'failed', ocrError: (error as Error).message })
      .where(eq(archiveFiles.id, archiveFileId));
    throw error;
  }
}

/**
 * Chunk, embed and store (FR-5.5, FR-5.6).
 *
 * Deletes this file's existing chunks first, so a re-run replaces rather than
 * duplicates. The unique index on (source_type, source_id, chunk_index) makes
 * that guarantee structural rather than a matter of care.
 */
export async function embedPendingChunks(archiveFileId: string): Promise<number> {
  const [file] = await db
    .select({
      id: archiveFiles.id,
      matterId: archiveFiles.matterId,
      practiceArea: archiveFiles.practiceArea,
      extractedText: archiveFiles.extractedText,
      createdAt: archiveFiles.createdAt,
    })
    .from(archiveFiles)
    .where(eq(archiveFiles.id, archiveFileId))
    .limit(1);

  if (!file?.extractedText) return 0;

  const pieces = chunkText(file.extractedText);
  if (pieces.length === 0) return 0;

  const { vectors, modelVersion } = await embed(
    pieces.map((p) => p.text),
    'document',
  );

  await db
    .delete(chunks)
    .where(and(eq(chunks.sourceType, 'archive_file'), eq(chunks.sourceId, archiveFileId)));

  // Inserted via raw SQL because the vector column has no drizzle type.
  for (const [index, piece] of pieces.entries()) {
    const vector = vectors[index];
    if (!vector) continue;
    await db.execute(sql`
      insert into chunks (
        source_type, source_id, matter_id, practice_area, chunk_index,
        text, token_count, locator, embedding, embedding_model_version, document_date
      ) values (
        'archive_file', ${archiveFileId}, ${file.matterId}, ${file.practiceArea},
        ${piece.index}, ${piece.text}, ${piece.tokenCount}, ${piece.locator},
        ${toVectorLiteral(vector)}::vector, ${modelVersion}, ${file.createdAt}
      )
      on conflict (source_type, source_id, chunk_index) do update set
        text = excluded.text,
        token_count = excluded.token_count,
        locator = excluded.locator,
        embedding = excluded.embedding,
        embedding_model_version = excluded.embedding_model_version
    `);
  }

  return pieces.length;
}

/** Files that failed and can be retried from the UI (FR-5.3). */
export async function listFailedFiles(limit = 100) {
  return db
    .select({
      id: archiveFiles.id,
      originalFilename: archiveFiles.originalFilename,
      ocrError: archiveFiles.ocrError,
      ocrAttempts: archiveFiles.ocrAttempts,
      createdAt: archiveFiles.createdAt,
    })
    .from(archiveFiles)
    .where(eq(archiveFiles.ocrState, 'failed'))
    .limit(limit);
}

/** Files uploaded without a matter (FR-5.4 review queue). */
export async function listUnassignedFiles(limit = 100) {
  return db
    .select({
      id: archiveFiles.id,
      originalFilename: archiveFiles.originalFilename,
      practiceArea: archiveFiles.practiceArea,
      createdAt: archiveFiles.createdAt,
    })
    .from(archiveFiles)
    .where(isNull(archiveFiles.matterId))
    .limit(limit);
}

export function embeddingDimensions(): number {
  return config().EMBEDDING_DIMENSIONS;
}

import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { requireActor, requestContext } from '@/lib/auth/session';
import { assertCan } from '@/lib/auth/guard';
import { PERMISSIONS } from '@/lib/auth/permissions';
import { ingestUpload } from '@/lib/archive/upload';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Archive upload (FR-5.1, FR-5.2, FR-5.6).
 *
 * One file per request. The client posts files concurrently with a bounded
 * pool, which is what makes a 200-file batch show honest per-file progress —
 * a single multipart request for 200 scans would be one opaque spinner and
 * one all-or-nothing failure.
 *
 * Re-uploading identical bytes is a no-op by content hash, so a retry after a
 * partial batch cannot duplicate anything.
 */

const ACCEPTED = new Set([
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'image/jpeg',
  'image/png',
  'text/plain',
]);

const MAX_BYTES = 50 * 1024 * 1024;

const metaSchema = z.object({
  practiceArea: z
    .enum(['family_matrimonial', 'debt_recovery', 'land_property', 'corporate_disputes', 'general'])
    .optional(),
  matterId: z.string().uuid().optional(),
  batchId: z.string().uuid().optional(),
});

export async function POST(request: NextRequest): Promise<NextResponse> {
  const actor = await requireActor();
  assertCan(actor, PERMISSIONS.ARCHIVE_UPLOAD);

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return NextResponse.json({ error: 'Invalid upload' }, { status: 400 });
  }

  const file = form.get('file');
  if (!(file instanceof File)) {
    return NextResponse.json({ error: 'No file supplied' }, { status: 400 });
  }
  if (file.size === 0) {
    return NextResponse.json({ error: 'File is empty' }, { status: 400 });
  }
  if (file.size > MAX_BYTES) {
    return NextResponse.json({ error: 'File exceeds 50 MB' }, { status: 413 });
  }
  if (!ACCEPTED.has(file.type)) {
    return NextResponse.json(
      { error: `Unsupported type ${file.type || 'unknown'}` },
      { status: 415 },
    );
  }

  const meta = metaSchema.safeParse({
    practiceArea: form.get('practiceArea') || undefined,
    matterId: form.get('matterId') || undefined,
    batchId: form.get('batchId') || undefined,
  });
  if (!meta.success) {
    return NextResponse.json({ error: 'Invalid metadata' }, { status: 400 });
  }

  const ctx = await requestContext();

  try {
    const result = await ingestUpload({
      actor,
      filename: file.name,
      mimeType: file.type,
      bytes: Buffer.from(await file.arrayBuffer()),
      practiceArea: meta.data.practiceArea ?? null,
      matterId: meta.data.matterId ?? null,
      batchId: meta.data.batchId ?? null,
      ip: ctx.ip,
      userAgent: ctx.userAgent,
    });

    return NextResponse.json(result, { headers: { 'cache-control': 'no-store' } });
  } catch (error) {
    const message = (error as Error).message;
    console.error('[archive] upload failed', message);
    return NextResponse.json({ error: 'Upload failed', detail: message }, { status: 500 });
  }
}

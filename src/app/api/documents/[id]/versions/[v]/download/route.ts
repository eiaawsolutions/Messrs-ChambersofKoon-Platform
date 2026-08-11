import { NextResponse, type NextRequest } from 'next/server';
import { requireActor, requestContext } from '@/lib/auth/session';
import { downloadUrlForVersion } from '@/lib/queries/documents';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Presigned download of a document version (FR-4.6, NFR-1.3).
 *
 * The bucket is private and this route never returns a bucket URL directly:
 * it authorises first, audits the access, then mints a URL valid for minutes
 * and redirects to it.
 */
export async function GET(
  request: NextRequest,
  context: { params: Promise<{ id: string; v: string }> },
): Promise<NextResponse> {
  const { id, v } = await context.params;
  const versionNo = Number(v);
  if (!Number.isInteger(versionNo) || versionNo < 1) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  const actor = await requireActor();
  const ctx = await requestContext();

  const url = await downloadUrlForVersion({
    actor,
    documentId: id,
    versionNo,
    ip: ctx.ip,
    userAgent: ctx.userAgent,
  });

  // Same response whether the document does not exist or the actor may not
  // read it — no enumeration.
  if (!url) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  void request;
  return NextResponse.redirect(url, { status: 302 });
}

import { NextResponse, type NextRequest } from 'next/server';
import { requireActor } from '@/lib/auth/session';
import { assertCan } from '@/lib/auth/guard';
import { PERMISSIONS } from '@/lib/auth/permissions';
import { exportClientData } from '@/lib/privacy/subject-request';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * NFR-2.3: everything the firm holds about one client, as a file.
 *
 * JSON rather than CSV. A subject access response is a nested object — matters
 * with their status history, appointments, correspondence — and flattening it
 * into a spreadsheet would either lose the structure or need several files.
 * JSON is also machine-readable, which is what a data portability request
 * actually asks for.
 *
 * The export itself is audited inside `exportClientData`, before the bytes
 * leave: this is a disclosure of a person's entire file, and the firm needs to
 * be able to say who took a copy and when.
 */
export async function GET(request: NextRequest): Promise<NextResponse> {
  const actor = await requireActor();
  assertCan(actor, PERMISSIONS.PRIVACY_MANAGE);

  const clientId = request.nextUrl.searchParams.get('client');
  if (!clientId || !UUID.test(clientId)) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  const bundle = await exportClientData({ actor, clientId });
  if (!bundle) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  const stamp = new Date().toISOString().slice(0, 10);

  return new NextResponse(JSON.stringify(bundle, null, 2), {
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'content-disposition': `attachment; filename="client-data-${clientId}-${stamp}.json"`,
      // A subject access file must not sit in a proxy or a browser cache.
      'cache-control': 'no-store, private',
    },
  });
}

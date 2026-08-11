import { NextResponse, type NextRequest } from 'next/server';
import { requireActor, requestContext } from '@/lib/auth/session';
import { assertCan } from '@/lib/auth/guard';
import { PERMISSIONS } from '@/lib/auth/permissions';
import { auditCsv } from '@/lib/queries/audit';
import { audit, AUDIT_ACTIONS } from '@/lib/audit/log';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** FR-1.7: CSV export of the audit log, itself an audited action. */
export async function GET(request: NextRequest): Promise<NextResponse> {
  const actor = await requireActor();
  assertCan(actor, PERMISSIONS.AUDIT_VIEW);

  const sp = request.nextUrl.searchParams;
  const filters = {
    ...(sp.get('actor') ? { actor: sp.get('actor')! } : {}),
    ...(sp.get('action') ? { action: sp.get('action')! } : {}),
    ...(sp.get('from') ? { from: sp.get('from')! } : {}),
    ...(sp.get('to') ? { to: sp.get('to')! } : {}),
  };

  const csv = await auditCsv(actor, filters);
  const ctx = await requestContext();

  // Exporting the log is itself something a later reviewer will want to see.
  await audit({
    action: AUDIT_ACTIONS.AUDIT_EXPORT,
    actorUserId: actor.id,
    actorEmail: actor.email,
    metadata: { filters, bytes: csv.length },
    ...ctx,
  });

  const stamp = new Date().toISOString().slice(0, 10);

  return new NextResponse(csv, {
    headers: {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': `attachment; filename="audit-log-${stamp}.csv"`,
      'cache-control': 'no-store',
    },
  });
}

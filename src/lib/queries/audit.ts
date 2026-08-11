import 'server-only';
import { and, desc, eq, gte, ilike, lte, or, sql, type SQL } from 'drizzle-orm';
import { db } from '@/lib/db/client';
import { auditEvents, matters, users } from '@/lib/db/schema';
import { grantedScope, type Actor } from '@/lib/auth/guard';
import { PERMISSIONS } from '@/lib/auth/permissions';

/**
 * Audit log reads (FR-1.7).
 *
 * The Managing Partner sees everything; a Partner's `audit.view` is scoped to
 * their own office, which here means events whose actor belongs to that office
 * plus events on matters in it. An event with neither (a failed login from an
 * unknown address, say) is firm-wide and only the Managing Partner sees it —
 * office-scoping a security event to the wrong office would be worse than
 * withholding it.
 */

export interface AuditFilters {
  actor?: string;
  action?: string;
  matterId?: string;
  from?: string;
  to?: string;
}

export interface AuditRow {
  id: string;
  action: string;
  actorEmail: string | null;
  actorName: string | null;
  entityType: string | null;
  entityId: string | null;
  matterReference: string | null;
  metadata: Record<string, unknown>;
  ip: string | null;
  occurredAt: Date;
}

function buildWhere(actor: Actor, filters: AuditFilters): SQL | undefined {
  const scope = grantedScope(actor, PERMISSIONS.AUDIT_VIEW);
  const clauses: SQL[] = [];

  if (scope === 'office') {
    const officeClause = or(
      sql`exists (select 1 from users u where u.id = ${auditEvents.actorUserId} and u.office = ${actor.office})`,
      sql`exists (select 1 from matters m where m.id = ${auditEvents.matterId} and m.office = ${actor.office})`,
    );
    if (officeClause) clauses.push(officeClause);
  }

  if (filters.actor) {
    const term = `%${filters.actor}%`;
    const match = ilike(auditEvents.actorEmail, term);
    if (match) clauses.push(match);
  }
  if (filters.action) clauses.push(eq(auditEvents.action, filters.action));
  if (filters.matterId) clauses.push(eq(auditEvents.matterId, filters.matterId));
  if (filters.from) clauses.push(gte(auditEvents.occurredAt, new Date(filters.from)));
  if (filters.to) {
    // Inclusive of the whole end day.
    const to = new Date(filters.to);
    to.setUTCHours(23, 59, 59, 999);
    clauses.push(lte(auditEvents.occurredAt, to));
  }

  return clauses.length > 0 ? and(...clauses) : undefined;
}

export async function listAuditEvents(
  actor: Actor,
  filters: AuditFilters = {},
  limit = 200,
): Promise<AuditRow[]> {
  if (!grantedScope(actor, PERMISSIONS.AUDIT_VIEW)) return [];

  return db
    .select({
      id: auditEvents.id,
      action: auditEvents.action,
      actorEmail: auditEvents.actorEmail,
      actorName: users.fullName,
      entityType: auditEvents.entityType,
      entityId: auditEvents.entityId,
      matterReference: matters.reference,
      metadata: auditEvents.metadata,
      ip: auditEvents.ip,
      occurredAt: auditEvents.occurredAt,
    })
    .from(auditEvents)
    .leftJoin(users, eq(users.id, auditEvents.actorUserId))
    .leftJoin(matters, eq(matters.id, auditEvents.matterId))
    .where(buildWhere(actor, filters))
    .orderBy(desc(auditEvents.occurredAt))
    .limit(limit);
}

/** Distinct actions present, for the filter dropdown. */
export async function auditActionOptions(actor: Actor): Promise<string[]> {
  if (!grantedScope(actor, PERMISSIONS.AUDIT_VIEW)) return [];
  const rows = await db
    .selectDistinct({ action: auditEvents.action })
    .from(auditEvents)
    .orderBy(auditEvents.action);
  return rows.map((r) => r.action);
}

/** RFC 4180 escaping. Guards against a value breaking the column structure. */
function csvCell(value: unknown): string {
  if (value === null || value === undefined) return '';
  const text = typeof value === 'object' ? JSON.stringify(value) : String(value);
  // A leading =, +, - or @ is interpreted as a formula by spreadsheet software.
  // Prefixing with an apostrophe neutralises it without altering the data.
  const safe = /^[=+\-@\t\r]/.test(text) ? `'${text}` : text;
  return `"${safe.replace(/"/g, '""')}"`;
}

/** FR-1.7: CSV export for the Managing Partner. */
export async function auditCsv(actor: Actor, filters: AuditFilters = {}): Promise<string> {
  const rows = await listAuditEvents(actor, filters, 50_000);

  const header = [
    'occurred_at',
    'action',
    'actor_email',
    'actor_name',
    'entity_type',
    'entity_id',
    'matter_reference',
    'ip',
    'metadata',
  ];

  const lines = [header.join(',')];
  for (const row of rows) {
    lines.push(
      [
        csvCell(row.occurredAt.toISOString()),
        csvCell(row.action),
        csvCell(row.actorEmail),
        csvCell(row.actorName),
        csvCell(row.entityType),
        csvCell(row.entityId),
        csvCell(row.matterReference),
        csvCell(row.ip),
        csvCell(row.metadata),
      ].join(','),
    );
  }

  return lines.join('\r\n');
}

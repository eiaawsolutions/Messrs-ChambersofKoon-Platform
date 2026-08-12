import 'server-only';
import { db } from '@/lib/db/client';
import { auditEvents } from '@/lib/db/schema';

/**
 * Audit event emission (FR-1.7, FR-1.8).
 *
 * The table is append-only at the database level (migration 0002), so this
 * module only ever inserts. Writing an audit row must never break the action
 * it describes — a failed insert is logged to stderr and swallowed, because a
 * lawyer being unable to finalise a document due to a logging hiccup is worse
 * than a gap in the log. The gap is visible; alerting picks it up.
 */

/** The closed set of auditable actions. FR-1.8 lists the mandatory ones. */
export const AUDIT_ACTIONS = {
  LOGIN_SUCCESS: 'auth.login.success',
  LOGIN_FAILURE: 'auth.login.failure',
  LOGIN_DENIED_DOMAIN: 'auth.login.denied_domain',
  LOGOUT: 'auth.logout',
  SESSION_REVOKED: 'auth.session.revoked',
  NEW_DEVICE: 'auth.device.new',

  MATTER_OPEN: 'matter.open',
  MATTER_CREATE: 'matter.create',
  MATTER_UPDATE: 'matter.update',
  MATTER_STATUS_RECORD: 'matter.status.record',
  MATTER_ACCESS_DENIED: 'matter.access.denied',

  DOCUMENT_VIEW: 'document.view',
  DOCUMENT_DOWNLOAD: 'document.download',
  DOCUMENT_GENERATE: 'document.generate',
  /** A lawyer's own amended file, uploaded back as the next version (FR-4.6). */
  DOCUMENT_REVISE: 'document.revise',
  /** A cited precedent excerpt pulled into a draft (FR-6.5). */
  DOCUMENT_PRECEDENT_INSERT: 'document.precedent.insert',
  DOCUMENT_FINALISE: 'document.finalise',
  DOCUMENT_FINALISE_BLOCKED: 'document.finalise.blocked',
  TEMPLATE_UPLOAD: 'document.template.upload',

  ENQUIRY_RECEIVED: 'enquiry.received',
  ENQUIRY_TRIAGED: 'enquiry.triaged',
  ENQUIRY_TRIAGE_OVERRIDE: 'enquiry.triage.override',
  /** FR-2.8: a repeat from one address, or a volume no enquirer produces. */
  ENQUIRY_FLAGGED: 'enquiry.flagged',
  /** A held enquiry judged genuine and put back in the queue. */
  ENQUIRY_RELEASED: 'enquiry.released',

  PROPOSAL_CREATED: 'proposal.created',
  PROPOSAL_ACCEPTED: 'proposal.accepted',
  PROPOSAL_RESCHEDULED: 'proposal.rescheduled',
  PROPOSAL_DECLINED: 'proposal.declined',
  PROPOSAL_EXPIRED: 'proposal.expired',

  ARCHIVE_UPLOAD: 'archive.upload',
  RAG_SEARCH: 'rag.search',

  MESSAGE_SEND: 'message.send',
  /** FR-7.4: a client update deliberately withheld — a hold, not a failure. */
  MESSAGE_SUPPRESSED: 'message.suppressed',
  MESSAGE_BOUNCED: 'message.bounced',

  PERMISSION_CHANGE: 'admin.permission.change',
  USER_CREATE: 'admin.user.create',
  USER_UPDATE: 'admin.user.update',
  USER_SUSPEND: 'admin.user.suspend',
  USER_REACTIVATE: 'admin.user.reactivate',
  USER_2FA_RESET: 'admin.user.2fa_reset',
  AVAILABILITY_CHANGE: 'admin.availability.change',
  FEATURE_FLAG_CHANGE: 'admin.feature.change',
  AUDIT_EXPORT: 'audit.export',

  CLIENT_DATA_EXPORT: 'privacy.client.export',
  CLIENT_DATA_ERASE: 'privacy.client.erase',
  /** NFR-2.2: the nightly sweep, recorded only when it destroyed something. */
  RETENTION_PURGE: 'privacy.retention.purge',
} as const;

export type AuditAction = (typeof AUDIT_ACTIONS)[keyof typeof AUDIT_ACTIONS];

export interface AuditContext {
  actorUserId?: string | null;
  actorEmail?: string | null;
  ip?: string | null;
  userAgent?: string | null;
}

export interface AuditInput extends AuditContext {
  action: AuditAction;
  entityType?: string;
  entityId?: string | null;
  matterId?: string | null;
  metadata?: Record<string, unknown>;
}

/**
 * Keys that must never reach the audit metadata (NFR-4.1: never prompt contents
 * or client identifiers). Stripped defensively rather than trusting call sites.
 */
const REDACTED_KEYS = new Set([
  'password',
  'token',
  'secret',
  'apikey',
  'api_key',
  'authorization',
  'prompt',
  'systemprompt',
  'system_prompt',
  'messages',
  'transcript',
  'idnumber',
  'id_number',
  'icnumber',
  'ic_number',
  'passport',
  'embedding',
  'clientemail',
  'contactemail',
  'contactphone',
]);

export function scrubMetadata(input: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [rawKey, value] of Object.entries(input)) {
    if (REDACTED_KEYS.has(rawKey.toLowerCase().replace(/[^a-z_]/g, ''))) {
      out[rawKey] = '[redacted]';
      continue;
    }
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      out[rawKey] = scrubMetadata(value as Record<string, unknown>);
    } else if (typeof value === 'string' && value.length > 512) {
      out[rawKey] = `${value.slice(0, 512)}…[truncated]`;
    } else {
      out[rawKey] = value;
    }
  }
  return out;
}

export async function audit(input: AuditInput): Promise<void> {
  try {
    await db.insert(auditEvents).values({
      actorUserId: input.actorUserId ?? null,
      actorEmail: input.actorEmail ?? null,
      action: input.action,
      entityType: input.entityType ?? null,
      entityId: input.entityId ?? null,
      matterId: input.matterId ?? null,
      metadata: scrubMetadata(input.metadata ?? {}),
      ip: input.ip ?? null,
      userAgent: input.userAgent ?? null,
    });
  } catch (error) {
    // Never let audit failure break the caller's action.
    console.error('[audit] failed to write event', {
      action: input.action,
      error: (error as Error).message,
    });
  }
}

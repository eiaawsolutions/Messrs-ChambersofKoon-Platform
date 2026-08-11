import {
  boolean,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  time,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';
import { relations, sql } from 'drizzle-orm';

/**
 * Matter Velocity Platform schema — PRD §4.
 *
 * Conventions:
 *  - every table carries id (uuid), created_at, updated_at
 *  - soft references to users use `set null` so audit history survives offboarding
 *  - `chunks.embedding` is a pgvector column declared via raw SQL because
 *    drizzle-orm has no first-class vector type; dimension comes from
 *    EMBEDDING_DIMENSIONS and is asserted by migration 0001.
 */

// ---------------------------------------------------------------------------
// Enums
// ---------------------------------------------------------------------------

export const officeEnum = pgEnum('office', ['KL', 'PJ', 'IPOH']);

export const userStatusEnum = pgEnum('user_status', ['invited', 'active', 'suspended']);

export const practiceAreaEnum = pgEnum('practice_area', [
  'family_matrimonial',
  'debt_recovery',
  'land_property',
  'corporate_disputes',
  'general',
]);

export const matterStatusEnum = pgEnum('matter_status', ['open', 'on_hold', 'closed']);

export const enquirySourceEnum = pgEnum('enquiry_source', ['widget', 'form', 'manual']);

export const enquiryStatusEnum = pgEnum('enquiry_status', [
  'new',
  'triaged',
  'needs_review',
  'slot_proposed',
  'booked',
  'declined',
  'spam',
]);

export const urgencyEnum = pgEnum('urgency', ['low', 'normal', 'high', 'critical']);

export const proposalStateEnum = pgEnum('proposal_state', [
  'pending',
  'accepted',
  'rescheduled',
  'declined',
  'expired',
]);

export const appointmentStateEnum = pgEnum('appointment_state', [
  'confirmed',
  'cancelled',
  'rescheduled',
]);

export const documentStateEnum = pgEnum('document_state', ['draft', 'in_review', 'final']);

export const generatedByEnum = pgEnum('generated_by', ['ai', 'human']);

export const ocrStateEnum = pgEnum('ocr_state', ['pending', 'processing', 'done', 'failed']);

export const chunkSourceTypeEnum = pgEnum('chunk_source_type', [
  'archive_file',
  'document_version',
]);

export const messageStateEnum = pgEnum('message_state', [
  'queued',
  'sent',
  'delivered',
  'bounced',
  'failed',
  'suppressed',
]);

export const taskStateEnum = pgEnum('task_state', ['open', 'acknowledged', 'resolved']);

// ---------------------------------------------------------------------------
// 4.1 Identity and access
// ---------------------------------------------------------------------------

export const roles = pgTable('roles', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: varchar('name', { length: 80 }).notNull().unique(),
  description: text('description'),
  /** Seeded roles cannot be deleted (FR-9.1). */
  isSystem: boolean('is_system').notNull().default(false),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const permissions = pgTable('permissions', {
  id: uuid('id').primaryKey().defaultRandom(),
  key: varchar('key', { length: 120 }).notNull().unique(),
  description: text('description').notNull(),
  /** Grouping for the admin console UI, e.g. "Matters", "Documents". */
  category: varchar('category', { length: 60 }).notNull().default('General'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const rolePermissions = pgTable(
  'role_permissions',
  {
    roleId: uuid('role_id')
      .notNull()
      .references(() => roles.id, { onDelete: 'cascade' }),
    permissionId: uuid('permission_id')
      .notNull()
      .references(() => permissions.id, { onDelete: 'cascade' }),
    /**
     * Scope qualifier. `all` = unrestricted, `office` = same office,
     * `own` = assigned/supervising only. Enforced server-side in can().
     */
    scope: varchar('scope', { length: 16 }).notNull().default('own'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.roleId, t.permissionId] })],
);

export const users = pgTable(
  'users',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    email: varchar('email', { length: 320 }).notNull(),
    fullName: varchar('full_name', { length: 200 }).notNull(),
    roleId: uuid('role_id')
      .notNull()
      .references(() => roles.id, { onDelete: 'restrict' }),
    office: officeEnum('office').notNull().default('KL'),
    status: userStatusEnum('status').notNull().default('invited'),
    practiceAreas: practiceAreaEnum('practice_areas').array(),
    ssoProvider: varchar('sso_provider', { length: 40 }),
    ssoSubject: varchar('sso_subject', { length: 255 }),
    lastLoginAt: timestamp('last_login_at', { withTimezone: true }),

    // --- Local credentials (PRD amendment A1) ---------------------------
    /** scrypt hash. Null for an account that has never had a password set. */
    passwordHash: text('password_hash'),
    passwordUpdatedAt: timestamp('password_updated_at', { withTimezone: true }),
    /** Set when an admin issues a temporary password; forces a change at sign-in. */
    mustChangePassword: boolean('must_change_password').notNull().default(false),

    // --- Brute-force resistance -----------------------------------------
    failedLoginAttempts: integer('failed_login_attempts').notNull().default(0),
    lockedUntil: timestamp('locked_until', { withTimezone: true }),

    // --- TOTP second factor ---------------------------------------------
    /** AES-256-GCM at the application layer — this is a credential, not config. */
    totpSecretEncrypted: text('totp_secret_encrypted'),
    /** Null until the user has proved they can produce a code. */
    totpEnrolledAt: timestamp('totp_enrolled_at', { withTimezone: true }),
    /** Highest accepted time step. Stops a code being replayed within its period. */
    totpLastStep: integer('totp_last_step'),
    /** Bumped on suspend / 2FA reset so live sessions die on next request (AT-07). */
    sessionEpoch: integer('session_epoch').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('users_email_lower_idx').on(sql`lower(${t.email})`),
    index('users_role_idx').on(t.roleId),
    index('users_office_idx').on(t.office),
  ],
);

/** Known devices (FR-1.4): re-authentication is required on an unseen device. */
export const userDevices = pgTable(
  'user_devices',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    fingerprintHash: varchar('fingerprint_hash', { length: 64 }).notNull(),
    label: varchar('label', { length: 160 }),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [unique('user_devices_user_fp_uq').on(t.userId, t.fingerprintHash)],
);

/**
 * Password reset tokens (PRD amendment A1).
 *
 * The token itself is never stored — only its SHA-256 hash — so a database
 * disclosure does not hand out working reset links. Single-use, short-lived,
 * and invalidated wholesale whenever the password changes by any route.
 */
export const passwordResetTokens = pgTable(
  'password_reset_tokens',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    tokenHash: varchar('token_hash', { length: 64 }).notNull().unique(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    usedAt: timestamp('used_at', { withTimezone: true }),
    requestedIp: varchar('requested_ip', { length: 64 }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('password_reset_tokens_user_idx').on(t.userId),
    index('password_reset_tokens_expiry_idx').on(t.expiresAt),
  ],
);

/**
 * Single-use recovery codes.
 *
 * Without these, a lost or wiped phone means an administrator must reset the
 * second factor for every affected person — and in a three-office firm that is
 * exactly when someone decides 2FA is more trouble than it is worth. Stored as
 * hashes for the same reason as reset tokens.
 */
export const recoveryCodes = pgTable(
  'recovery_codes',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    codeHash: varchar('code_hash', { length: 64 }).notNull(),
    usedAt: timestamp('used_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('recovery_codes_user_idx').on(t.userId),
    unique('recovery_codes_user_hash_uq').on(t.userId, t.codeHash),
  ],
);

/**
 * Append-only audit log (FR-1.7, FR-1.8).
 * Migration 0002 installs a trigger that raises on UPDATE and DELETE, so
 * immutability holds even if application code is wrong.
 */
export const auditEvents = pgTable(
  'audit_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    actorUserId: uuid('actor_user_id').references(() => users.id, { onDelete: 'set null' }),
    /** Denormalised so the log stays readable after a user is deleted. */
    actorEmail: varchar('actor_email', { length: 320 }),
    action: varchar('action', { length: 80 }).notNull(),
    entityType: varchar('entity_type', { length: 60 }),
    entityId: uuid('entity_id'),
    matterId: uuid('matter_id'),
    metadata: jsonb('metadata').$type<Record<string, unknown>>().notNull().default({}),
    ip: varchar('ip', { length: 64 }),
    userAgent: text('user_agent'),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('audit_events_occurred_idx').on(t.occurredAt),
    index('audit_events_actor_idx').on(t.actorUserId),
    index('audit_events_matter_idx').on(t.matterId),
    index('audit_events_action_idx').on(t.action),
  ],
);

// ---------------------------------------------------------------------------
// 4.2 Matters and clients
// ---------------------------------------------------------------------------

export const clients = pgTable(
  'clients',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    fullName: varchar('full_name', { length: 200 }).notNull(),
    email: varchar('email', { length: 320 }),
    phone: varchar('phone', { length: 40 }),
    /** AES-256-GCM at the application layer (NFR-1.2). Never logged. */
    idNumberEncrypted: text('id_number_encrypted'),
    notes: text('notes'),
    /** NFR-2.3: data-subject erasure tombstones the client, audit rows survive. */
    erasedAt: timestamp('erased_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('clients_email_idx').on(t.email)],
);

export const matters = pgTable(
  'matters',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    reference: varchar('reference', { length: 60 }).notNull().unique(),
    clientId: uuid('client_id')
      .notNull()
      .references(() => clients.id, { onDelete: 'restrict' }),
    practiceArea: practiceAreaEnum('practice_area').notNull(),
    office: officeEnum('office').notNull(),
    title: varchar('title', { length: 300 }).notNull(),
    assignedUserId: uuid('assigned_user_id').references(() => users.id, { onDelete: 'set null' }),
    supervisingUserId: uuid('supervising_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    status: matterStatusEnum('status').notNull().default('open'),
    /** FR-7.4: hold all client communications on a sensitive matter. */
    commsHold: boolean('comms_hold').notNull().default(false),
    openedAt: timestamp('opened_at', { withTimezone: true }).notNull().defaultNow(),
    closedAt: timestamp('closed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('matters_assigned_idx').on(t.assignedUserId),
    index('matters_supervising_idx').on(t.supervisingUserId),
    index('matters_office_area_idx').on(t.office, t.practiceArea),
    index('matters_client_idx').on(t.clientId),
  ],
);

/** Explicit access grants beyond assignee/supervisor. */
export const matterParticipants = pgTable(
  'matter_participants',
  {
    matterId: uuid('matter_id')
      .notNull()
      .references(() => matters.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    role: varchar('role', { length: 60 }).notNull().default('contributor'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    createdByUserId: uuid('created_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
  },
  (t) => [primaryKey({ columns: [t.matterId, t.userId] })],
);

/** Configurable procedural stages per practice area (FR-7.1). */
export const procedureStages = pgTable(
  'procedure_stages',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    practiceArea: practiceAreaEnum('practice_area').notNull(),
    key: varchar('key', { length: 80 }).notNull(),
    label: varchar('label', { length: 160 }).notNull(),
    sortOrder: integer('sort_order').notNull().default(0),
    /** Message template fired when a matter reaches this stage. Null = no email. */
    messageTemplateKey: varchar('message_template_key', { length: 120 }),
    /** FR-7.6: escalate if the matter sits at this stage beyond N days. */
    slaDays: integer('sla_days'),
    isActive: boolean('is_active').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [unique('procedure_stages_area_key_uq').on(t.practiceArea, t.key)],
);

export const matterStatusEvents = pgTable(
  'matter_status_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    matterId: uuid('matter_id')
      .notNull()
      .references(() => matters.id, { onDelete: 'cascade' }),
    stage: varchar('stage', { length: 80 }).notNull(),
    recordedByUserId: uuid('recorded_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    notes: text('notes'),
    /** FR-7.4: per-event suppression of the client email. */
    suppressed: boolean('suppressed').notNull().default(false),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('matter_status_events_matter_idx').on(t.matterId, t.occurredAt)],
);

// ---------------------------------------------------------------------------
// 4.3 Enquiries and scheduling
// ---------------------------------------------------------------------------

export const enquiries = pgTable(
  'enquiries',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    source: enquirySourceEnum('source').notNull().default('widget'),
    rawPayload: jsonb('raw_payload').$type<Record<string, unknown>>().notNull().default({}),
    contactName: varchar('contact_name', { length: 200 }),
    contactEmail: varchar('contact_email', { length: 320 }),
    contactPhone: varchar('contact_phone', { length: 40 }),
    practiceAreaPredicted: practiceAreaEnum('practice_area_predicted'),
    office: officeEnum('office'),
    urgency: urgencyEnum('urgency').notNull().default('normal'),
    confidence: integer('confidence'), // 0-100
    caseBriefMd: text('case_brief_md'),
    status: enquiryStatusEnum('status').notNull().default('new'),
    matterId: uuid('matter_id').references(() => matters.id, { onDelete: 'set null' }),
    /**
     * Session identifier issued to the widget; scopes the conversation.
     *
     * Minted server-side and never accepted from the client, and unique so two
     * enquiries can never share one — the structural half of the fix for
     * unrelated enquiries merging into a single transcript. Cleared once the
     * enquiry is handed to a lawyer, which retires the session for good.
     */
    sessionToken: varchar('session_token', { length: 64 }),
    submittedIp: varchar('submitted_ip', { length: 64 }),
    modelVersion: varchar('model_version', { length: 80 }),
    promptHash: varchar('prompt_hash', { length: 64 }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('enquiries_status_idx').on(t.status, t.createdAt),
    // Unique rather than plain: nulls are distinct in Postgres, so any number
    // of handed-over enquiries may hold null, but a live token points at
    // exactly one conversation.
    uniqueIndex('enquiries_session_idx').on(t.sessionToken),
    index('enquiries_email_idx').on(t.contactEmail),
  ],
);

/** Turn-by-turn transcript of the widget conversation. */
export const enquiryMessages = pgTable(
  'enquiry_messages',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    enquiryId: uuid('enquiry_id')
      .notNull()
      .references(() => enquiries.id, { onDelete: 'cascade' }),
    role: varchar('role', { length: 16 }).notNull(), // user | assistant
    content: text('content').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('enquiry_messages_enquiry_idx').on(t.enquiryId, t.createdAt)],
);

export const availabilityRules = pgTable(
  'availability_rules',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    office: officeEnum('office').notNull(),
    practiceArea: practiceAreaEnum('practice_area'),
    /** 0 = Sunday … 6 = Saturday, matching JS getUTCDay(). */
    weekday: integer('weekday').notNull(),
    startTime: time('start_time').notNull(),
    endTime: time('end_time').notNull(),
    slotMinutes: integer('slot_minutes').notNull().default(45),
    bufferMinutes: integer('buffer_minutes').notNull().default(15),
    validFrom: timestamp('valid_from', { withTimezone: true }),
    validTo: timestamp('valid_to', { withTimezone: true }),
    isActive: boolean('is_active').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('availability_rules_user_idx').on(t.userId, t.weekday)],
);

/** Malaysian federal + Selangor + Perak holidays (FR-9.2). */
export const publicHolidays = pgTable(
  'public_holidays',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    date: varchar('date', { length: 10 }).notNull(), // YYYY-MM-DD in firm timezone
    name: varchar('name', { length: 160 }).notNull(),
    /** null = federal (applies to all offices) */
    office: officeEnum('office'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [unique('public_holidays_date_office_uq').on(t.date, t.office)],
);

export const appointmentProposals = pgTable(
  'appointment_proposals',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    enquiryId: uuid('enquiry_id')
      .notNull()
      .references(() => enquiries.id, { onDelete: 'cascade' }),
    proposedUserId: uuid('proposed_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    startsAt: timestamp('starts_at', { withTimezone: true }).notNull(),
    endsAt: timestamp('ends_at', { withTimezone: true }).notNull(),
    state: proposalStateEnum('state').notNull().default('pending'),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    decidedAt: timestamp('decided_at', { withTimezone: true }),
    decidedByUserId: uuid('decided_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    declineReason: text('decline_reason'),
    /** Set when a proposal was created by rescheduling an earlier one. */
    supersedesProposalId: uuid('supersedes_proposal_id'),
    escalatedAt: timestamp('escalated_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('appointment_proposals_state_idx').on(t.state, t.expiresAt),
    index('appointment_proposals_user_idx').on(t.proposedUserId, t.state),
    index('appointment_proposals_enquiry_idx').on(t.enquiryId),
  ],
);

export const appointments = pgTable(
  'appointments',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    matterId: uuid('matter_id').references(() => matters.id, { onDelete: 'cascade' }),
    enquiryId: uuid('enquiry_id').references(() => enquiries.id, { onDelete: 'set null' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    startsAt: timestamp('starts_at', { withTimezone: true }).notNull(),
    endsAt: timestamp('ends_at', { withTimezone: true }).notNull(),
    location: varchar('location', { length: 300 }).notNull(),
    title: varchar('title', { length: 300 }).notNull(),
    clientEmail: varchar('client_email', { length: 320 }),
    clientName: varchar('client_name', { length: 200 }),
    /** RFC 5545: stable UID across reschedules, SEQUENCE increments (FR-3.7). */
    icsUid: varchar('ics_uid', { length: 200 }).notNull().unique(),
    icsSequence: integer('ics_sequence').notNull().default(0),
    state: appointmentStateEnum('state').notNull().default('confirmed'),
    /** Token for the no-login client reschedule link (FR-3.8). Hashed. */
    rescheduleTokenHash: varchar('reschedule_token_hash', { length: 64 }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('appointments_user_time_idx').on(t.userId, t.startsAt),
    index('appointments_matter_idx').on(t.matterId),
  ],
);

// ---------------------------------------------------------------------------
// 4.4 Documents and knowledge
// ---------------------------------------------------------------------------

export const documentTemplates = pgTable(
  'document_templates',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: varchar('name', { length: 200 }).notNull(),
    practiceArea: practiceAreaEnum('practice_area').notNull(),
    docType: varchar('doc_type', { length: 80 }).notNull(),
    storageKey: varchar('storage_key', { length: 500 }).notNull(),
    version: integer('version').notNull().default(1),
    /**
     * Parsed placeholder contract (FR-4.1):
     * { deterministic: [{name, label, required, source}], ai: [{name, instruction}] }
     */
    placeholderSchema: jsonb('placeholder_schema')
      .$type<TemplatePlaceholderSchema>()
      .notNull()
      .default({ deterministic: [], ai: [] }),
    isActive: boolean('is_active').notNull().default(true),
    createdByUserId: uuid('created_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('document_templates_area_idx').on(t.practiceArea, t.isActive),
    unique('document_templates_name_version_uq').on(t.name, t.version),
  ],
);

export interface TemplatePlaceholderSchema {
  deterministic: Array<{
    name: string;
    label: string;
    required: boolean;
    /** Dotted path into the matter data bundle, e.g. `client.fullName`. */
    source?: string;
  }>;
  ai: Array<{
    name: string;
    label: string;
    /** Instruction handed to the drafting model for this block only. */
    instruction: string;
  }>;
}

export const documents = pgTable(
  'documents',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    matterId: uuid('matter_id')
      .notNull()
      .references(() => matters.id, { onDelete: 'cascade' }),
    templateId: uuid('template_id').references(() => documentTemplates.id, {
      onDelete: 'set null',
    }),
    title: varchar('title', { length: 300 }).notNull(),
    state: documentStateEnum('state').notNull().default('draft'),
    currentVersionId: uuid('current_version_id'),
    finalisedAt: timestamp('finalised_at', { withTimezone: true }),
    finalisedByUserId: uuid('finalised_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    createdByUserId: uuid('created_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('documents_matter_idx').on(t.matterId, t.createdAt)],
);

export const documentVersions = pgTable(
  'document_versions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    documentId: uuid('document_id')
      .notNull()
      .references(() => documents.id, { onDelete: 'cascade' }),
    versionNo: integer('version_no').notNull(),
    storageKey: varchar('storage_key', { length: 500 }).notNull(),
    generatedBy: generatedByEnum('generated_by').notNull(),
    modelVersion: varchar('model_version', { length: 80 }),
    /** SHA-256 of the versioned system prompt actually used (AI-2). */
    promptHash: varchar('prompt_hash', { length: 64 }),
    /** Inputs used and chunks cited, for professional-conduct traceability (FR-4.4). */
    generationInputs: jsonb('generation_inputs')
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    citedChunkIds: uuid('cited_chunk_ids').array(),
    /** Rendered text of AI blocks, kept for diffing between versions (FR-4.6). */
    aiBlocks: jsonb('ai_blocks').$type<Record<string, string>>().notNull().default({}),
    changeSummary: text('change_summary'),
    inputTokens: integer('input_tokens'),
    outputTokens: integer('output_tokens'),
    costUsd: varchar('cost_usd', { length: 20 }),
    createdByUserId: uuid('created_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [unique('document_versions_doc_no_uq').on(t.documentId, t.versionNo)],
);

export const archiveFiles = pgTable(
  'archive_files',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    matterId: uuid('matter_id').references(() => matters.id, { onDelete: 'set null' }),
    practiceArea: practiceAreaEnum('practice_area'),
    originalFilename: varchar('original_filename', { length: 400 }).notNull(),
    storageKey: varchar('storage_key', { length: 500 }).notNull(),
    mimeType: varchar('mime_type', { length: 120 }).notNull(),
    byteSize: integer('byte_size').notNull().default(0),
    pageCount: integer('page_count'),
    /** SHA-256 of file bytes — makes re-indexing idempotent (FR-5.6). */
    contentHash: varchar('content_hash', { length: 64 }).notNull(),
    ocrState: ocrStateEnum('ocr_state').notNull().default('pending'),
    ocrError: text('ocr_error'),
    ocrAttempts: integer('ocr_attempts').notNull().default(0),
    extractedText: text('extracted_text'),
    uploadedByUserId: uuid('uploaded_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    batchId: uuid('batch_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('archive_files_content_hash_uq').on(t.contentHash),
    index('archive_files_state_idx').on(t.ocrState),
    index('archive_files_matter_idx').on(t.matterId),
    index('archive_files_batch_idx').on(t.batchId),
  ],
);

/**
 * Retrieval chunks. `embedding` and `text_search` are added by migration 0001
 * as raw SQL (vector + tsvector types have no drizzle equivalent).
 */
export const chunks = pgTable(
  'chunks',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    sourceType: chunkSourceTypeEnum('source_type').notNull(),
    sourceId: uuid('source_id').notNull(),
    /** Denormalised for the permission pre-filter (FR-6.2). Null = firm-wide precedent. */
    matterId: uuid('matter_id').references(() => matters.id, { onDelete: 'cascade' }),
    practiceArea: practiceAreaEnum('practice_area'),
    office: officeEnum('office'),
    chunkIndex: integer('chunk_index').notNull(),
    text: text('text').notNull(),
    tokenCount: integer('token_count').notNull().default(0),
    /** Human-readable locator for the citation, e.g. "p. 4" or "Clause 7.2". */
    locator: varchar('locator', { length: 120 }),
    embeddingModelVersion: varchar('embedding_model_version', { length: 80 }).notNull(),
    documentDate: timestamp('document_date', { withTimezone: true }),
    outcome: varchar('outcome', { length: 120 }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('chunks_source_idx').on(t.sourceType, t.sourceId),
    index('chunks_matter_idx').on(t.matterId),
    index('chunks_area_idx').on(t.practiceArea),
    unique('chunks_source_index_uq').on(t.sourceType, t.sourceId, t.chunkIndex),
  ],
);

/** FR-4.8: lawyer edits to AI blocks, stored as prompt-refinement signal only. */
export const draftEditSignals = pgTable('draft_edit_signals', {
  id: uuid('id').primaryKey().defaultRandom(),
  documentVersionId: uuid('document_version_id')
    .notNull()
    .references(() => documentVersions.id, { onDelete: 'cascade' }),
  blockName: varchar('block_name', { length: 120 }).notNull(),
  aiText: text('ai_text').notNull(),
  editedText: text('edited_text').notNull(),
  editedByUserId: uuid('edited_by_user_id').references(() => users.id, { onDelete: 'set null' }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

// ---------------------------------------------------------------------------
// 4.5 Communications
// ---------------------------------------------------------------------------

export const messageTemplates = pgTable('message_templates', {
  id: uuid('id').primaryKey().defaultRandom(),
  key: varchar('key', { length: 120 }).notNull().unique(),
  subject: varchar('subject', { length: 300 }).notNull(),
  bodyMd: text('body_md').notNull(),
  locale: varchar('locale', { length: 12 }).notNull().default('en-MY'),
  description: text('description'),
  isActive: boolean('is_active').notNull().default(true),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const messages = pgTable(
  'messages',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    matterId: uuid('matter_id').references(() => matters.id, { onDelete: 'set null' }),
    enquiryId: uuid('enquiry_id').references(() => enquiries.id, { onDelete: 'set null' }),
    toEmail: varchar('to_email', { length: 320 }).notNull(),
    templateKey: varchar('template_key', { length: 120 }),
    subject: varchar('subject', { length: 300 }).notNull(),
    bodyRendered: text('body_rendered').notNull(),
    resendMessageId: varchar('resend_message_id', { length: 120 }),
    state: messageStateEnum('state').notNull().default('queued'),
    sentAt: timestamp('sent_at', { withTimezone: true }),
    deliveredAt: timestamp('delivered_at', { withTimezone: true }),
    error: text('error'),
    /** Guards against duplicate sends on job retry. */
    idempotencyKey: varchar('idempotency_key', { length: 160 }).unique(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('messages_matter_idx').on(t.matterId, t.createdAt),
    index('messages_state_idx').on(t.state),
    index('messages_resend_idx').on(t.resendMessageId),
  ],
);

/** Per-matter, per-stage suppression (FR-7.4). */
export const messageSuppressions = pgTable(
  'message_suppressions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    matterId: uuid('matter_id')
      .notNull()
      .references(() => matters.id, { onDelete: 'cascade' }),
    /** null = suppress every stage on this matter */
    stage: varchar('stage', { length: 80 }),
    reason: text('reason'),
    createdByUserId: uuid('created_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [unique('message_suppressions_matter_stage_uq').on(t.matterId, t.stage)],
);

/** FR-7.5/7.6: bounces and SLA breaches raise a task, never a silent failure. */
export const exceptionTasks = pgTable(
  'exception_tasks',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    matterId: uuid('matter_id').references(() => matters.id, { onDelete: 'cascade' }),
    messageId: uuid('message_id').references(() => messages.id, { onDelete: 'set null' }),
    kind: varchar('kind', { length: 60 }).notNull(),
    title: varchar('title', { length: 300 }).notNull(),
    detail: text('detail'),
    assignedUserId: uuid('assigned_user_id').references(() => users.id, { onDelete: 'set null' }),
    state: taskStateEnum('state').notNull().default('open'),
    resolvedAt: timestamp('resolved_at', { withTimezone: true }),
    resolvedByUserId: uuid('resolved_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('exception_tasks_state_idx').on(t.state, t.createdAt)],
);

// ---------------------------------------------------------------------------
// Operations
// ---------------------------------------------------------------------------

/** AI-6: per-call token + cost ledger, drives the monthly ceiling alert. */
export const aiUsageEvents = pgTable(
  'ai_usage_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    task: varchar('task', { length: 60 }).notNull(),
    modelVersion: varchar('model_version', { length: 80 }).notNull(),
    promptHash: varchar('prompt_hash', { length: 64 }),
    inputTokens: integer('input_tokens').notNull().default(0),
    outputTokens: integer('output_tokens').notNull().default(0),
    cachedInputTokens: integer('cached_input_tokens').notNull().default(0),
    costUsd: varchar('cost_usd', { length: 20 }).notNull().default('0'),
    latencyMs: integer('latency_ms'),
    actorUserId: uuid('actor_user_id').references(() => users.id, { onDelete: 'set null' }),
    matterId: uuid('matter_id').references(() => matters.id, { onDelete: 'set null' }),
    succeeded: boolean('succeeded').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('ai_usage_created_idx').on(t.createdAt), index('ai_usage_task_idx').on(t.task)],
);

/** FR-9.4: feature toggles per role, so AI drafting can be disabled without a deploy. */
export const featureFlags = pgTable(
  'feature_flags',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    key: varchar('key', { length: 80 }).notNull(),
    roleId: uuid('role_id').references(() => roles.id, { onDelete: 'cascade' }),
    enabled: boolean('enabled').notNull().default(true),
    updatedByUserId: uuid('updated_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [unique('feature_flags_key_role_uq').on(t.key, t.roleId)],
);

/** Rate limiting for the public widget endpoint (FR-2.3). Pruned by a nightly job. */
export const rateLimitBuckets = pgTable(
  'rate_limit_buckets',
  {
    key: varchar('key', { length: 200 }).primaryKey(),
    count: integer('count').notNull().default(0),
    windowStart: timestamp('window_start', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('rate_limit_window_idx').on(t.windowStart)],
);

// ---------------------------------------------------------------------------
// Relations
// ---------------------------------------------------------------------------

export const usersRelations = relations(users, ({ one, many }) => ({
  role: one(roles, { fields: [users.roleId], references: [roles.id] }),
  assignedMatters: many(matters, { relationName: 'assignee' }),
  devices: many(userDevices),
}));

export const rolesRelations = relations(roles, ({ many }) => ({
  users: many(users),
  rolePermissions: many(rolePermissions),
}));

export const rolePermissionsRelations = relations(rolePermissions, ({ one }) => ({
  role: one(roles, { fields: [rolePermissions.roleId], references: [roles.id] }),
  permission: one(permissions, {
    fields: [rolePermissions.permissionId],
    references: [permissions.id],
  }),
}));

export const mattersRelations = relations(matters, ({ one, many }) => ({
  client: one(clients, { fields: [matters.clientId], references: [clients.id] }),
  assignee: one(users, {
    fields: [matters.assignedUserId],
    references: [users.id],
    relationName: 'assignee',
  }),
  supervisor: one(users, {
    fields: [matters.supervisingUserId],
    references: [users.id],
    relationName: 'supervisor',
  }),
  participants: many(matterParticipants),
  statusEvents: many(matterStatusEvents),
  documents: many(documents),
  appointments: many(appointments),
  messages: many(messages),
}));

export const documentsRelations = relations(documents, ({ one, many }) => ({
  matter: one(matters, { fields: [documents.matterId], references: [matters.id] }),
  template: one(documentTemplates, {
    fields: [documents.templateId],
    references: [documentTemplates.id],
  }),
  versions: many(documentVersions),
}));

export const documentVersionsRelations = relations(documentVersions, ({ one }) => ({
  document: one(documents, {
    fields: [documentVersions.documentId],
    references: [documents.id],
  }),
}));

export const enquiriesRelations = relations(enquiries, ({ many, one }) => ({
  messages: many(enquiryMessages),
  proposals: many(appointmentProposals),
  matter: one(matters, { fields: [enquiries.matterId], references: [matters.id] }),
}));

export const appointmentProposalsRelations = relations(appointmentProposals, ({ one }) => ({
  enquiry: one(enquiries, {
    fields: [appointmentProposals.enquiryId],
    references: [enquiries.id],
  }),
  proposedUser: one(users, {
    fields: [appointmentProposals.proposedUserId],
    references: [users.id],
  }),
}));

export const archiveFilesRelations = relations(archiveFiles, ({ one }) => ({
  matter: one(matters, { fields: [archiveFiles.matterId], references: [matters.id] }),
}));

// ---------------------------------------------------------------------------
// Inferred types
// ---------------------------------------------------------------------------

export type Role = typeof roles.$inferSelect;
export type Permission = typeof permissions.$inferSelect;
export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
export type Client = typeof clients.$inferSelect;
export type Matter = typeof matters.$inferSelect;
export type NewMatter = typeof matters.$inferInsert;
export type Enquiry = typeof enquiries.$inferSelect;
export type NewEnquiry = typeof enquiries.$inferInsert;
export type AppointmentProposal = typeof appointmentProposals.$inferSelect;
export type Appointment = typeof appointments.$inferSelect;
export type DocumentTemplate = typeof documentTemplates.$inferSelect;
export type DocumentRow = typeof documents.$inferSelect;
export type DocumentVersion = typeof documentVersions.$inferSelect;
export type ArchiveFile = typeof archiveFiles.$inferSelect;
export type Chunk = typeof chunks.$inferSelect;
export type MessageRow = typeof messages.$inferSelect;
export type MessageTemplate = typeof messageTemplates.$inferSelect;
export type ProcedureStage = typeof procedureStages.$inferSelect;
export type AvailabilityRule = typeof availabilityRules.$inferSelect;
export type ExceptionTask = typeof exceptionTasks.$inferSelect;
export type AuditEvent = typeof auditEvents.$inferSelect;
export type PasswordResetToken = typeof passwordResetTokens.$inferSelect;
export type RecoveryCode = typeof recoveryCodes.$inferSelect;
export type Office = (typeof officeEnum.enumValues)[number];
export type EnquiryStatus = (typeof enquiryStatusEnum.enumValues)[number];
export type PracticeArea = (typeof practiceAreaEnum.enumValues)[number];

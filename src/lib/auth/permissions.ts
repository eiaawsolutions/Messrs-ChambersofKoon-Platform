/**
 * Permission catalogue and the seeded role matrix (PRD §2.2).
 *
 * This file is the single source of truth for what capabilities exist.
 * Roles are *seeded* from the matrix below and are then editable by the
 * Managing Partner in the admin console — the matrix is the starting state,
 * not a runtime constraint.
 *
 * No `server-only` import: the widget preview and client components read the
 * PERMISSION_CATALOGUE for labels. Values here are public metadata, never
 * authorisation decisions — those happen in guard.ts on the server.
 */

export const PERMISSIONS = {
  MATTER_VIEW: 'matter.view',
  MATTER_CREATE: 'matter.create',
  MATTER_EDIT: 'matter.edit',
  MATTER_STATUS_RECORD: 'matter.status.record',

  DOCUMENT_VIEW: 'document.view',
  DOCUMENT_GENERATE: 'document.generate',
  DOCUMENT_FINALISE: 'document.finalise',
  DOCUMENT_TEMPLATE_MANAGE: 'document.template.manage',

  INTAKE_VIEW: 'intake.view',
  INTAKE_TRIAGE: 'intake.triage',

  PROPOSAL_DECIDE: 'proposal.decide',

  RAG_SEARCH: 'rag.search',
  ARCHIVE_UPLOAD: 'archive.upload',

  ADMIN_USERS_MANAGE: 'admin.users.manage',
  ADMIN_USERS_ONBOARD: 'admin.users.onboard',
  ADMIN_ROLES_MANAGE: 'admin.roles.manage',
  ADMIN_FEATURES_MANAGE: 'admin.features.manage',
  ADMIN_AVAILABILITY_MANAGE: 'admin.availability.manage',
  ADMIN_MESSAGING_MANAGE: 'admin.messaging.manage',

  AUDIT_VIEW: 'audit.view',
} as const;

export type PermissionKey = (typeof PERMISSIONS)[keyof typeof PERMISSIONS];

/**
 * Scope qualifier attached to a role's grant of a permission.
 *
 *  - `all`    — every matter, every office
 *  - `office` — matters in the user's own office (further narrowed by practice
 *               area when the user has practiceAreas set)
 *  - `own`    — matters where the user is assignee, supervisor or an explicit
 *               participant
 *  - `index`  — metadata only: reference, status, dates. No document contents,
 *               no client identifiers. Used by the practice manager role.
 */
export const SCOPES = ['all', 'office', 'own', 'index'] as const;
export type Scope = (typeof SCOPES)[number];

export const SCOPE_RANK: Record<Scope, number> = {
  index: 0,
  own: 1,
  office: 2,
  all: 3,
};

export interface PermissionDefinition {
  key: PermissionKey;
  description: string;
  category: string;
}

export const PERMISSION_CATALOGUE: PermissionDefinition[] = [
  { key: PERMISSIONS.MATTER_VIEW, description: 'View matters', category: 'Matters' },
  { key: PERMISSIONS.MATTER_CREATE, description: 'Open a new matter', category: 'Matters' },
  { key: PERMISSIONS.MATTER_EDIT, description: 'Edit matter details', category: 'Matters' },
  {
    key: PERMISSIONS.MATTER_STATUS_RECORD,
    description: 'Record a procedural status change',
    category: 'Matters',
  },

  {
    key: PERMISSIONS.DOCUMENT_VIEW,
    description: 'View and download document contents',
    category: 'Documents',
  },
  {
    key: PERMISSIONS.DOCUMENT_GENERATE,
    description: 'Generate an AI-assisted draft',
    category: 'Documents',
  },
  {
    key: PERMISSIONS.DOCUMENT_FINALISE,
    description: 'Mark a document final / send',
    category: 'Documents',
  },
  {
    key: PERMISSIONS.DOCUMENT_TEMPLATE_MANAGE,
    description: 'Upload and edit firm precedent templates',
    category: 'Documents',
  },

  { key: PERMISSIONS.INTAKE_VIEW, description: 'View the intake queue', category: 'Intake' },
  {
    key: PERMISSIONS.INTAKE_TRIAGE,
    description: 'Run or override enquiry triage',
    category: 'Intake',
  },
  {
    key: PERMISSIONS.PROPOSAL_DECIDE,
    description: 'Accept, reschedule or decline an appointment proposal',
    category: 'Intake',
  },

  {
    key: PERMISSIONS.RAG_SEARCH,
    description: 'Search firm precedent',
    category: 'Knowledge',
  },
  {
    key: PERMISSIONS.ARCHIVE_UPLOAD,
    description: 'Upload files to the matter archive',
    category: 'Knowledge',
  },

  {
    key: PERMISSIONS.ADMIN_USERS_MANAGE,
    description: 'Create, edit and suspend users; assign roles',
    category: 'Administration',
  },
  {
    key: PERMISSIONS.ADMIN_USERS_ONBOARD,
    description: 'Delegated onboarding/offboarding and 2FA reset',
    category: 'Administration',
  },
  {
    key: PERMISSIONS.ADMIN_ROLES_MANAGE,
    description: 'Create and edit roles and their permissions',
    category: 'Administration',
  },
  {
    key: PERMISSIONS.ADMIN_FEATURES_MANAGE,
    description: 'Toggle feature-level access per role',
    category: 'Administration',
  },
  {
    key: PERMISSIONS.ADMIN_AVAILABILITY_MANAGE,
    description: 'Manage availability rules, working hours and holidays',
    category: 'Administration',
  },
  {
    key: PERMISSIONS.ADMIN_MESSAGING_MANAGE,
    description: 'Manage message templates and procedural stages',
    category: 'Administration',
  },
  { key: PERMISSIONS.AUDIT_VIEW, description: 'View and export the audit log', category: 'Audit' },
];

export const ROLE_NAMES = {
  MANAGING_PARTNER: 'Managing Partner',
  PARTNER: 'Partner',
  SENIOR_ASSOCIATE: 'Senior Associate',
  ASSOCIATE: 'Associate',
  PUPIL: 'Pupil in Chambers',
  LEGAL_EXECUTIVE: 'Legal Executive / Clerk',
  PRACTICE_MANAGER: 'Practice Manager',
} as const;

export type RoleName = (typeof ROLE_NAMES)[keyof typeof ROLE_NAMES];

export interface SeededRole {
  name: RoleName;
  description: string;
  /** Permission → scope. Absent key = not granted. */
  grants: Partial<Record<PermissionKey, Scope>>;
  /**
   * Pupil masking (PRD §2.2): client identifiers are redacted server-side at
   * query time for roles carrying this flag, not hidden in the UI.
   */
  masksClientIdentifiers?: boolean;
}

/**
 * Direct transcription of the PRD §2.2 permission matrix.
 * "Own" = matters where the user is assignee, supervisor or participant.
 */
export const SEEDED_ROLES: SeededRole[] = [
  {
    name: ROLE_NAMES.MANAGING_PARTNER,
    description: 'Owns the firm. Full oversight and access control.',
    grants: {
      [PERMISSIONS.MATTER_VIEW]: 'all',
      [PERMISSIONS.MATTER_CREATE]: 'all',
      [PERMISSIONS.MATTER_EDIT]: 'all',
      [PERMISSIONS.MATTER_STATUS_RECORD]: 'all',
      [PERMISSIONS.DOCUMENT_VIEW]: 'all',
      [PERMISSIONS.DOCUMENT_GENERATE]: 'all',
      [PERMISSIONS.DOCUMENT_FINALISE]: 'all',
      [PERMISSIONS.DOCUMENT_TEMPLATE_MANAGE]: 'all',
      [PERMISSIONS.INTAKE_VIEW]: 'all',
      [PERMISSIONS.INTAKE_TRIAGE]: 'all',
      [PERMISSIONS.PROPOSAL_DECIDE]: 'all',
      [PERMISSIONS.RAG_SEARCH]: 'all',
      [PERMISSIONS.ARCHIVE_UPLOAD]: 'all',
      [PERMISSIONS.ADMIN_USERS_MANAGE]: 'all',
      [PERMISSIONS.ADMIN_USERS_ONBOARD]: 'all',
      [PERMISSIONS.ADMIN_ROLES_MANAGE]: 'all',
      [PERMISSIONS.ADMIN_FEATURES_MANAGE]: 'all',
      [PERMISSIONS.ADMIN_AVAILABILITY_MANAGE]: 'all',
      [PERMISSIONS.ADMIN_MESSAGING_MANAGE]: 'all',
      [PERMISSIONS.AUDIT_VIEW]: 'all',
    },
  },
  {
    name: ROLE_NAMES.PARTNER,
    description: 'Practice-area lead for one office.',
    grants: {
      [PERMISSIONS.MATTER_VIEW]: 'office',
      [PERMISSIONS.MATTER_CREATE]: 'office',
      [PERMISSIONS.MATTER_EDIT]: 'office',
      [PERMISSIONS.MATTER_STATUS_RECORD]: 'office',
      [PERMISSIONS.DOCUMENT_VIEW]: 'office',
      [PERMISSIONS.DOCUMENT_GENERATE]: 'office',
      [PERMISSIONS.DOCUMENT_FINALISE]: 'office',
      [PERMISSIONS.DOCUMENT_TEMPLATE_MANAGE]: 'office',
      [PERMISSIONS.INTAKE_VIEW]: 'office',
      [PERMISSIONS.INTAKE_TRIAGE]: 'office',
      [PERMISSIONS.PROPOSAL_DECIDE]: 'office',
      [PERMISSIONS.RAG_SEARCH]: 'office',
      [PERMISSIONS.ARCHIVE_UPLOAD]: 'office',
      [PERMISSIONS.AUDIT_VIEW]: 'office',
    },
  },
  {
    name: ROLE_NAMES.SENIOR_ASSOCIATE,
    description: 'Fee earner. Own caseload.',
    grants: {
      [PERMISSIONS.MATTER_VIEW]: 'own',
      [PERMISSIONS.MATTER_CREATE]: 'own',
      [PERMISSIONS.MATTER_EDIT]: 'own',
      [PERMISSIONS.MATTER_STATUS_RECORD]: 'own',
      [PERMISSIONS.DOCUMENT_VIEW]: 'own',
      [PERMISSIONS.DOCUMENT_GENERATE]: 'own',
      [PERMISSIONS.DOCUMENT_FINALISE]: 'own',
      [PERMISSIONS.INTAKE_VIEW]: 'office',
      [PERMISSIONS.INTAKE_TRIAGE]: 'office',
      [PERMISSIONS.PROPOSAL_DECIDE]: 'own',
      // PRD: "RAG precedent search — Yes" for associates and pupils. The scope
      // filter in guard.ts still narrows results to matters they may open.
      [PERMISSIONS.RAG_SEARCH]: 'own',
      [PERMISSIONS.ARCHIVE_UPLOAD]: 'own',
    },
  },
  {
    name: ROLE_NAMES.ASSOCIATE,
    description: 'Fee earner. Own caseload.',
    grants: {
      [PERMISSIONS.MATTER_VIEW]: 'own',
      [PERMISSIONS.MATTER_CREATE]: 'own',
      [PERMISSIONS.MATTER_EDIT]: 'own',
      [PERMISSIONS.MATTER_STATUS_RECORD]: 'own',
      [PERMISSIONS.DOCUMENT_VIEW]: 'own',
      [PERMISSIONS.DOCUMENT_GENERATE]: 'own',
      [PERMISSIONS.DOCUMENT_FINALISE]: 'own',
      [PERMISSIONS.INTAKE_VIEW]: 'office',
      [PERMISSIONS.INTAKE_TRIAGE]: 'office',
      [PERMISSIONS.PROPOSAL_DECIDE]: 'own',
      [PERMISSIONS.RAG_SEARCH]: 'own',
      [PERMISSIONS.ARCHIVE_UPLOAD]: 'own',
    },
  },
  {
    name: ROLE_NAMES.PUPIL,
    description: 'Trainee under supervision. Client identifiers are masked.',
    masksClientIdentifiers: true,
    grants: {
      [PERMISSIONS.MATTER_VIEW]: 'own',
      [PERMISSIONS.DOCUMENT_VIEW]: 'own',
      // Can draft, cannot finalise (FR-4.5, AT-06).
      [PERMISSIONS.DOCUMENT_GENERATE]: 'own',
      [PERMISSIONS.RAG_SEARCH]: 'own',
    },
  },
  {
    name: ROLE_NAMES.LEGAL_EXECUTIVE,
    description: 'Procedural work and filing. Manages the intake queue.',
    grants: {
      [PERMISSIONS.MATTER_VIEW]: 'own',
      [PERMISSIONS.DOCUMENT_VIEW]: 'own',
      [PERMISSIONS.MATTER_STATUS_RECORD]: 'own',
      [PERMISSIONS.INTAKE_VIEW]: 'office',
      [PERMISSIONS.INTAKE_TRIAGE]: 'office',
      // "On behalf, if delegated" — granted here, additionally gated by the
      // delegation check in guard.ts.
      [PERMISSIONS.PROPOSAL_DECIDE]: 'own',
      [PERMISSIONS.ARCHIVE_UPLOAD]: 'own',
    },
  },
  {
    name: ROLE_NAMES.PRACTICE_MANAGER,
    description: 'Operations across three offices. Index and status only.',
    grants: {
      [PERMISSIONS.MATTER_VIEW]: 'index',
      [PERMISSIONS.ADMIN_USERS_ONBOARD]: 'all',
      [PERMISSIONS.ADMIN_AVAILABILITY_MANAGE]: 'all',
    },
  },
];

/** Feature-flag keys toggled per role from the admin console (FR-9.4). */
export const FEATURE_FLAGS = {
  AI_DRAFTING: 'ai.drafting',
  AI_TRIAGE: 'ai.triage',
  RAG_SEARCH: 'rag.search',
  CLIENT_MILESTONE_EMAILS: 'comms.milestones',
} as const;

export type FeatureFlagKey = (typeof FEATURE_FLAGS)[keyof typeof FEATURE_FLAGS];

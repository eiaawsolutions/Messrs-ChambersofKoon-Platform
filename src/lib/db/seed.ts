import 'dotenv/config';
import { eq, sql } from 'drizzle-orm';
import { db, getPool } from './client';
import {
  featureFlags,
  messageTemplates,
  permissions as permissionsTable,
  procedureStages,
  publicHolidays,
  rolePermissions,
  roles as rolesTable,
} from './schema';
import {
  FEATURE_FLAGS,
  PERMISSION_CATALOGUE,
  SEEDED_ROLES,
  type PermissionKey,
} from '@/lib/auth/permissions';

/**
 * Idempotent seed of reference data.
 *
 * Runs on every deploy (safe to re-run). It seeds only *system* data: the
 * permission catalogue, the seeded roles from PRD §2.2, default procedural
 * stages, message templates and Malaysian public holidays.
 *
 * It deliberately does not create users. The first Managing Partner is created
 * by the bootstrap route the first time someone from an allow-listed domain
 * signs in against an empty user table — so no password or invite token ever
 * needs to exist.
 *
 * Role permissions are only seeded when a role is newly created. Once the
 * Managing Partner edits a role in the admin console, re-running the seed must
 * not silently revert their change.
 */

async function seedPermissions(): Promise<Map<PermissionKey, string>> {
  const ids = new Map<PermissionKey, string>();
  for (const def of PERMISSION_CATALOGUE) {
    const [row] = await db
      .insert(permissionsTable)
      .values({ key: def.key, description: def.description, category: def.category })
      .onConflictDoUpdate({
        target: permissionsTable.key,
        set: { description: def.description, category: def.category },
      })
      .returning({ id: permissionsTable.id });
    if (row) ids.set(def.key, row.id);
  }
  console.log(`  permissions: ${ids.size}`);
  return ids;
}

async function seedRoles(permissionIds: Map<PermissionKey, string>): Promise<void> {
  let created = 0;
  let existing = 0;

  for (const def of SEEDED_ROLES) {
    const [found] = await db
      .select({ id: rolesTable.id })
      .from(rolesTable)
      .where(eq(rolesTable.name, def.name))
      .limit(1);

    if (found) {
      existing += 1;
      continue;
    }

    const [role] = await db
      .insert(rolesTable)
      .values({ name: def.name, description: def.description, isSystem: true })
      .returning({ id: rolesTable.id });
    if (!role) continue;
    created += 1;

    const grantRows: Array<{ roleId: string; permissionId: string; scope: string }> = [];
    for (const [key, scope] of Object.entries(def.grants)) {
      const permissionId = permissionIds.get(key as PermissionKey);
      if (!permissionId || !scope) continue;
      grantRows.push({ roleId: role.id, permissionId, scope });
    }

    if (grantRows.length > 0) {
      await db.insert(rolePermissions).values(grantRows).onConflictDoNothing();
    }
  }
  console.log(`  roles: ${created} created, ${existing} left untouched (admin-editable)`);
}

/** FR-7.1 default stage sets. */
const STAGES = [
  {
    practiceArea: 'family_matrimonial' as const,
    stages: [
      {
        key: 'documents_signed',
        label: 'Documents signed',
        templateKey: 'milestone.documents_signed',
        slaDays: 14,
      },
      {
        key: 'filing_submitted',
        label: 'Filing submitted to court',
        templateKey: 'milestone.filing_submitted',
        slaDays: 21,
      },
      {
        key: 'hearing_date_confirmed',
        label: 'Hearing date confirmed',
        templateKey: 'milestone.hearing_confirmed',
        slaDays: 60,
      },
      {
        key: 'certificate_issued',
        label: 'Certificate issued',
        templateKey: 'milestone.certificate_issued',
        slaDays: 30,
      },
      {
        key: 'matter_closed',
        label: 'Matter closed',
        templateKey: 'milestone.matter_closed',
        slaDays: null,
      },
    ],
  },
  {
    practiceArea: 'debt_recovery' as const,
    stages: [
      {
        key: 'demand_letter_sent',
        label: 'Letter of demand sent',
        templateKey: 'milestone.demand_sent',
        slaDays: 14,
      },
      {
        key: 'response_received',
        label: 'Debtor response received',
        templateKey: null,
        slaDays: 21,
      },
      {
        key: 'filing_submitted',
        label: 'Claim filed',
        templateKey: 'milestone.filing_submitted',
        slaDays: 30,
      },
      {
        key: 'hearing_date_confirmed',
        label: 'Hearing date confirmed',
        templateKey: 'milestone.hearing_confirmed',
        slaDays: 60,
      },
      {
        key: 'judgment_obtained',
        label: 'Judgment obtained',
        templateKey: 'milestone.judgment_obtained',
        slaDays: 30,
      },
      {
        key: 'matter_closed',
        label: 'Matter closed',
        templateKey: 'milestone.matter_closed',
        slaDays: null,
      },
    ],
  },
  {
    practiceArea: 'land_property' as const,
    stages: [
      {
        key: 'documents_signed',
        label: 'Documents signed',
        templateKey: 'milestone.documents_signed',
        slaDays: 14,
      },
      {
        key: 'stamping_completed',
        label: 'Stamping completed',
        templateKey: 'milestone.stamping_completed',
        slaDays: 30,
      },
      {
        key: 'presentation_lodged',
        label: 'Presentation lodged at land office',
        templateKey: 'milestone.presentation_lodged',
        slaDays: 30,
      },
      {
        key: 'registration_completed',
        label: 'Registration completed',
        templateKey: 'milestone.registration_completed',
        slaDays: 60,
      },
      {
        key: 'matter_closed',
        label: 'Matter closed',
        templateKey: 'milestone.matter_closed',
        slaDays: null,
      },
    ],
  },
  {
    practiceArea: 'corporate_disputes' as const,
    stages: [
      {
        key: 'documents_signed',
        label: 'Documents signed',
        templateKey: 'milestone.documents_signed',
        slaDays: 14,
      },
      {
        key: 'filing_submitted',
        label: 'Filing submitted',
        templateKey: 'milestone.filing_submitted',
        slaDays: 30,
      },
      {
        key: 'hearing_date_confirmed',
        label: 'Hearing date confirmed',
        templateKey: 'milestone.hearing_confirmed',
        slaDays: 90,
      },
      {
        key: 'matter_closed',
        label: 'Matter closed',
        templateKey: 'milestone.matter_closed',
        slaDays: null,
      },
    ],
  },
  {
    practiceArea: 'general' as const,
    stages: [
      { key: 'engaged', label: 'Engagement confirmed', templateKey: null, slaDays: null },
      { key: 'in_progress', label: 'In progress', templateKey: null, slaDays: 90 },
      {
        key: 'matter_closed',
        label: 'Matter closed',
        templateKey: 'milestone.matter_closed',
        slaDays: null,
      },
    ],
  },
];

async function seedProcedureStages(): Promise<void> {
  let count = 0;
  for (const group of STAGES) {
    for (const [index, stage] of group.stages.entries()) {
      await db
        .insert(procedureStages)
        .values({
          practiceArea: group.practiceArea,
          key: stage.key,
          label: stage.label,
          sortOrder: index,
          messageTemplateKey: stage.templateKey,
          slaDays: stage.slaDays,
        })
        .onConflictDoNothing();
      count += 1;
    }
  }
  console.log(`  procedure stages: ${count} ensured`);
}

/**
 * Client-facing copy.
 *
 * Deliberately plain and factual: these go to people in the middle of a
 * divorce, a debt claim or a property dispute. No marketing tone, no emoji, no
 * false reassurance. `{{firmName}}` and `{{matterReference}}` are always
 * available; stage-specific variables are listed per template.
 */
const MESSAGE_TEMPLATES = [
  {
    key: 'milestone.documents_signed',
    subject: 'Your documents have been signed — {{matterReference}}',
    description: 'Sent when documents_signed is recorded.',
    bodyMd: `Dear {{clientName}},

We confirm that the documents for your matter ({{matterReference}}) have been signed.

The next step is preparation for filing. We will write to you again once that has been completed.

If you have questions in the meantime, reply to this email and it will reach the team handling your matter.

{{lawyerName}}
{{firmName}}`,
  },
  {
    key: 'milestone.filing_submitted',
    subject: 'Your matter has been filed — {{matterReference}}',
    description: 'Sent when filing_submitted is recorded.',
    bodyMd: `Dear {{clientName}},

Your matter ({{matterReference}}) has been filed with the court.

The court will in due course assign a hearing date. We will inform you as soon as that date is confirmed. Timelines at this stage are set by the court, not by us, so we are not able to give a firm date yet.

{{lawyerName}}
{{firmName}}`,
  },
  {
    key: 'milestone.hearing_confirmed',
    subject: 'Hearing date confirmed — {{matterReference}}',
    description: 'Sent when hearing_date_confirmed is recorded.',
    bodyMd: `Dear {{clientName}},

The court has confirmed a hearing date for your matter ({{matterReference}}).

Date: {{stageDetail}}

We will be in touch before then regarding attendance and any preparation required. Please keep the date free.

{{lawyerName}}
{{firmName}}`,
  },
  {
    key: 'milestone.certificate_issued',
    subject: 'Certificate issued — {{matterReference}}',
    description: 'Sent when certificate_issued is recorded.',
    bodyMd: `Dear {{clientName}},

The certificate for your matter ({{matterReference}}) has been issued.

We are arranging submission to the relevant authorities and will confirm once that is complete.

{{lawyerName}}
{{firmName}}`,
  },
  {
    key: 'milestone.demand_sent',
    subject: 'Letter of demand issued — {{matterReference}}',
    description: 'Sent when demand_letter_sent is recorded.',
    bodyMd: `Dear {{clientName}},

The letter of demand in your matter ({{matterReference}}) has been issued to the other party.

They have a period in which to respond. We will inform you of any response received, and advise on next steps if none is received.

{{lawyerName}}
{{firmName}}`,
  },
  {
    key: 'milestone.judgment_obtained',
    subject: 'Judgment obtained — {{matterReference}}',
    description: 'Sent when judgment_obtained is recorded.',
    bodyMd: `Dear {{clientName}},

Judgment has been obtained in your matter ({{matterReference}}).

We will write to you separately regarding enforcement and what it involves.

{{lawyerName}}
{{firmName}}`,
  },
  {
    key: 'milestone.stamping_completed',
    subject: 'Stamping completed — {{matterReference}}',
    description: 'Sent when stamping_completed is recorded.',
    bodyMd: `Dear {{clientName}},

Stamping for your matter ({{matterReference}}) has been completed.

The next step is lodging the presentation at the land office. We will confirm once that is done.

{{lawyerName}}
{{firmName}}`,
  },
  {
    key: 'milestone.presentation_lodged',
    subject: 'Presentation lodged — {{matterReference}}',
    description: 'Sent when presentation_lodged is recorded.',
    bodyMd: `Dear {{clientName}},

The presentation for your matter ({{matterReference}}) has been lodged at the land office.

Registration timelines are set by the land office. We will confirm as soon as registration is completed.

{{lawyerName}}
{{firmName}}`,
  },
  {
    key: 'milestone.registration_completed',
    subject: 'Registration completed — {{matterReference}}',
    description: 'Sent when registration_completed is recorded.',
    bodyMd: `Dear {{clientName}},

Registration for your matter ({{matterReference}}) has been completed.

We will be in touch regarding the return of documents to you.

{{lawyerName}}
{{firmName}}`,
  },
  {
    key: 'milestone.matter_closed',
    subject: 'Your matter is now closed — {{matterReference}}',
    description: 'Sent when matter_closed is recorded.',
    bodyMd: `Dear {{clientName}},

Your matter ({{matterReference}}) is now closed.

Thank you for instructing us. If you need anything further, you are welcome to contact us.

{{lawyerName}}
{{firmName}}`,
  },
  {
    key: 'appointment.confirmed',
    subject: 'Your consultation is confirmed — {{firmName}}',
    description: 'Sent to the client with the .ics invitation when a lawyer accepts a proposal.',
    bodyMd: `Dear {{clientName}},

Your consultation with {{lawyerName}} is confirmed.

When: {{appointmentWhen}}
Where: {{appointmentLocation}}

A calendar invitation is attached. If you need to change the time, use the link below and we will propose an alternative.

{{rescheduleUrl}}

{{firmName}}`,
  },
  {
    key: 'appointment.cancelled',
    subject: 'Your consultation has been cancelled — {{firmName}}',
    description: 'Sent when a confirmed appointment is cancelled.',
    bodyMd: `Dear {{clientName}},

Your consultation scheduled for {{appointmentWhen}} has been cancelled.

We will contact you to arrange an alternative time.

{{firmName}}`,
  },
  {
    key: 'internal.proposal_pending',
    subject: 'New consultation to approve — {{practiceArea}}',
    description: 'Sent to the lawyer when a slot is proposed. Internal only.',
    bodyMd: `A new enquiry has been triaged and a consultation slot proposed for you.

Proposed: {{appointmentWhen}}
Practice area: {{practiceArea}}
Urgency: {{urgency}}

No invitation has been sent to the enquirer. Nothing reaches them until you accept.

Review and decide: {{dashboardUrl}}`,
  },
  {
    key: 'internal.client_reschedule_requested',
    subject: 'A client has asked to move their consultation',
    description:
      'Sent to the lawyer when a client uses the reschedule link (FR-3.8). Internal only.',
    bodyMd: `{{lawyerName}},

A client has asked to move a consultation that is already in your diary.

Currently booked: {{currentWhen}}
They have asked for: {{requestedWhen}}

Nothing has changed yet. The existing appointment stands, and their calendar entry is untouched, until you accept — at which point it moves in place rather than being issued twice.

Accept, offer another time, or decline: {{dashboardUrl}}`,
  },
];

async function seedMessageTemplates(): Promise<void> {
  for (const template of MESSAGE_TEMPLATES) {
    await db
      .insert(messageTemplates)
      .values({
        key: template.key,
        subject: template.subject,
        bodyMd: template.bodyMd,
        description: template.description,
      })
      .onConflictDoNothing();
  }
  console.log(`  message templates: ${MESSAGE_TEMPLATES.length} ensured`);
}

/**
 * Malaysian federal holidays plus Selangor (PJ) and Perak (Ipoh) state
 * holidays for the go-live year (FR-9.2).
 *
 * Dates that move with the lunar/Islamic calendar are approximate until the
 * federal gazette confirms them; the admin console lets the practice manager
 * correct any date, which is why these are seeded with onConflictDoNothing.
 */
const HOLIDAYS_2026: Array<{ date: string; name: string; office?: 'KL' | 'PJ' | 'IPOH' }> = [
  { date: '2026-01-01', name: "New Year's Day" },
  { date: '2026-02-01', name: 'Federal Territory Day', office: 'KL' },
  { date: '2026-02-17', name: 'Chinese New Year' },
  { date: '2026-02-18', name: 'Chinese New Year (second day)' },
  { date: '2026-03-20', name: 'Hari Raya Aidilfitri' },
  { date: '2026-03-21', name: 'Hari Raya Aidilfitri (second day)' },
  { date: '2026-05-01', name: 'Labour Day' },
  { date: '2026-05-27', name: 'Hari Raya Haji' },
  { date: '2026-05-31', name: 'Wesak Day' },
  { date: '2026-06-01', name: "Agong's Birthday" },
  { date: '2026-06-17', name: 'Awal Muharram' },
  { date: '2026-07-07', name: 'Sultan of Perak Birthday', office: 'IPOH' },
  { date: '2026-08-26', name: 'Prophet Muhammad Birthday' },
  { date: '2026-08-31', name: 'National Day' },
  { date: '2026-09-16', name: 'Malaysia Day' },
  { date: '2026-11-08', name: 'Deepavali' },
  { date: '2026-12-11', name: 'Sultan of Selangor Birthday', office: 'PJ' },
  { date: '2026-12-25', name: 'Christmas Day' },
];

async function seedHolidays(): Promise<void> {
  for (const holiday of HOLIDAYS_2026) {
    await db
      .insert(publicHolidays)
      .values({ date: holiday.date, name: holiday.name, office: holiday.office ?? null })
      .onConflictDoNothing();
  }
  console.log(`  public holidays: ${HOLIDAYS_2026.length} ensured`);
}

async function seedFeatureFlags(): Promise<void> {
  // Global defaults (roleId null = applies unless a role-specific row overrides).
  for (const key of Object.values(FEATURE_FLAGS)) {
    await db
      .insert(featureFlags)
      .values({ key, roleId: null, enabled: true })
      .onConflictDoNothing();
  }
  console.log(`  feature flags: ${Object.values(FEATURE_FLAGS).length} ensured`);
}

async function main(): Promise<void> {
  console.log('Seeding reference data…');
  const permissionIds = await seedPermissions();
  await seedRoles(permissionIds);
  await seedProcedureStages();
  await seedMessageTemplates();
  await seedHolidays();
  await seedFeatureFlags();

  const [{ count } = { count: 0 }] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(rolesTable);
  console.log(`Seed complete. ${count} roles present.`);
  await getPool().end();
}

main().catch((error: unknown) => {
  console.error('Seed failed:', error);
  process.exit(1);
});

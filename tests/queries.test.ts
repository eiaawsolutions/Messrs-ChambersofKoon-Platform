import { beforeAll, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { db, stopPool } from '@/lib/db/client';
import { matters, roles, users } from '@/lib/db/schema';
import { loadGrants, type Actor } from '@/lib/auth/guard';
import { ROLE_NAMES } from '@/lib/auth/permissions';
import {
  documentVersionList,
  getMatterDetail,
  listMatters,
  matterAppointments,
  matterDocuments,
  matterMessages,
  matterParticipantList,
  matterTimeline,
  stagesForMatter,
} from '@/lib/queries/matters';
import {
  draftsAwaitingReview,
  enquiriesNeedingReview,
  needsHumanReviewCount,
  openExceptionsFor,
  pendingProposalsFor,
} from '@/lib/queries/dashboard';
import { auditActionOptions, auditCsv, listAuditEvents } from '@/lib/queries/audit';
import { activeTemplatesFor } from '@/lib/queries/documents';
import { operationsSnapshot } from '@/lib/queries/operations';
import { heldEnquiries } from '@/lib/intake/duplicate-check';
import { retentionDue } from '@/lib/privacy/retention';
import { exportClientData, searchClients } from '@/lib/privacy/subject-request';
import { listSavedSearches } from '@/lib/rag/saved-searches';
import {
  listAvailability,
  listFeatureFlags,
  listPermissions,
  listRoles,
  listUsers,
} from '@/lib/admin/service';

/**
 * Smoke test over every read model, against a real database.
 *
 * These do not assert on content — they assert that each query *executes*.
 * A join written in the wrong order is valid TypeScript and valid-looking
 * Drizzle, and only fails when Postgres resolves it: `matterTimeline` shipped
 * with `matters` joined after a condition that read from it, which produced
 * "missing FROM-clause entry" (42P01) and broke the entire matter page. No
 * amount of typechecking would have caught it; one execution does.
 *
 * Requires the local database from the README plus `npm run db:seed`.
 */

let actor: Actor;
let matterId: string | null = null;

beforeAll(async () => {
  const [role] = await db
    .select({ id: roles.id })
    .from(roles)
    .where(eq(roles.name, ROLE_NAMES.MANAGING_PARTNER))
    .limit(1);

  if (!role) throw new Error('Seed the database first: npm run db:seed');

  // A synthetic in-memory actor; no user row is created by this suite.
  actor = {
    id: '00000000-0000-0000-0000-0000000000aa',
    email: 'query-smoke@chambersofkoon.com.my',
    fullName: 'Query Smoke',
    roleId: role.id,
    roleName: ROLE_NAMES.MANAGING_PARTNER,
    office: 'KL',
    status: 'active',
    practiceAreas: null,
    grants: await loadGrants(role.id),
    masksClientIdentifiers: false,
    sessionEpoch: 0,
  };

  const [anyMatter] = await db.select({ id: matters.id }).from(matters).limit(1);
  matterId = anyMatter?.id ?? null;
});

describe('dashboard read models execute', () => {
  it('pendingProposalsFor', async () => {
    await expect(pendingProposalsFor(actor)).resolves.toBeInstanceOf(Array);
  });
  it('draftsAwaitingReview', async () => {
    await expect(draftsAwaitingReview(actor)).resolves.toBeInstanceOf(Array);
  });
  it('openExceptionsFor', async () => {
    await expect(openExceptionsFor(actor)).resolves.toBeInstanceOf(Array);
  });
  it('needsHumanReviewCount', async () => {
    await expect(needsHumanReviewCount(actor)).resolves.toBeTypeOf('number');
  });
  it('enquiriesNeedingReview', async () => {
    await expect(enquiriesNeedingReview(actor)).resolves.toBeInstanceOf(Array);
  });

  it('the per-office view executes for every office (FR-8.5)', async () => {
    for (const office of ['KL', 'PJ', 'IPOH'] as const) {
      await expect(pendingProposalsFor(actor, office)).resolves.toBeInstanceOf(Array);
      await expect(enquiriesNeedingReview(actor, office)).resolves.toBeInstanceOf(Array);
      await expect(needsHumanReviewCount(actor, office)).resolves.toBeTypeOf('number');
    }
  });

  it('the enquiry scope predicate executes at every scope', async () => {
    // The office branch adds a practice-area disjunction over enquiries, which
    // is a different table from the one matterScopeFilter reads.
    for (const scope of ['all', 'office', 'own'] as const) {
      const scoped: Actor = {
        ...actor,
        practiceAreas: scope === 'office' ? ['family_matrimonial'] : null,
        grants: { ...actor.grants, 'intake.view': scope, 'proposal.decide': scope },
      };
      await expect(enquiriesNeedingReview(scoped)).resolves.toBeInstanceOf(Array);
      await expect(pendingProposalsFor(scoped)).resolves.toBeInstanceOf(Array);
    }
  });

  it('heldEnquiries (FR-2.8)', async () => {
    await expect(heldEnquiries()).resolves.toBeInstanceOf(Array);
  });
});

describe('operations and privacy read models execute', () => {
  /*
   * These carry the most hand-written SQL in the project — a generated date
   * series, aggregate FILTER clauses and five scalar subqueries in one
   * statement. None of it is checked by tsc.
   */
  it('operationsSnapshot (NFR-4.3)', async () => {
    const snapshot = await operationsSnapshot();

    // 14 days, gaps filled. A shorter array means the generated series was
    // dropped and quiet days are silently missing from the chart.
    expect(snapshot.enquiriesPerDay).toHaveLength(14);
    expect(snapshot.enquiriesPerDay.every((d) => /^\d{4}-\d{2}-\d{2}$/.test(d.day))).toBe(true);
    expect(snapshot.enquiriesPerDay.every((d) => Number.isFinite(d.count))).toBe(true);
    expect(snapshot.proposalsPending).toBeTypeOf('number');
    expect(snapshot.email30d.bounced).toBeTypeOf('number');
    expect(snapshot.aiSpend.monthToDateUsd).toBeTypeOf('number');
  });

  it('retentionDue (NFR-2.2)', async () => {
    const due = await retentionDue();
    expect(due.enquiries).toBeTypeOf('number');
    expect(due.messages).toBeTypeOf('number');
  });

  it('searchClients, with and without a term (NFR-2.3)', async () => {
    await expect(searchClients('')).resolves.toBeInstanceOf(Array);
    await expect(searchClients('tan')).resolves.toBeInstanceOf(Array);
  });

  it('exportClientData returns null for an unknown client', async () => {
    await expect(
      exportClientData({ actor, clientId: '00000000-0000-0000-0000-0000000000ff' }),
    ).resolves.toBeNull();
  });

  it('listSavedSearches (FR-8.5)', async () => {
    await expect(listSavedSearches(actor)).resolves.toBeInstanceOf(Array);
  });
});

describe('matter read models execute', () => {
  it('listMatters, unfiltered', async () => {
    await expect(listMatters(actor)).resolves.toBeInstanceOf(Array);
  });

  it('listMatters, with a search term and status', async () => {
    // The search predicate joins clients; a wrong join order shows up here.
    await expect(listMatters(actor, { search: 'divorce', status: 'open' })).resolves.toBeInstanceOf(
      Array,
    );
  });

  it('every per-matter query executes', async () => {
    if (!matterId) return; // nothing seeded; the suite above still covers the rest

    await expect(getMatterDetail(actor, matterId)).resolves.toBeTruthy();
    await expect(matterTimeline(actor, matterId)).resolves.toBeInstanceOf(Array);
    await expect(matterDocuments(actor, matterId)).resolves.toBeInstanceOf(Array);
    await expect(matterAppointments(actor, matterId)).resolves.toBeInstanceOf(Array);
    await expect(matterMessages(actor, matterId)).resolves.toBeInstanceOf(Array);
    await expect(matterParticipantList(actor, matterId)).resolves.toBeInstanceOf(Array);
    await expect(stagesForMatter(matterId)).resolves.toBeInstanceOf(Array);
  });

  it('documentVersionList tolerates an unknown document', async () => {
    await expect(
      documentVersionList(actor, '00000000-0000-0000-0000-0000000000ff'),
    ).resolves.toBeNull();
  });

  it('activeTemplatesFor', async () => {
    await expect(activeTemplatesFor('family_matrimonial')).resolves.toBeInstanceOf(Array);
  });
});

describe('audit read models execute', () => {
  it('listAuditEvents, unfiltered', async () => {
    await expect(listAuditEvents(actor)).resolves.toBeInstanceOf(Array);
  });

  it('listAuditEvents, every filter at once', async () => {
    await expect(
      listAuditEvents(actor, {
        actor: 'chambersofkoon',
        action: 'auth.login.success',
        from: '2020-01-01',
        to: '2030-01-01',
      }),
    ).resolves.toBeInstanceOf(Array);
  });

  it('office-scoped audit predicate executes', async () => {
    // The office branch uses correlated EXISTS subqueries over users and matters.
    const officeScoped: Actor = {
      ...actor,
      grants: { ...actor.grants, 'audit.view': 'office' },
    };
    await expect(listAuditEvents(officeScoped)).resolves.toBeInstanceOf(Array);
  });

  it('auditActionOptions', async () => {
    await expect(auditActionOptions(actor)).resolves.toBeInstanceOf(Array);
  });

  it('auditCsv produces a header row', async () => {
    const csv = await auditCsv(actor, {});
    expect(csv.split('\r\n')[0]).toContain('occurred_at');
  });
});

describe('admin read models execute', () => {
  it('listUsers', async () => {
    await expect(listUsers()).resolves.toBeInstanceOf(Array);
  });
  it('listRoles', async () => {
    await expect(listRoles()).resolves.toBeInstanceOf(Array);
  });
  it('listPermissions', async () => {
    await expect(listPermissions()).resolves.toBeInstanceOf(Array);
  });
  it('listAvailability', async () => {
    await expect(listAvailability()).resolves.toBeInstanceOf(Array);
  });
  it('listFeatureFlags', async () => {
    await expect(listFeatureFlags()).resolves.toBeInstanceOf(Array);
  });
});

describe('scope filters execute for every role shape', () => {
  it('own-scope and index-scope predicates run', async () => {
    for (const scope of ['own', 'office', 'index', 'all'] as const) {
      const scoped: Actor = {
        ...actor,
        grants: { ...actor.grants, 'matter.view': scope },
      };
      await expect(listMatters(scoped)).resolves.toBeInstanceOf(Array);
    }
  });

  it('a practice-area-restricted office actor runs', async () => {
    const partner: Actor = {
      ...actor,
      practiceAreas: ['family_matrimonial', 'debt_recovery'],
      grants: { ...actor.grants, 'matter.view': 'office' },
    };
    await expect(listMatters(partner)).resolves.toBeInstanceOf(Array);
  });
});

describe('database connectivity', () => {
  it('is reachable', async () => {
    const [row] = await db.execute<{ ok: number }>(sql`select 1 as ok`).then((r) => r.rows);
    expect(row?.ok).toBe(1);
    await stopPool();
  });
});

// Keep the users import used — the actor is synthetic by design.
void users;

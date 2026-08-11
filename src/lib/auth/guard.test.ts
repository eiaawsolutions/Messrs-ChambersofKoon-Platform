import { describe, expect, it } from 'vitest';
import { can, canReadMatterContents, grantedScope, assertCan, AuthorizationError } from './guard';
import type { Actor, MatterLike } from './guard';
import { PERMISSIONS, ROLE_NAMES } from './permissions';

/**
 * Permission matrix tests (PRD §2.2, AT-05, AT-06, AT-07).
 *
 * These are pure-function tests over the decision logic. The SQL-filter half of
 * the guard is covered by the integration tests in tests/rag-scoping.test.ts,
 * which run against a real database — a predicate that looks right and a
 * predicate that actually excludes rows are different claims.
 */

function actor(overrides: Partial<Actor> = {}): Actor {
  return {
    id: 'user-1',
    email: 'a@chambersofkoon.com.my',
    fullName: 'Test User',
    roleId: 'role-1',
    roleName: ROLE_NAMES.ASSOCIATE,
    office: 'KL',
    status: 'active',
    practiceAreas: null,
    grants: {},
    masksClientIdentifiers: false,
    sessionEpoch: 0,
    ...overrides,
  };
}

function matter(overrides: Partial<MatterLike> = {}): MatterLike {
  return {
    id: 'matter-1',
    office: 'KL',
    practiceArea: 'family_matrimonial',
    assignedUserId: null,
    supervisingUserId: null,
    participantUserIds: [],
    ...overrides,
  };
}

describe('can() — scope: all', () => {
  const managingPartner = actor({
    roleName: ROLE_NAMES.MANAGING_PARTNER,
    grants: { [PERMISSIONS.MATTER_VIEW]: 'all', [PERMISSIONS.DOCUMENT_FINALISE]: 'all' },
  });

  it('grants access to a matter in another office', () => {
    expect(can(managingPartner, PERMISSIONS.MATTER_VIEW, matter({ office: 'IPOH' }))).toBe(true);
  });

  it('grants access to a matter assigned to someone else', () => {
    expect(
      can(managingPartner, PERMISSIONS.DOCUMENT_FINALISE, matter({ assignedUserId: 'other' })),
    ).toBe(true);
  });

  it('still refuses a permission the role does not hold', () => {
    expect(can(managingPartner, PERMISSIONS.RAG_SEARCH, matter())).toBe(false);
  });
});

describe('can() — scope: office', () => {
  const partner = actor({
    roleName: ROLE_NAMES.PARTNER,
    office: 'PJ',
    grants: { [PERMISSIONS.MATTER_VIEW]: 'office' },
  });

  it('grants access within the same office', () => {
    expect(can(partner, PERMISSIONS.MATTER_VIEW, matter({ office: 'PJ' }))).toBe(true);
  });

  it('refuses access to another office', () => {
    expect(can(partner, PERMISSIONS.MATTER_VIEW, matter({ office: 'KL' }))).toBe(false);
  });

  it('narrows to the practice areas the partner leads when set', () => {
    const familyLead = actor({
      office: 'PJ',
      practiceAreas: ['family_matrimonial'],
      grants: { [PERMISSIONS.MATTER_VIEW]: 'office' },
    });
    expect(
      can(
        familyLead,
        PERMISSIONS.MATTER_VIEW,
        matter({ office: 'PJ', practiceArea: 'family_matrimonial' }),
      ),
    ).toBe(true);
    expect(
      can(
        familyLead,
        PERMISSIONS.MATTER_VIEW,
        matter({ office: 'PJ', practiceArea: 'debt_recovery' }),
      ),
    ).toBe(false);
  });

  it('treats an empty practice-area list as all areas in the office', () => {
    const generalist = actor({
      office: 'PJ',
      practiceAreas: [],
      grants: { [PERMISSIONS.MATTER_VIEW]: 'office' },
    });
    expect(
      can(
        generalist,
        PERMISSIONS.MATTER_VIEW,
        matter({ office: 'PJ', practiceArea: 'land_property' }),
      ),
    ).toBe(true);
  });
});

describe('can() — scope: own', () => {
  const associate = actor({
    id: 'assoc-1',
    grants: { [PERMISSIONS.MATTER_VIEW]: 'own', [PERMISSIONS.DOCUMENT_GENERATE]: 'own' },
  });

  it('grants access when the actor is the assignee', () => {
    expect(can(associate, PERMISSIONS.MATTER_VIEW, matter({ assignedUserId: 'assoc-1' }))).toBe(
      true,
    );
  });

  it('grants access when the actor is the supervisor', () => {
    expect(can(associate, PERMISSIONS.MATTER_VIEW, matter({ supervisingUserId: 'assoc-1' }))).toBe(
      true,
    );
  });

  it('grants access when the actor is an explicit participant', () => {
    expect(
      can(associate, PERMISSIONS.MATTER_VIEW, matter({ participantUserIds: ['assoc-1'] })),
    ).toBe(true);
  });

  it('refuses an unrelated matter in the same office', () => {
    expect(
      can(associate, PERMISSIONS.MATTER_VIEW, matter({ assignedUserId: 'someone-else' })),
    ).toBe(false);
  });
});

describe('AT-06 — a pupil cannot finalise', () => {
  const pupil = actor({
    id: 'pupil-1',
    roleName: ROLE_NAMES.PUPIL,
    masksClientIdentifiers: true,
    grants: {
      [PERMISSIONS.MATTER_VIEW]: 'own',
      [PERMISSIONS.DOCUMENT_VIEW]: 'own',
      [PERMISSIONS.DOCUMENT_GENERATE]: 'own',
      [PERMISSIONS.RAG_SEARCH]: 'own',
    },
  });
  const ownMatter = matter({ assignedUserId: 'pupil-1' });

  it('allows drafting on their own matter', () => {
    expect(can(pupil, PERMISSIONS.DOCUMENT_GENERATE, ownMatter)).toBe(true);
  });

  it('blocks finalisation even on their own matter', () => {
    expect(can(pupil, PERMISSIONS.DOCUMENT_FINALISE, ownMatter)).toBe(false);
  });

  it('throws AuthorizationError from assertCan without leaking the reason', () => {
    expect(() => assertCan(pupil, PERMISSIONS.DOCUMENT_FINALISE, ownMatter)).toThrow(
      AuthorizationError,
    );
    expect(() => assertCan(pupil, PERMISSIONS.DOCUMENT_FINALISE, ownMatter)).toThrow(
      'Not authorised',
    );
  });

  it('blocks approving an appointment slot', () => {
    expect(can(pupil, PERMISSIONS.PROPOSAL_DECIDE, ownMatter)).toBe(false);
  });

  it('blocks the intake queue entirely', () => {
    expect(can(pupil, PERMISSIONS.INTAKE_VIEW)).toBe(false);
  });
});

describe('AT-07 — a suspended user loses access on the next request', () => {
  const suspended = actor({
    status: 'suspended',
    grants: { [PERMISSIONS.MATTER_VIEW]: 'all', [PERMISSIONS.ADMIN_USERS_MANAGE]: 'all' },
  });

  it('refuses every permission regardless of grants', () => {
    expect(can(suspended, PERMISSIONS.MATTER_VIEW, matter())).toBe(false);
    expect(can(suspended, PERMISSIONS.ADMIN_USERS_MANAGE)).toBe(false);
    expect(grantedScope(suspended, PERMISSIONS.MATTER_VIEW)).toBeNull();
  });

  it('also refuses an invited-but-not-yet-active user', () => {
    const invited = actor({ status: 'invited', grants: { [PERMISSIONS.MATTER_VIEW]: 'all' } });
    expect(can(invited, PERMISSIONS.MATTER_VIEW, matter())).toBe(false);
  });
});

describe('index scope — practice manager sees the index, never the contents', () => {
  const practiceManager = actor({
    roleName: ROLE_NAMES.PRACTICE_MANAGER,
    grants: {
      [PERMISSIONS.MATTER_VIEW]: 'index',
      [PERMISSIONS.ADMIN_USERS_ONBOARD]: 'all',
    },
  });

  it('may list a matter', () => {
    expect(can(practiceManager, PERMISSIONS.MATTER_VIEW, matter())).toBe(true);
  });

  it('may not read document contents', () => {
    expect(canReadMatterContents(practiceManager, matter())).toBe(false);
  });

  it('may not generate a draft', () => {
    expect(can(practiceManager, PERMISSIONS.DOCUMENT_GENERATE, matter())).toBe(false);
  });

  it('retains its delegated onboarding capability', () => {
    expect(can(practiceManager, PERMISSIONS.ADMIN_USERS_ONBOARD)).toBe(true);
  });

  it('may not manage roles', () => {
    expect(can(practiceManager, PERMISSIONS.ADMIN_ROLES_MANAGE)).toBe(false);
  });
});

describe('legal executive — delegated proposal decisions', () => {
  const clerk = actor({
    id: 'clerk-1',
    roleName: ROLE_NAMES.LEGAL_EXECUTIVE,
    grants: {
      [PERMISSIONS.MATTER_STATUS_RECORD]: 'own',
      [PERMISSIONS.PROPOSAL_DECIDE]: 'own',
      [PERMISSIONS.INTAKE_VIEW]: 'office',
    },
  });

  it('may record a procedural status on their own matter', () => {
    expect(
      can(clerk, PERMISSIONS.MATTER_STATUS_RECORD, matter({ assignedUserId: 'clerk-1' })),
    ).toBe(true);
  });

  it('may not generate AI drafts', () => {
    expect(can(clerk, PERMISSIONS.DOCUMENT_GENERATE, matter({ assignedUserId: 'clerk-1' }))).toBe(
      false,
    );
  });

  it('may not run precedent search', () => {
    expect(can(clerk, PERMISSIONS.RAG_SEARCH, matter({ assignedUserId: 'clerk-1' }))).toBe(false);
  });
});

describe('permission held but no matter supplied', () => {
  it('answers the capability question, not the row question', () => {
    const a = actor({ grants: { [PERMISSIONS.ADMIN_USERS_MANAGE]: 'all' } });
    expect(can(a, PERMISSIONS.ADMIN_USERS_MANAGE)).toBe(true);
  });

  it('returns false for an ungranted permission', () => {
    expect(can(actor(), PERMISSIONS.ADMIN_USERS_MANAGE)).toBe(false);
  });
});

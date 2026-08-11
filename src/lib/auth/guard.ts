import 'server-only';
import { and, eq, exists, isNull, or, type SQL } from 'drizzle-orm';
import { db } from '@/lib/db/client';
import { matters, matterParticipants, rolePermissions, permissions, roles } from '@/lib/db/schema';
import {
  PERMISSIONS,
  SCOPE_RANK,
  ROLE_NAMES,
  type PermissionKey,
  type Scope,
} from '@/lib/auth/permissions';
import type { Office, PracticeArea } from '@/lib/db/schema';

/**
 * THE single sanctioned authorisation path (FR-1.5).
 *
 * "A permission helper — can(user, 'document.finalise', matter) — is the only
 *  sanctioned access path; direct queries in route handlers without a scope
 *  filter fail code review."
 *
 * Two complementary primitives:
 *
 *   can(actor, permission, matter?)  — a yes/no decision about one known row.
 *   matterScopeFilter(actor, perm)   — a SQL predicate to compose into a list
 *                                      query, so unauthorised rows are never
 *                                      fetched in the first place.
 *
 * The second is the one that matters for FR-6.2 (a pupil's precedent search
 * must not surface an excerpt from a matter they cannot open). Filtering after
 * ranking would leak the existence and relevance of hidden matters; the filter
 * therefore runs *before* ranking, inside the query.
 */

export interface Actor {
  id: string;
  email: string;
  fullName: string;
  roleId: string;
  roleName: string;
  office: Office;
  status: 'invited' | 'active' | 'suspended';
  practiceAreas: PracticeArea[] | null;
  /** permission key -> highest granted scope */
  grants: Partial<Record<PermissionKey, Scope>>;
  masksClientIdentifiers: boolean;
  sessionEpoch: number;
}

export class AuthorizationError extends Error {
  readonly permission: PermissionKey;
  readonly matterId: string | undefined;

  constructor(permission: PermissionKey, matterId?: string) {
    // Deliberately generic: no hint about whether the row exists
    // (penetration-testing.md — no resource enumeration via error text).
    super('Not authorised');
    this.name = 'AuthorizationError';
    this.permission = permission;
    this.matterId = matterId;
  }
}

/** Minimal shape needed to make a matter-scoped decision. */
export interface MatterLike {
  id: string;
  office: Office;
  practiceArea: PracticeArea;
  assignedUserId: string | null;
  supervisingUserId: string | null;
  /** Populated only when the caller already knows participation. */
  participantUserIds?: string[];
}

/** Load a user's effective grants (permission -> highest scope). */
export async function loadGrants(roleId: string): Promise<Partial<Record<PermissionKey, Scope>>> {
  const rows = await db
    .select({ key: permissions.key, scope: rolePermissions.scope })
    .from(rolePermissions)
    .innerJoin(permissions, eq(permissions.id, rolePermissions.permissionId))
    .where(eq(rolePermissions.roleId, roleId));

  const grants: Partial<Record<PermissionKey, Scope>> = {};
  for (const row of rows) {
    const key = row.key as PermissionKey;
    const scope = row.scope as Scope;
    const existing = grants[key];
    // Permissions are additive; keep the widest scope granted.
    if (!existing || SCOPE_RANK[scope] > SCOPE_RANK[existing]) {
      grants[key] = scope;
    }
  }
  return grants;
}

export async function roleMasksIdentifiers(roleId: string): Promise<boolean> {
  const [row] = await db.select({ name: roles.name }).from(roles).where(eq(roles.id, roleId));
  return row?.name === ROLE_NAMES.PUPIL;
}

/** Scope a user holds for a permission, or null if not granted at all. */
export function grantedScope(actor: Actor, permission: PermissionKey): Scope | null {
  if (actor.status !== 'active') return null;
  return actor.grants[permission] ?? null;
}

/**
 * Does `actor` hold `permission`, optionally against a specific matter?
 *
 * Called without a matter, this answers "could this user ever do this?" —
 * correct for global capabilities (admin.users.manage) and for rendering nav.
 * It is NOT sufficient for a matter-scoped action; pass the matter.
 */
export function can(actor: Actor, permission: PermissionKey, matter?: MatterLike): boolean {
  const scope = grantedScope(actor, permission);
  if (scope === null) return false;
  if (!matter) return true;

  switch (scope) {
    case 'all':
      return true;

    case 'office': {
      if (matter.office !== actor.office) return false;
      // A partner scoped to specific practice areas only sees those areas.
      // An empty/absent list means "all areas in my office".
      if (actor.practiceAreas && actor.practiceAreas.length > 0) {
        return actor.practiceAreas.includes(matter.practiceArea);
      }
      return true;
    }

    case 'own':
      return (
        matter.assignedUserId === actor.id ||
        matter.supervisingUserId === actor.id ||
        (matter.participantUserIds?.includes(actor.id) ?? false)
      );

    case 'index':
      // Index scope may list a matter but never read its contents.
      return permission === PERMISSIONS.MATTER_VIEW;

    default:
      return false;
  }
}

/** `can`, but throws. Use at the top of every mutating action. */
export function assertCan(actor: Actor, permission: PermissionKey, matter?: MatterLike): void {
  if (!can(actor, permission, matter)) {
    throw new AuthorizationError(permission, matter?.id);
  }
}

/**
 * Index scope grants metadata only — no document contents, no client
 * identifiers (PRD §2.2, practice manager row).
 */
export function canReadMatterContents(actor: Actor, matter: MatterLike): boolean {
  const scope = grantedScope(actor, PERMISSIONS.MATTER_VIEW);
  if (scope === 'index') return false;
  return can(actor, PERMISSIONS.DOCUMENT_VIEW, matter);
}

/**
 * SQL predicate restricting `matters` to those the actor may access under
 * `permission`. Compose into any list/search query:
 *
 *   const scope = matterScopeFilter(actor, PERMISSIONS.RAG_SEARCH);
 *   if (scope === DENY_ALL) return [];
 *   db.select().from(chunks).where(and(scope, ...));
 *
 * Returns `null` when the actor has unrestricted access (no filter needed) and
 * DENY_ALL when they have none.
 */
export const DENY_ALL: SQL = eq(matters.id, '00000000-0000-0000-0000-000000000000');

export function matterScopeFilter(actor: Actor, permission: PermissionKey): SQL | null {
  const scope = grantedScope(actor, permission);
  if (scope === null) return DENY_ALL;

  switch (scope) {
    case 'all':
      return null;

    case 'office': {
      const officeMatch = eq(matters.office, actor.office);
      if (actor.practiceAreas && actor.practiceAreas.length > 0) {
        const areaMatch = or(...actor.practiceAreas.map((area) => eq(matters.practiceArea, area)));
        return and(officeMatch, areaMatch!)!;
      }
      return officeMatch;
    }

    case 'own':
    case 'index':
      return or(
        eq(matters.assignedUserId, actor.id),
        eq(matters.supervisingUserId, actor.id),
        exists(
          db
            .select({ one: matterParticipants.userId })
            .from(matterParticipants)
            .where(
              and(
                eq(matterParticipants.matterId, matters.id),
                eq(matterParticipants.userId, actor.id),
              ),
            ),
        ),
      )!;

    default:
      return DENY_ALL;
  }
}

/**
 * Load a matter and authorise in one step. Returns null when the matter does
 * not exist OR the actor may not see it — the caller cannot distinguish the
 * two, which is what prevents matter-existence enumeration (IDOR hardening).
 */
export async function getAuthorisedMatter(
  actor: Actor,
  matterId: string,
  permission: PermissionKey = PERMISSIONS.MATTER_VIEW,
): Promise<MatterLike | null> {
  const [row] = await db
    .select({
      id: matters.id,
      office: matters.office,
      practiceArea: matters.practiceArea,
      assignedUserId: matters.assignedUserId,
      supervisingUserId: matters.supervisingUserId,
    })
    .from(matters)
    .where(eq(matters.id, matterId))
    .limit(1);

  if (!row) return null;

  const participants = await db
    .select({ userId: matterParticipants.userId })
    .from(matterParticipants)
    .where(eq(matterParticipants.matterId, matterId));

  const matter: MatterLike = {
    ...row,
    participantUserIds: participants.map((p) => p.userId),
  };

  return can(actor, permission, matter) ? matter : null;
}

/**
 * Chunk-level scope predicate for retrieval (FR-6.2).
 *
 * Chunks with a null matter_id are firm-wide precedent (uploaded templates and
 * unassigned archive material) and are visible to anyone holding rag.search —
 * they carry no client-matter confidentiality by construction. Everything else
 * must pass the matter filter.
 *
 * Returns a predicate over a `matters`-joined query.
 */
export function chunkScopeFilter(actor: Actor, matterIdColumn: SQL | null = null): SQL | null {
  const scope = grantedScope(actor, PERMISSIONS.RAG_SEARCH);
  if (scope === null) return DENY_ALL;
  if (scope === 'all') return null;

  const matterFilter = matterScopeFilter(actor, PERMISSIONS.RAG_SEARCH);
  if (matterFilter === null) return null;

  void matterIdColumn;
  return or(isNull(matters.id), matterFilter)!;
}

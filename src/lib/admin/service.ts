import 'server-only';
import { and, asc, eq, sql } from 'drizzle-orm';
import { db } from '@/lib/db/client';
import {
  availabilityRules,
  featureFlags,
  messageTemplates,
  permissions as permissionsTable,
  rolePermissions,
  roles,
  users,
  type Office,
  type PracticeArea,
} from '@/lib/db/schema';
import { audit, AUDIT_ACTIONS } from '@/lib/audit/log';
import { revokeSessions } from '@/lib/auth/session';
import { invalidateTemplateCache } from '@/lib/comms/templates';
import { SCOPES, type Scope } from '@/lib/auth/permissions';
import type { Actor } from '@/lib/auth/guard';

/**
 * Administration (M9, FR-9.1 – FR-9.5).
 *
 * Authorisation is done by the calling server action, which holds the request
 * context needed to audit a denial.
 *
 * Two rules are enforced here rather than in the UI, because the UI is not a
 * control surface:
 *  - a seeded (system) role cannot be deleted;
 *  - the last active Managing Partner cannot be suspended or demoted, which
 *    would leave the firm with nobody able to administer the platform.
 */

export async function listUsers() {
  return db
    .select({
      id: users.id,
      email: users.email,
      fullName: users.fullName,
      office: users.office,
      status: users.status,
      practiceAreas: users.practiceAreas,
      roleId: users.roleId,
      roleName: roles.name,
      lastLoginAt: users.lastLoginAt,
    })
    .from(users)
    .innerJoin(roles, eq(roles.id, users.roleId))
    .orderBy(asc(users.fullName));
}

export async function listRoles() {
  return db
    .select({
      id: roles.id,
      name: roles.name,
      description: roles.description,
      isSystem: roles.isSystem,
      userCount: sql<number>`(select count(*)::int from users u where u.role_id = ${roles.id})`,
      permissionCount: sql<number>`(
        select count(*)::int from role_permissions rp where rp.role_id = ${roles.id}
      )`,
    })
    .from(roles)
    .orderBy(asc(roles.name));
}

export async function listPermissions() {
  return db
    .select()
    .from(permissionsTable)
    .orderBy(asc(permissionsTable.category), asc(permissionsTable.key));
}

export async function grantsForRole(roleId: string): Promise<Record<string, Scope>> {
  const rows = await db
    .select({ key: permissionsTable.key, scope: rolePermissions.scope })
    .from(rolePermissions)
    .innerJoin(permissionsTable, eq(permissionsTable.id, rolePermissions.permissionId))
    .where(eq(rolePermissions.roleId, roleId));

  return Object.fromEntries(rows.map((r) => [r.key, r.scope as Scope]));
}

/** Count of active users holding a role — used to protect the last admin. */
async function activeCountForRoleName(roleName: string): Promise<number> {
  const [row] = await db
    .select({ value: sql<number>`count(*)::int` })
    .from(users)
    .innerJoin(roles, eq(roles.id, users.roleId))
    .where(and(eq(roles.name, roleName), eq(users.status, 'active')));
  return row?.value ?? 0;
}

export class AdminGuardError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AdminGuardError';
  }
}

const MANAGING_PARTNER = 'Managing Partner';

export async function updateUser(params: {
  actor: Actor;
  userId: string;
  roleId?: string;
  office?: Office;
  status?: 'invited' | 'active' | 'suspended';
  practiceAreas?: PracticeArea[] | null;
}): Promise<void> {
  const [target] = await db
    .select({
      id: users.id,
      email: users.email,
      status: users.status,
      roleId: users.roleId,
      roleName: roles.name,
    })
    .from(users)
    .innerJoin(roles, eq(roles.id, users.roleId))
    .where(eq(users.id, params.userId))
    .limit(1);

  if (!target) throw new AdminGuardError('User not found');

  // Do not allow the firm to lock itself out of its own administration.
  const isLastAdmin =
    target.roleName === MANAGING_PARTNER &&
    target.status === 'active' &&
    (await activeCountForRoleName(MANAGING_PARTNER)) <= 1;

  const losingAdmin =
    (params.status && params.status !== 'active') ||
    (params.roleId && params.roleId !== target.roleId);

  if (isLastAdmin && losingAdmin) {
    throw new AdminGuardError(
      'This is the only active Managing Partner. Promote another user first, ' +
        'otherwise nobody could administer the platform.',
    );
  }

  const patch: Record<string, unknown> = {};
  if (params.roleId) patch.roleId = params.roleId;
  if (params.office) patch.office = params.office;
  if (params.status) patch.status = params.status;
  if (params.practiceAreas !== undefined) patch.practiceAreas = params.practiceAreas;
  if (Object.keys(patch).length === 0) return;

  await db.update(users).set(patch).where(eq(users.id, params.userId));

  // A role or status change must not leave a live session with stale grants.
  if (params.roleId || params.status) {
    await revokeSessions(params.userId);
  }

  await audit({
    action:
      params.status === 'suspended'
        ? AUDIT_ACTIONS.USER_SUSPEND
        : params.status === 'active'
          ? AUDIT_ACTIONS.USER_REACTIVATE
          : AUDIT_ACTIONS.USER_UPDATE,
    actorUserId: params.actor.id,
    actorEmail: params.actor.email,
    entityType: 'user',
    entityId: params.userId,
    metadata: { target: target.email, changes: Object.keys(patch), sessionsRevoked: true },
  });
}

/** FR-1.6: reset 2FA — revoke sessions and force IdP re-enrolment. */
export async function resetTwoFactor(params: { actor: Actor; userId: string }): Promise<void> {
  await revokeSessions(params.userId);
  await audit({
    action: AUDIT_ACTIONS.USER_2FA_RESET,
    actorUserId: params.actor.id,
    actorEmail: params.actor.email,
    entityType: 'user',
    entityId: params.userId,
    metadata: { sessionsRevoked: true },
  });
}

export async function createRole(params: {
  actor: Actor;
  name: string;
  description: string;
}): Promise<string> {
  const [role] = await db
    .insert(roles)
    .values({ name: params.name, description: params.description, isSystem: false })
    .returning({ id: roles.id });

  if (!role) throw new AdminGuardError('Could not create the role');

  await audit({
    action: AUDIT_ACTIONS.PERMISSION_CHANGE,
    actorUserId: params.actor.id,
    actorEmail: params.actor.email,
    entityType: 'role',
    entityId: role.id,
    metadata: { created: params.name },
  });

  return role.id;
}

/**
 * Replace a role's grants (FR-9.1).
 *
 * Whole-set replacement rather than incremental toggles: the admin console
 * submits the complete intended state, so a concurrent edit cannot merge two
 * half-changes into a permission set nobody chose.
 */
export async function setRoleGrants(params: {
  actor: Actor;
  roleId: string;
  grants: Record<string, Scope>;
}): Promise<void> {
  const allPermissions = await db
    .select({ id: permissionsTable.id, key: permissionsTable.key })
    .from(permissionsTable);
  const idByKey = new Map(allPermissions.map((p) => [p.key, p.id]));

  const rows = Object.entries(params.grants)
    .filter(([key, scope]) => idByKey.has(key) && SCOPES.includes(scope))
    .map(([key, scope]) => ({ roleId: params.roleId, permissionId: idByKey.get(key)!, scope }));

  await db.delete(rolePermissions).where(eq(rolePermissions.roleId, params.roleId));
  if (rows.length > 0) {
    await db.insert(rolePermissions).values(rows);
  }

  // Everyone holding this role must pick up the change on their next request.
  const holders = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.roleId, params.roleId));
  for (const holder of holders) {
    await revokeSessions(holder.id);
  }

  await audit({
    action: AUDIT_ACTIONS.PERMISSION_CHANGE,
    actorUserId: params.actor.id,
    actorEmail: params.actor.email,
    entityType: 'role',
    entityId: params.roleId,
    metadata: { permissionCount: rows.length, sessionsRevoked: holders.length },
  });
}

export async function deleteRole(params: { actor: Actor; roleId: string }): Promise<void> {
  const [role] = await db
    .select({ id: roles.id, name: roles.name, isSystem: roles.isSystem })
    .from(roles)
    .where(eq(roles.id, params.roleId))
    .limit(1);

  if (!role) throw new AdminGuardError('Role not found');
  if (role.isSystem) throw new AdminGuardError('Seeded roles cannot be deleted');

  const [inUse] = await db
    .select({ value: sql<number>`count(*)::int` })
    .from(users)
    .where(eq(users.roleId, params.roleId));

  if ((inUse?.value ?? 0) > 0) {
    throw new AdminGuardError(
      `${inUse!.value} user(s) still hold this role. Move them to another role first.`,
    );
  }

  await db.delete(roles).where(eq(roles.id, params.roleId));

  await audit({
    action: AUDIT_ACTIONS.PERMISSION_CHANGE,
    actorUserId: params.actor.id,
    actorEmail: params.actor.email,
    entityType: 'role',
    entityId: params.roleId,
    metadata: { deleted: role.name },
  });
}

// ---------------------------------------------------------------------------
// Availability (FR-9.2)
// ---------------------------------------------------------------------------

export async function listAvailability() {
  return db
    .select({
      id: availabilityRules.id,
      userId: availabilityRules.userId,
      userName: users.fullName,
      office: availabilityRules.office,
      practiceArea: availabilityRules.practiceArea,
      weekday: availabilityRules.weekday,
      startTime: availabilityRules.startTime,
      endTime: availabilityRules.endTime,
      slotMinutes: availabilityRules.slotMinutes,
      bufferMinutes: availabilityRules.bufferMinutes,
      isActive: availabilityRules.isActive,
    })
    .from(availabilityRules)
    .innerJoin(users, eq(users.id, availabilityRules.userId))
    .orderBy(asc(users.fullName), asc(availabilityRules.weekday));
}

export async function createAvailabilityRule(params: {
  actor: Actor;
  userId: string;
  office: Office;
  practiceArea: PracticeArea | null;
  weekday: number;
  startTime: string;
  endTime: string;
  slotMinutes: number;
  bufferMinutes: number;
}): Promise<void> {
  await db.insert(availabilityRules).values({
    userId: params.userId,
    office: params.office,
    practiceArea: params.practiceArea,
    weekday: params.weekday,
    startTime: params.startTime,
    endTime: params.endTime,
    slotMinutes: params.slotMinutes,
    bufferMinutes: params.bufferMinutes,
  });

  await audit({
    action: AUDIT_ACTIONS.AVAILABILITY_CHANGE,
    actorUserId: params.actor.id,
    actorEmail: params.actor.email,
    entityType: 'availability_rule',
    entityId: params.userId,
    metadata: { weekday: params.weekday, office: params.office },
  });
}

export async function deleteAvailabilityRule(params: {
  actor: Actor;
  ruleId: string;
}): Promise<void> {
  await db.delete(availabilityRules).where(eq(availabilityRules.id, params.ruleId));
  await audit({
    action: AUDIT_ACTIONS.AVAILABILITY_CHANGE,
    actorUserId: params.actor.id,
    actorEmail: params.actor.email,
    entityType: 'availability_rule',
    entityId: params.ruleId,
    metadata: { deleted: true },
  });
}

// ---------------------------------------------------------------------------
// Feature flags (FR-9.4) and message templates (FR-9.3)
// ---------------------------------------------------------------------------

export async function listFeatureFlags() {
  return db
    .select({
      id: featureFlags.id,
      key: featureFlags.key,
      roleId: featureFlags.roleId,
      roleName: roles.name,
      enabled: featureFlags.enabled,
      updatedAt: featureFlags.updatedAt,
    })
    .from(featureFlags)
    .leftJoin(roles, eq(roles.id, featureFlags.roleId))
    .orderBy(asc(featureFlags.key));
}

export async function setFeatureFlag(params: {
  actor: Actor;
  key: string;
  roleId: string | null;
  enabled: boolean;
}): Promise<void> {
  await db
    .insert(featureFlags)
    .values({
      key: params.key,
      roleId: params.roleId,
      enabled: params.enabled,
      updatedByUserId: params.actor.id,
    })
    .onConflictDoUpdate({
      target: [featureFlags.key, featureFlags.roleId],
      set: { enabled: params.enabled, updatedByUserId: params.actor.id, updatedAt: new Date() },
    });

  await audit({
    action: AUDIT_ACTIONS.FEATURE_FLAG_CHANGE,
    actorUserId: params.actor.id,
    actorEmail: params.actor.email,
    entityType: 'feature_flag',
    metadata: { key: params.key, roleId: params.roleId, enabled: params.enabled },
  });
}

export async function updateMessageTemplate(params: {
  actor: Actor;
  key: string;
  subject: string;
  bodyMd: string;
  isActive: boolean;
}): Promise<void> {
  await db
    .update(messageTemplates)
    .set({ subject: params.subject, bodyMd: params.bodyMd, isActive: params.isActive })
    .where(eq(messageTemplates.key, params.key));

  invalidateTemplateCache(params.key);

  await audit({
    action: AUDIT_ACTIONS.PERMISSION_CHANGE,
    actorUserId: params.actor.id,
    actorEmail: params.actor.email,
    entityType: 'message_template',
    metadata: { key: params.key, isActive: params.isActive },
  });
}

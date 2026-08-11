'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { z } from 'zod';
import { requireActor } from '@/lib/auth/session';
import { assertCan } from '@/lib/auth/guard';
import { PERMISSIONS, SCOPES, type Scope } from '@/lib/auth/permissions';
import {
  createAvailabilityRule,
  createRole,
  createUserWithTemporaryPassword,
  resetTwoFactorEnrolment,
  resetUserPassword,
  unlockUser,
  deleteAvailabilityRule,
  deleteRole,
  resetTwoFactor,
  setFeatureFlag,
  setRoleGrants,
  updateMessageTemplate,
  updateUser,
} from '@/lib/admin/service';

/**
 * Admin server actions (M9).
 *
 * Every action asserts the specific administrative permission it needs.
 * `admin.users.onboard` (the practice manager's delegated capability) is
 * deliberately narrower than `admin.users.manage` — it can activate, suspend
 * and reset 2FA, but not change a role, which is what would let it escalate
 * itself.
 */

const OFFICES = ['KL', 'PJ', 'IPOH'] as const;
const AREAS = [
  'family_matrimonial',
  'debt_recovery',
  'land_property',
  'corporate_disputes',
  'general',
] as const;

const userSchema = z.object({
  userId: z.string().uuid(),
  roleId: z.string().uuid().optional(),
  office: z.enum(OFFICES).optional(),
  status: z.enum(['invited', 'active', 'suspended']).optional(),
  practiceAreas: z.string().optional(),
});

export async function updateUserAction(formData: FormData): Promise<void> {
  const parsed = userSchema.parse({
    userId: formData.get('userId'),
    roleId: formData.get('roleId') || undefined,
    office: formData.get('office') || undefined,
    status: formData.get('status') || undefined,
    practiceAreas: formData.get('practiceAreas') || undefined,
  });

  const actor = await requireActor();

  // Changing a role is escalation-adjacent, so it needs full user management.
  if (parsed.roleId) {
    assertCan(actor, PERMISSIONS.ADMIN_USERS_MANAGE);
  } else {
    if (
      !actor.grants[PERMISSIONS.ADMIN_USERS_MANAGE] &&
      !actor.grants[PERMISSIONS.ADMIN_USERS_ONBOARD]
    ) {
      assertCan(actor, PERMISSIONS.ADMIN_USERS_MANAGE);
    }
  }

  const areas = parsed.practiceAreas
    ? parsed.practiceAreas
        .split(',')
        .map((a) => a.trim())
        .filter((a): a is (typeof AREAS)[number] => (AREAS as readonly string[]).includes(a))
    : undefined;

  await updateUser({
    actor,
    userId: parsed.userId,
    ...(parsed.roleId ? { roleId: parsed.roleId } : {}),
    ...(parsed.office ? { office: parsed.office } : {}),
    ...(parsed.status ? { status: parsed.status } : {}),
    ...(areas !== undefined ? { practiceAreas: areas.length > 0 ? areas : null } : {}),
  });

  revalidatePath('/admin/users');
}

export async function resetTwoFactorAction(formData: FormData): Promise<void> {
  const userId = z.string().uuid().parse(formData.get('userId'));
  const actor = await requireActor();
  if (
    !actor.grants[PERMISSIONS.ADMIN_USERS_MANAGE] &&
    !actor.grants[PERMISSIONS.ADMIN_USERS_ONBOARD]
  ) {
    assertCan(actor, PERMISSIONS.ADMIN_USERS_MANAGE);
  }
  await resetTwoFactor({ actor, userId });
  revalidatePath('/admin/users');
}

const roleSchema = z.object({
  name: z.string().min(2).max(80),
  description: z.string().max(500),
});

export async function createRoleAction(formData: FormData): Promise<void> {
  const parsed = roleSchema.parse({
    name: formData.get('name'),
    description: formData.get('description') ?? '',
  });
  const actor = await requireActor();
  assertCan(actor, PERMISSIONS.ADMIN_ROLES_MANAGE);
  await createRole({ actor, ...parsed });
  revalidatePath('/admin/roles');
}

export async function setRoleGrantsAction(formData: FormData): Promise<void> {
  const roleId = z.string().uuid().parse(formData.get('roleId'));
  const actor = await requireActor();
  assertCan(actor, PERMISSIONS.ADMIN_ROLES_MANAGE);

  // The form submits `grant:<permission.key>` = scope for every checked row.
  const grants: Record<string, Scope> = {};
  for (const [field, value] of formData.entries()) {
    if (!field.startsWith('grant:')) continue;
    const scope = String(value);
    if (scope === 'none' || !SCOPES.includes(scope as Scope)) continue;
    grants[field.slice(6)] = scope as Scope;
  }

  await setRoleGrants({ actor, roleId, grants });
  revalidatePath('/admin/roles');
}

export async function deleteRoleAction(formData: FormData): Promise<void> {
  const roleId = z.string().uuid().parse(formData.get('roleId'));
  const actor = await requireActor();
  assertCan(actor, PERMISSIONS.ADMIN_ROLES_MANAGE);
  await deleteRole({ actor, roleId });
  revalidatePath('/admin/roles');
}

const availabilitySchema = z.object({
  userId: z.string().uuid(),
  office: z.enum(OFFICES),
  practiceArea: z.string().optional(),
  weekday: z.coerce.number().int().min(0).max(6),
  startTime: z.string().regex(/^\d{2}:\d{2}$/),
  endTime: z.string().regex(/^\d{2}:\d{2}$/),
  slotMinutes: z.coerce.number().int().min(5).max(480),
  bufferMinutes: z.coerce.number().int().min(0).max(240),
});

export async function createAvailabilityAction(formData: FormData): Promise<void> {
  const parsed = availabilitySchema.parse(Object.fromEntries(formData.entries()));
  const actor = await requireActor();
  assertCan(actor, PERMISSIONS.ADMIN_AVAILABILITY_MANAGE);

  if (parsed.endTime <= parsed.startTime) {
    throw new Error('The window must end after it starts');
  }

  const area = (AREAS as readonly string[]).includes(parsed.practiceArea ?? '')
    ? (parsed.practiceArea as (typeof AREAS)[number])
    : null;

  await createAvailabilityRule({
    actor,
    userId: parsed.userId,
    office: parsed.office,
    practiceArea: area,
    weekday: parsed.weekday,
    startTime: `${parsed.startTime}:00`,
    endTime: `${parsed.endTime}:00`,
    slotMinutes: parsed.slotMinutes,
    bufferMinutes: parsed.bufferMinutes,
  });

  revalidatePath('/admin/availability');
}

export async function deleteAvailabilityAction(formData: FormData): Promise<void> {
  const ruleId = z.string().uuid().parse(formData.get('ruleId'));
  const actor = await requireActor();
  assertCan(actor, PERMISSIONS.ADMIN_AVAILABILITY_MANAGE);
  await deleteAvailabilityRule({ actor, ruleId });
  revalidatePath('/admin/availability');
}

export async function setFeatureFlagAction(formData: FormData): Promise<void> {
  const key = z.string().min(1).max(80).parse(formData.get('key'));
  const roleIdRaw = formData.get('roleId');
  const roleId = roleIdRaw ? z.string().uuid().parse(roleIdRaw) : null;
  const enabled = formData.get('enabled') === 'on';

  const actor = await requireActor();
  assertCan(actor, PERMISSIONS.ADMIN_FEATURES_MANAGE);

  await setFeatureFlag({ actor, key, roleId, enabled });
  revalidatePath('/admin/features');
}

const templateSchema = z.object({
  key: z.string().min(1).max(120),
  subject: z.string().min(1).max(300),
  bodyMd: z.string().min(1).max(20_000),
});

export async function updateTemplateAction(formData: FormData): Promise<void> {
  const parsed = templateSchema.parse({
    key: formData.get('key'),
    subject: formData.get('subject'),
    bodyMd: formData.get('bodyMd'),
  });
  const isActive = formData.get('isActive') === 'on';

  const actor = await requireActor();
  assertCan(actor, PERMISSIONS.ADMIN_MESSAGING_MANAGE);

  await updateMessageTemplate({ actor, ...parsed, isActive });
  revalidatePath('/admin/templates');
}

// ---------------------------------------------------------------------------
// Local credential administration (PRD amendment A1)
// ---------------------------------------------------------------------------

const createUserSchema = z.object({
  email: z.string().email().max(320),
  fullName: z.string().min(2).max(200),
  roleId: z.string().uuid(),
  office: z.enum(OFFICES),
});

/**
 * Create an account and return its temporary password once, in the redirect.
 *
 * The password travels in the URL of a single redirect back to the admin
 * screen rather than by email, because emailing a working credential to an
 * address the firm has not yet verified is the classic account-takeover path.
 * The administrator reads it to the person directly.
 */
export async function createUserAction(formData: FormData): Promise<void> {
  const parsed = createUserSchema.parse({
    email: formData.get('email'),
    fullName: formData.get('fullName'),
    roleId: formData.get('roleId'),
    office: formData.get('office'),
  });

  const actor = await requireActor();
  assertCan(actor, PERMISSIONS.ADMIN_USERS_MANAGE);

  const result = await createUserWithTemporaryPassword({ actor, ...parsed });

  revalidatePath('/admin/users');
  redirect(
    `/admin/users?created=${encodeURIComponent(parsed.email)}` +
      `&temp=${encodeURIComponent(result.temporaryPassword)}`,
  );
}

export async function resetUserPasswordAction(formData: FormData): Promise<void> {
  const userId = z.string().uuid().parse(formData.get('userId'));
  const actor = await requireActor();
  if (
    !actor.grants[PERMISSIONS.ADMIN_USERS_MANAGE] &&
    !actor.grants[PERMISSIONS.ADMIN_USERS_ONBOARD]
  ) {
    assertCan(actor, PERMISSIONS.ADMIN_USERS_MANAGE);
  }

  const temporaryPassword = await resetUserPassword({ actor, userId });

  revalidatePath('/admin/users');
  redirect(`/admin/users?reset=1&temp=${encodeURIComponent(temporaryPassword)}`);
}

export async function resetTwoFactorEnrolmentAction(formData: FormData): Promise<void> {
  const userId = z.string().uuid().parse(formData.get('userId'));
  const actor = await requireActor();
  if (
    !actor.grants[PERMISSIONS.ADMIN_USERS_MANAGE] &&
    !actor.grants[PERMISSIONS.ADMIN_USERS_ONBOARD]
  ) {
    assertCan(actor, PERMISSIONS.ADMIN_USERS_MANAGE);
  }

  await resetTwoFactorEnrolment({ actor, userId });
  revalidatePath('/admin/users');
}

export async function unlockUserAction(formData: FormData): Promise<void> {
  const userId = z.string().uuid().parse(formData.get('userId'));
  const actor = await requireActor();
  if (
    !actor.grants[PERMISSIONS.ADMIN_USERS_MANAGE] &&
    !actor.grants[PERMISSIONS.ADMIN_USERS_ONBOARD]
  ) {
    assertCan(actor, PERMISSIONS.ADMIN_USERS_MANAGE);
  }

  await unlockUser({ actor, userId });
  revalidatePath('/admin/users');
}

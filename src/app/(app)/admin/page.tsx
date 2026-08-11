import { redirect } from 'next/navigation';
import { requireActor } from '@/lib/auth/session';
import { can } from '@/lib/auth/guard';
import { PERMISSIONS } from '@/lib/auth/permissions';

export const dynamic = 'force-dynamic';

/** Send each admin to the first tab their role actually grants. */
export default async function AdminIndexPage() {
  const actor = await requireActor();

  if (can(actor, PERMISSIONS.ADMIN_USERS_MANAGE) || can(actor, PERMISSIONS.ADMIN_USERS_ONBOARD)) {
    redirect('/admin/users');
  }
  if (can(actor, PERMISSIONS.ADMIN_AVAILABILITY_MANAGE)) redirect('/admin/availability');
  if (can(actor, PERMISSIONS.ADMIN_ROLES_MANAGE)) redirect('/admin/roles');
  redirect('/dashboard');
}

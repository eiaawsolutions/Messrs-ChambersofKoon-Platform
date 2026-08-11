import type { Metadata } from 'next';
import { requireActor } from '@/lib/auth/session';
import { can } from '@/lib/auth/guard';
import { PERMISSIONS } from '@/lib/auth/permissions';
import { listRoles, listUsers } from '@/lib/admin/service';
import { AuthorizationError } from '@/lib/auth/guard';
import { resetTwoFactorAction, updateUserAction } from '../actions';

export const metadata: Metadata = { title: 'Users' };
export const dynamic = 'force-dynamic';

const STATUS_PILL: Record<string, string> = {
  active: 'pill-success',
  invited: 'pill-warning',
  suspended: 'pill-danger',
};

/** FR-1.6, FR-9.1: create/invite, assign role, change office, suspend, reset 2FA. */
export default async function AdminUsersPage() {
  const actor = await requireActor();
  const mayManage = can(actor, PERMISSIONS.ADMIN_USERS_MANAGE);
  const mayOnboard = can(actor, PERMISSIONS.ADMIN_USERS_ONBOARD);
  if (!mayManage && !mayOnboard) throw new AuthorizationError(PERMISSIONS.ADMIN_USERS_MANAGE);

  const [users, roles] = await Promise.all([listUsers(), listRoles()]);

  return (
    <div className="space-y-6">
      <div className="surface p-5">
        <h2 className="text-base font-semibold">How people get access</h2>
        <p className="text-ink-muted mt-2 text-sm">
          There are no invitations to send and no passwords to set. Anyone with an address on the
          firm&rsquo;s domain can sign in through the identity provider; they arrive here as
          <span className="pill pill-warning mx-1">invited</span> with no access at all until you
          set them active and give them a role.
        </p>
        {!mayManage ? (
          <p className="text-ink-muted mt-2 text-sm">
            Your delegated access covers activating, suspending and resetting 2-step verification.
            Changing a role needs a Managing Partner.
          </p>
        ) : null}
      </div>

      <div className="scroll-x surface">
        <table className="table-legal">
          <thead>
            <tr>
              <th scope="col">Name</th>
              <th scope="col">Email</th>
              <th scope="col">Role</th>
              <th scope="col">Office</th>
              <th scope="col">Practice areas</th>
              <th scope="col">Status</th>
              <th scope="col">Last sign-in</th>
              <th scope="col">Actions</th>
            </tr>
          </thead>
          <tbody>
            {users.map((user) => (
              <tr key={user.id}>
                <td className="font-medium">{user.fullName}</td>
                <td className="text-xs break-all">{user.email}</td>
                <td>
                  <form action={updateUserAction} className="flex items-center gap-2">
                    <input type="hidden" name="userId" value={user.id} />
                    <select
                      className="field py-1 text-xs"
                      name="roleId"
                      defaultValue={user.roleId}
                      disabled={!mayManage}
                    >
                      {roles.map((role) => (
                        <option key={role.id} value={role.id}>
                          {role.name}
                        </option>
                      ))}
                    </select>
                    {mayManage ? (
                      <button className="btn btn-ghost px-2 py-1 text-xs" type="submit">
                        Save
                      </button>
                    ) : null}
                  </form>
                </td>
                <td>
                  <form action={updateUserAction} className="flex items-center gap-2">
                    <input type="hidden" name="userId" value={user.id} />
                    <select className="field py-1 text-xs" name="office" defaultValue={user.office}>
                      <option value="KL">KL</option>
                      <option value="PJ">PJ</option>
                      <option value="IPOH">Ipoh</option>
                    </select>
                    <button className="btn btn-ghost px-2 py-1 text-xs" type="submit">
                      Save
                    </button>
                  </form>
                </td>
                <td>
                  <form action={updateUserAction} className="flex items-center gap-2">
                    <input type="hidden" name="userId" value={user.id} />
                    <input
                      className="field w-40 py-1 text-xs"
                      name="practiceAreas"
                      defaultValue={(user.practiceAreas ?? []).join(',')}
                      placeholder="all areas"
                      disabled={!mayManage}
                    />
                    {mayManage ? (
                      <button className="btn btn-ghost px-2 py-1 text-xs" type="submit">
                        Save
                      </button>
                    ) : null}
                  </form>
                </td>
                <td>
                  <span className={`pill ${STATUS_PILL[user.status] ?? 'pill-neutral'}`}>
                    {user.status}
                  </span>
                </td>
                <td className="text-xs whitespace-nowrap" data-numeric>
                  {user.lastLoginAt
                    ? new Intl.DateTimeFormat('en-MY', {
                        timeZone: 'Asia/Kuala_Lumpur',
                        day: 'numeric',
                        month: 'short',
                        year: '2-digit',
                      }).format(user.lastLoginAt)
                    : 'never'}
                </td>
                <td>
                  <div className="flex flex-wrap gap-1">
                    {user.status !== 'active' ? (
                      <form action={updateUserAction}>
                        <input type="hidden" name="userId" value={user.id} />
                        <input type="hidden" name="status" value="active" />
                        <button className="btn btn-secondary px-2 py-1 text-xs" type="submit">
                          Activate
                        </button>
                      </form>
                    ) : (
                      <form action={updateUserAction}>
                        <input type="hidden" name="userId" value={user.id} />
                        <input type="hidden" name="status" value="suspended" />
                        <button className="btn btn-danger px-2 py-1 text-xs" type="submit">
                          Suspend
                        </button>
                      </form>
                    )}
                    <form action={resetTwoFactorAction}>
                      <input type="hidden" name="userId" value={user.id} />
                      <button className="btn btn-ghost px-2 py-1 text-xs" type="submit">
                        Reset 2FA
                      </button>
                    </form>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <p className="text-ink-faint text-xs">
        Suspending a user, changing their role or resetting 2-step verification revokes their live
        sessions immediately — they lose access on their next request, not their next sign-in.
      </p>
    </div>
  );
}

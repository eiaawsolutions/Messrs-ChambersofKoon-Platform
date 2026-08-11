import type { Metadata } from 'next';
import { requireActor } from '@/lib/auth/session';
import { can, AuthorizationError } from '@/lib/auth/guard';
import { PERMISSIONS } from '@/lib/auth/permissions';
import { listRoles, listUsers } from '@/lib/admin/service';
import {
  createUserAction,
  resetTwoFactorEnrolmentAction,
  resetUserPasswordAction,
  unlockUserAction,
  updateUserAction,
} from '../actions';

export const metadata: Metadata = { title: 'Users' };
export const dynamic = 'force-dynamic';

const STATUS_PILL: Record<string, string> = {
  active: 'pill-success',
  invited: 'pill-warning',
  suspended: 'pill-danger',
};

function fmtDate(date: Date | null): string {
  if (!date) return 'never';
  return new Intl.DateTimeFormat('en-MY', {
    timeZone: 'Asia/Kuala_Lumpur',
    day: 'numeric',
    month: 'short',
    year: '2-digit',
  }).format(date);
}

/** FR-1.6, FR-9.1 — with local credentials per PRD amendment A1. */
export default async function AdminUsersPage({
  searchParams,
}: {
  searchParams: Promise<{ created?: string; reset?: string; temp?: string }>;
}) {
  const actor = await requireActor();
  const mayManage = can(actor, PERMISSIONS.ADMIN_USERS_MANAGE);
  const mayOnboard = can(actor, PERMISSIONS.ADMIN_USERS_ONBOARD);
  if (!mayManage && !mayOnboard) throw new AuthorizationError(PERMISSIONS.ADMIN_USERS_MANAGE);

  const params = await searchParams;
  const [users, roles] = await Promise.all([listUsers(), listRoles()]);
  const now = new Date();

  return (
    <div className="space-y-6">
      {/* Temporary password, shown once, right after issuing it. */}
      {params.temp ? (
        <section
          aria-labelledby="temp-heading"
          className="border-l-brass-500 bg-brass-100 rounded-sm border-l-2 p-5"
        >
          <h2 id="temp-heading" className="text-brass-700 text-base font-semibold">
            {params.created ? `Account created for ${params.created}` : 'Temporary password issued'}
          </h2>
          <p className="text-brass-700 mt-2 text-sm">
            Give this to them in person or by phone. It is shown once and is not emailed — sending a
            working password to an unverified mailbox is how accounts get taken over.
          </p>
          <p className="mt-3 rounded-sm bg-white p-3 font-mono text-lg tracking-wide" data-numeric>
            {params.temp}
          </p>
          <p className="text-brass-700 mt-2 text-xs">
            They must change it at first sign-in, then set up an authenticator app before they can
            use the platform.
          </p>
        </section>
      ) : null}

      {mayManage ? (
        <section aria-labelledby="create" className="surface-raised p-5">
          <h2 id="create" className="text-base font-semibold">
            Create an account
          </h2>
          <p className="text-ink-muted mt-2 text-sm">
            The platform issues the credential. There is no invitation email — you receive a
            temporary password to hand over directly.
          </p>
          <form action={createUserAction} className="mt-4 grid gap-4 sm:grid-cols-5">
            <div className="sm:col-span-2">
              <label className="label" htmlFor="email">
                Email
              </label>
              <input className="field" id="email" name="email" type="email" required />
            </div>
            <div className="sm:col-span-2">
              <label className="label" htmlFor="fullName">
                Full name
              </label>
              <input className="field" id="fullName" name="fullName" required minLength={2} />
            </div>
            <div>
              <label className="label" htmlFor="office">
                Office
              </label>
              <select className="field" id="office" name="office" defaultValue="KL">
                <option value="KL">KL</option>
                <option value="PJ">PJ</option>
                <option value="IPOH">Ipoh</option>
              </select>
            </div>
            <div className="sm:col-span-2">
              <label className="label" htmlFor="roleId">
                Role
              </label>
              <select className="field" id="roleId" name="roleId" required>
                {roles.map((role) => (
                  <option key={role.id} value={role.id}>
                    {role.name}
                  </option>
                ))}
              </select>
            </div>
            <div className="flex items-end sm:col-span-3">
              <button className="btn btn-primary" type="submit">
                Create and issue password
              </button>
            </div>
          </form>
        </section>
      ) : null}

      <div className="surface p-5">
        <h2 className="text-base font-semibold">How access works</h2>
        <p className="text-ink-muted mt-2 text-sm">
          Password plus an authenticator app, enrolled at first sign-in. Eight wrong passwords locks
          the account for fifteen minutes. Suspending, changing a role, resetting a password or
          clearing two-step verification all end that person&rsquo;s live sessions immediately.
        </p>
        {!mayManage ? (
          <p className="text-ink-muted mt-2 text-sm">
            Your delegated access covers activating, suspending, unlocking, issuing a temporary
            password and clearing two-step verification. Changing a role needs a Managing Partner.
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
              <th scope="col">Status</th>
              <th scope="col">2FA</th>
              <th scope="col">Last sign-in</th>
              <th scope="col">Actions</th>
            </tr>
          </thead>
          <tbody>
            {users.map((user) => {
              const locked = user.lockedUntil !== null && user.lockedUntil > now;
              return (
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
                      <select
                        className="field py-1 text-xs"
                        name="office"
                        defaultValue={user.office}
                      >
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
                    <span className={`pill ${STATUS_PILL[user.status] ?? 'pill-neutral'}`}>
                      {user.status}
                    </span>
                    {locked ? (
                      <span className="pill pill-danger mt-1 block w-fit">
                        locked ({user.failedLoginAttempts} fails)
                      </span>
                    ) : null}
                    {user.mustChangePassword ? (
                      <span className="pill pill-warning mt-1 block w-fit">temp password</span>
                    ) : null}
                  </td>
                  <td>
                    <span
                      className={`pill ${user.totpEnrolledAt ? 'pill-success' : 'pill-warning'}`}
                    >
                      {user.totpEnrolledAt ? 'enrolled' : 'not set up'}
                    </span>
                  </td>
                  <td className="text-xs whitespace-nowrap" data-numeric>
                    {fmtDate(user.lastLoginAt)}
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

                      {locked ? (
                        <form action={unlockUserAction}>
                          <input type="hidden" name="userId" value={user.id} />
                          <button className="btn btn-secondary px-2 py-1 text-xs" type="submit">
                            Unlock
                          </button>
                        </form>
                      ) : null}

                      <form action={resetUserPasswordAction}>
                        <input type="hidden" name="userId" value={user.id} />
                        <button className="btn btn-ghost px-2 py-1 text-xs" type="submit">
                          New password
                        </button>
                      </form>

                      {user.totpEnrolledAt ? (
                        <form action={resetTwoFactorEnrolmentAction}>
                          <input type="hidden" name="userId" value={user.id} />
                          <button className="btn btn-ghost px-2 py-1 text-xs" type="submit">
                            Reset 2FA
                          </button>
                        </form>
                      ) : null}
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <p className="text-ink-faint text-xs">
        Resetting two-step verification lets whoever holds the password enrol a new device — use it
        only after identifying the person by another channel. Every action here is audited.
      </p>
    </div>
  );
}

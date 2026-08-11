import type { Metadata } from 'next';
import { requireActor } from '@/lib/auth/session';
import { assertCan } from '@/lib/auth/guard';
import { PERMISSIONS, SCOPES } from '@/lib/auth/permissions';
import { grantsForRole, listPermissions, listRoles } from '@/lib/admin/service';
import { createRoleAction, deleteRoleAction, setRoleGrantsAction } from '../actions';

export const metadata: Metadata = { title: 'Roles' };
export const dynamic = 'force-dynamic';

const SCOPE_HELP: Record<string, string> = {
  all: 'every matter, every office',
  office: 'own office (and own practice areas if set)',
  own: 'assigned, supervising or participant',
  index: 'metadata only — no contents, no client identity',
};

/**
 * Role editor (FR-9.1).
 *
 * Permissions are additive per role and each carries a scope. Editing submits
 * the whole intended set rather than individual toggles, so two people editing
 * concurrently cannot merge into a permission set neither of them chose.
 */
export default async function AdminRolesPage({
  searchParams,
}: {
  searchParams: Promise<{ role?: string }>;
}) {
  const actor = await requireActor();
  assertCan(actor, PERMISSIONS.ADMIN_ROLES_MANAGE);

  const params = await searchParams;
  const [roles, permissions] = await Promise.all([listRoles(), listPermissions()]);

  const selectedId = params.role ?? roles[0]?.id;
  const selected = roles.find((r) => r.id === selectedId);
  const grants = selected ? await grantsForRole(selected.id) : {};

  const byCategory = permissions.reduce<Record<string, typeof permissions>>((acc, p) => {
    (acc[p.category] ??= []).push(p);
    return acc;
  }, {});

  return (
    <div className="grid gap-8 lg:grid-cols-[260px_1fr]">
      <aside className="space-y-4">
        <ul className="surface divide-line divide-y">
          {roles.map((role) => (
            <li key={role.id}>
              <a
                href={`/admin/roles?role=${role.id}`}
                className={`block px-4 py-3 text-sm ${
                  role.id === selectedId ? 'bg-paper-sunken font-medium' : ''
                }`}
              >
                {role.name}
                <span className="text-ink-faint block text-xs" data-numeric>
                  {role.userCount} user{role.userCount === 1 ? '' : 's'} · {role.permissionCount}{' '}
                  permission{role.permissionCount === 1 ? '' : 's'}
                  {role.isSystem ? ' · seeded' : ''}
                </span>
              </a>
            </li>
          ))}
        </ul>

        <form action={createRoleAction} className="surface-raised space-y-3 p-4">
          <h2 className="text-sm font-semibold">New role</h2>
          <div>
            <label className="label" htmlFor="name">
              Name
            </label>
            <input className="field" id="name" name="name" required minLength={2} maxLength={80} />
          </div>
          <div>
            <label className="label" htmlFor="description">
              Description
            </label>
            <input className="field" id="description" name="description" maxLength={500} />
          </div>
          <button className="btn btn-secondary w-full" type="submit">
            Create
          </button>
        </form>
      </aside>

      {selected ? (
        <section aria-labelledby="grants">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h2 id="grants" className="text-xl">
                {selected.name}
              </h2>
              <p className="text-ink-muted mt-1 text-sm">{selected.description}</p>
            </div>
            {!selected.isSystem ? (
              <form action={deleteRoleAction}>
                <input type="hidden" name="roleId" value={selected.id} />
                <button className="btn btn-danger" type="submit">
                  Delete role
                </button>
              </form>
            ) : (
              <span className="pill pill-neutral">seeded — cannot be deleted</span>
            )}
          </div>

          <form action={setRoleGrantsAction} className="mt-6 space-y-6">
            <input type="hidden" name="roleId" value={selected.id} />

            {Object.entries(byCategory).map(([category, perms]) => (
              <fieldset key={category} className="surface p-5">
                <legend className="px-2 text-sm font-semibold">{category}</legend>
                <div className="space-y-3">
                  {perms.map((permission) => (
                    <div
                      key={permission.id}
                      className="grid items-center gap-3 sm:grid-cols-[1fr_auto]"
                    >
                      <div>
                        <p className="text-sm">{permission.description}</p>
                        <p className="text-ink-faint font-mono text-xs">{permission.key}</p>
                      </div>
                      <select
                        className="field w-56 py-1 text-xs"
                        name={`grant:${permission.key}`}
                        defaultValue={grants[permission.key] ?? 'none'}
                        aria-label={`Scope for ${permission.key}`}
                      >
                        <option value="none">Not granted</option>
                        {SCOPES.map((scope) => (
                          <option key={scope} value={scope}>
                            {scope} — {SCOPE_HELP[scope]}
                          </option>
                        ))}
                      </select>
                    </div>
                  ))}
                </div>
              </fieldset>
            ))}

            <div className="flex items-center gap-4">
              <button className="btn btn-primary" type="submit">
                Save permissions
              </button>
              <p className="text-ink-faint text-xs">
                Saving revokes live sessions for everyone holding this role, so the change takes
                effect on their next request.
              </p>
            </div>
          </form>
        </section>
      ) : (
        <p className="surface text-ink-muted p-8 text-sm">Select a role.</p>
      )}
    </div>
  );
}

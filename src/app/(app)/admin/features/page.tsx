import type { Metadata } from 'next';
import { requireActor } from '@/lib/auth/session';
import { assertCan } from '@/lib/auth/guard';
import { FEATURE_FLAGS, PERMISSIONS } from '@/lib/auth/permissions';
import { listFeatureFlags, listRoles } from '@/lib/admin/service';
import { setFeatureFlagAction } from '../actions';

export const metadata: Metadata = { title: 'Feature access' };
export const dynamic = 'force-dynamic';

const DESCRIPTIONS: Record<string, string> = {
  [FEATURE_FLAGS.AI_DRAFTING]: 'Generate AI-assisted first drafts from firm templates',
  [FEATURE_FLAGS.AI_TRIAGE]: 'Run the intake agent on new enquiries',
  [FEATURE_FLAGS.RAG_SEARCH]: 'Search the firm precedent archive',
  [FEATURE_FLAGS.CLIENT_MILESTONE_EMAILS]: 'Send client updates when a stage is recorded',
};

/**
 * Feature toggles per role (FR-9.4).
 *
 * "Feature toggles per role (e.g. disable AI drafting for a role without
 *  touching code)." A row with no role is the global default; a role-specific
 *  row overrides it for that role only.
 */
export default async function AdminFeaturesPage() {
  const actor = await requireActor();
  assertCan(actor, PERMISSIONS.ADMIN_FEATURES_MANAGE);

  const [flags, roles] = await Promise.all([listFeatureFlags(), listRoles()]);

  return (
    <div className="space-y-8">
      <div className="surface p-5">
        <h2 className="text-base font-semibold">How these work</h2>
        <p className="text-ink-muted mt-2 text-sm">
          Turning a feature off removes it for everyone it applies to, immediately and without a
          deploy. Use it to pause AI drafting during a review, or to withhold a capability from a
          role while it is being trialled. A role-specific setting overrides the global default.
        </p>
      </div>

      <div className="scroll-x surface">
        <table className="table-legal">
          <thead>
            <tr>
              <th scope="col">Feature</th>
              <th scope="col">Applies to</th>
              <th scope="col">State</th>
              <th scope="col"></th>
            </tr>
          </thead>
          <tbody>
            {flags.map((flag) => (
              <tr key={flag.id}>
                <td>
                  <p className="text-sm">{DESCRIPTIONS[flag.key] ?? flag.key}</p>
                  <p className="text-ink-faint font-mono text-xs">{flag.key}</p>
                </td>
                <td>{flag.roleName ?? 'Everyone (default)'}</td>
                <td>
                  <span className={`pill ${flag.enabled ? 'pill-success' : 'pill-danger'}`}>
                    {flag.enabled ? 'on' : 'off'}
                  </span>
                </td>
                <td>
                  <form action={setFeatureFlagAction}>
                    <input type="hidden" name="key" value={flag.key} />
                    {flag.roleId ? <input type="hidden" name="roleId" value={flag.roleId} /> : null}
                    {flag.enabled ? null : <input type="hidden" name="enabled" value="on" />}
                    <button
                      className={`btn ${flag.enabled ? 'btn-danger' : 'btn-secondary'} px-3 py-1 text-xs`}
                      type="submit"
                    >
                      Turn {flag.enabled ? 'off' : 'on'}
                    </button>
                  </form>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <form action={setFeatureFlagAction} className="surface-raised grid gap-4 p-5 sm:grid-cols-4">
        <div className="sm:col-span-2">
          <label className="label" htmlFor="key">
            Feature
          </label>
          <select className="field" id="key" name="key" required>
            {Object.values(FEATURE_FLAGS).map((key) => (
              <option key={key} value={key}>
                {DESCRIPTIONS[key] ?? key}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="label" htmlFor="roleId">
            Override for role
          </label>
          <select className="field" id="roleId" name="roleId" defaultValue="">
            <option value="">— none —</option>
            {roles.map((role) => (
              <option key={role.id} value={role.id}>
                {role.name}
              </option>
            ))}
          </select>
        </div>
        <div className="flex items-end gap-3">
          <label className="text-ink-muted flex items-center gap-2 text-sm">
            <input type="checkbox" name="enabled" defaultChecked />
            Enabled
          </label>
          <button className="btn btn-primary" type="submit">
            Set
          </button>
        </div>
      </form>
    </div>
  );
}

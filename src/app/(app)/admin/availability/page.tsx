import type { Metadata } from 'next';
import { requireActor } from '@/lib/auth/session';
import { assertCan } from '@/lib/auth/guard';
import { PERMISSIONS } from '@/lib/auth/permissions';
import { listAvailability, listUsers } from '@/lib/admin/service';
import { createAvailabilityAction, deleteAvailabilityAction } from '../actions';

export const metadata: Metadata = { title: 'Availability' };
export const dynamic = 'force-dynamic';

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/**
 * Availability rules (FR-3.1, FR-9.2).
 *
 * "Configured in the admin console, no calendar API." The platform never reads
 * a lawyer's external calendar — these rules plus existing appointments in the
 * platform are the whole basis for proposing a slot.
 */
export default async function AdminAvailabilityPage() {
  const actor = await requireActor();
  assertCan(actor, PERMISSIONS.ADMIN_AVAILABILITY_MANAGE);

  const [rules, users] = await Promise.all([listAvailability(), listUsers()]);
  const active = users.filter((u) => u.status === 'active');

  return (
    <div className="space-y-8">
      <div className="surface p-5">
        <h2 className="text-base font-semibold">How slots are proposed</h2>
        <p className="text-ink-muted mt-2 text-sm">
          The platform does not read anyone&rsquo;s Google or Outlook calendar. A slot is offered
          only if it falls inside a rule below, has no existing appointment or pending proposal,
          respects the buffer either side, and is not a Malaysian public holiday for that office.
        </p>
      </div>

      <form
        action={createAvailabilityAction}
        className="surface-raised grid gap-4 p-5 sm:grid-cols-4"
      >
        <div className="sm:col-span-2">
          <label className="label" htmlFor="userId">
            Lawyer
          </label>
          <select className="field" id="userId" name="userId" required>
            {active.map((user) => (
              <option key={user.id} value={user.id}>
                {user.fullName} ({user.office})
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="label" htmlFor="office">
            Office
          </label>
          <select className="field" id="office" name="office" required defaultValue="KL">
            <option value="KL">Kuala Lumpur</option>
            <option value="PJ">Petaling Jaya</option>
            <option value="IPOH">Ipoh</option>
          </select>
        </div>
        <div>
          <label className="label" htmlFor="practiceArea">
            Practice area
          </label>
          <select className="field" id="practiceArea" name="practiceArea" defaultValue="">
            <option value="">All areas</option>
            <option value="family_matrimonial">Family &amp; matrimonial</option>
            <option value="debt_recovery">Debt recovery</option>
            <option value="land_property">Land &amp; property</option>
            <option value="corporate_disputes">Corporate disputes</option>
            <option value="general">General</option>
          </select>
        </div>
        <div>
          <label className="label" htmlFor="weekday">
            Day
          </label>
          <select className="field" id="weekday" name="weekday" required defaultValue="1">
            {WEEKDAYS.map((day, index) => (
              <option key={day} value={index}>
                {day}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="label" htmlFor="startTime">
            From
          </label>
          <input
            className="field"
            id="startTime"
            name="startTime"
            type="time"
            required
            defaultValue="09:00"
          />
        </div>
        <div>
          <label className="label" htmlFor="endTime">
            To
          </label>
          <input
            className="field"
            id="endTime"
            name="endTime"
            type="time"
            required
            defaultValue="17:00"
          />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="label" htmlFor="slotMinutes">
              Slot
            </label>
            <input
              className="field"
              id="slotMinutes"
              name="slotMinutes"
              type="number"
              min={5}
              max={480}
              required
              defaultValue={45}
            />
          </div>
          <div>
            <label className="label" htmlFor="bufferMinutes">
              Buffer
            </label>
            <input
              className="field"
              id="bufferMinutes"
              name="bufferMinutes"
              type="number"
              min={0}
              max={240}
              required
              defaultValue={15}
            />
          </div>
        </div>
        <div className="flex items-end sm:col-span-4">
          <button className="btn btn-primary" type="submit">
            Add rule
          </button>
        </div>
      </form>

      {rules.length === 0 ? (
        <p className="surface text-ink-muted p-8 text-center text-sm">
          No availability configured. Until at least one rule exists, no consultation slot can be
          proposed and every enquiry goes to the human review queue.
        </p>
      ) : (
        <div className="scroll-x surface">
          <table className="table-legal">
            <thead>
              <tr>
                <th scope="col">Lawyer</th>
                <th scope="col">Office</th>
                <th scope="col">Practice area</th>
                <th scope="col">Day</th>
                <th scope="col">Window</th>
                <th scope="col">Slot</th>
                <th scope="col">Buffer</th>
                <th scope="col"></th>
              </tr>
            </thead>
            <tbody>
              {rules.map((rule) => (
                <tr key={rule.id}>
                  <td>{rule.userName}</td>
                  <td>{rule.office}</td>
                  <td>{rule.practiceArea?.replace(/_/g, ' ') ?? 'all'}</td>
                  <td>{WEEKDAYS[rule.weekday]}</td>
                  <td className="whitespace-nowrap" data-numeric>
                    {rule.startTime.slice(0, 5)}–{rule.endTime.slice(0, 5)}
                  </td>
                  <td data-numeric>{rule.slotMinutes}m</td>
                  <td data-numeric>{rule.bufferMinutes}m</td>
                  <td>
                    <form action={deleteAvailabilityAction}>
                      <input type="hidden" name="ruleId" value={rule.id} />
                      <button className="btn btn-ghost px-2 py-1 text-xs" type="submit">
                        Remove
                      </button>
                    </form>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

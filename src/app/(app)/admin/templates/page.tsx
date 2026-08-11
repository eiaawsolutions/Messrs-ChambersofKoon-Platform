import type { Metadata } from 'next';
import { requireActor } from '@/lib/auth/session';
import { assertCan } from '@/lib/auth/guard';
import { PERMISSIONS } from '@/lib/auth/permissions';
import { listTemplates } from '@/lib/comms/templates';
import { renderTemplate, templateVariables } from '@/lib/email/resend';
import { config } from '@/lib/config/env';
import { updateTemplateAction } from '../actions';

export const metadata: Metadata = { title: 'Message templates' };
export const dynamic = 'force-dynamic';

/** Sample values so the preview reads like a real email, not a token soup. */
const PREVIEW = {
  clientName: 'Siti Aminah binti Rahman',
  lawyerName: 'Tan Yong Koon',
  matterReference: 'CK/2026/FM/0184',
  stageLabel: 'Hearing date confirmed',
  stageDetail: '14 October 2026, 9.00am, Kuala Lumpur High Court',
  appointmentWhen: 'Monday, 14 September 2026 at 10:00 am – 10:45 am (MYT)',
  appointmentLocation: 'Chambers of Koon — Kuala Lumpur office',
  rescheduleUrl: 'https://…/reschedule/…',
  practiceArea: 'family matrimonial',
  urgency: 'normal',
  dashboardUrl: 'https://…/intake',
};

/** FR-9.3: manage message templates with preview. */
export default async function AdminTemplatesPage({
  searchParams,
}: {
  searchParams: Promise<{ key?: string }>;
}) {
  const actor = await requireActor();
  assertCan(actor, PERMISSIONS.ADMIN_MESSAGING_MANAGE);

  const params = await searchParams;
  const templates = await listTemplates();
  const selected = templates.find((t) => t.key === params.key) ?? templates[0];

  const variables = { ...PREVIEW, firmName: config().FIRM_NAME };
  const used = selected ? templateVariables(selected.bodyMd + selected.subject) : [];

  return (
    <div className="grid gap-8 lg:grid-cols-[260px_1fr]">
      <aside>
        <ul className="surface divide-line divide-y">
          {templates.map((template) => (
            <li key={template.key}>
              <a
                href={`/admin/templates?key=${encodeURIComponent(template.key)}`}
                className={`block px-4 py-3 text-sm ${
                  template.key === selected?.key ? 'bg-paper-sunken font-medium' : ''
                }`}
              >
                <span className="font-mono text-xs break-all">{template.key}</span>
                {!template.isActive ? (
                  <span className="pill pill-warning mt-1 block w-fit">inactive</span>
                ) : null}
              </a>
            </li>
          ))}
        </ul>
      </aside>

      {selected ? (
        <section aria-labelledby="editor" className="space-y-6">
          <h2 id="editor" className="text-xl">
            {selected.description ?? selected.key}
          </h2>

          <form action={updateTemplateAction} className="surface-raised space-y-4 p-5">
            <input type="hidden" name="key" value={selected.key} />
            <div>
              <label className="label" htmlFor="subject">
                Subject
              </label>
              <input
                className="field"
                id="subject"
                name="subject"
                required
                maxLength={300}
                defaultValue={selected.subject}
              />
            </div>
            <div>
              <label className="label" htmlFor="bodyMd">
                Body
              </label>
              <textarea
                className="field min-h-72 font-mono text-xs"
                id="bodyMd"
                name="bodyMd"
                required
                maxLength={20_000}
                defaultValue={selected.bodyMd}
              />
            </div>
            <label className="text-ink-muted flex items-center gap-2 text-sm">
              <input type="checkbox" name="isActive" defaultChecked={selected.isActive} />
              Active — an inactive template sends nothing at all
            </label>

            <div className="bg-paper-sunken rounded-sm p-3">
              <p className="text-ink-muted text-xs">
                Available tokens:{' '}
                <span className="font-mono">
                  {used.length > 0 ? used.map((v) => `{{${v}}}`).join(' ') : 'none used'}
                </span>
              </p>
              <p className="text-ink-faint mt-1 text-xs">
                A token with no value renders as empty — a client never sees a raw{' '}
                <span className="font-mono">{'{{token}}'}</span>.
              </p>
            </div>

            <button className="btn btn-primary" type="submit">
              Save template
            </button>
          </form>

          <section aria-labelledby="preview">
            <h3 id="preview" className="rule-brass text-lg">
              Preview
            </h3>
            <div className="surface mt-4 p-5">
              <p className="text-ink-faint text-xs uppercase">Subject</p>
              <p className="text-ink mt-1 font-medium">
                {renderTemplate(selected.subject, variables)}
              </p>
              <hr className="border-line my-4" />
              <p className="text-sm whitespace-pre-wrap">
                {renderTemplate(selected.bodyMd, variables)}
              </p>
            </div>
          </section>
        </section>
      ) : (
        <p className="surface text-ink-muted p-8 text-sm">No templates seeded.</p>
      )}
    </div>
  );
}

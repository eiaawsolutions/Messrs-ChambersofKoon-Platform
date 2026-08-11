import type { Metadata } from 'next';
import { config } from '@/lib/config/env';

export const metadata: Metadata = {
  title: 'Make an enquiry',
  description: 'Send an enquiry to Messrs Chambers of Koon.',
};

/**
 * No-JavaScript fallback (FR-2.2).
 *
 * "Widget is responsive, keyboard accessible, and renders a plain fallback
 *  form if JavaScript fails."
 *
 * The widget's launcher links here when scripting is unavailable, and the page
 * is also linkable directly — useful for the firm to put in an email
 * signature. It is a plain server-rendered form: no client bundle at all, so
 * it works in the exact conditions where the widget cannot.
 */
export default function EnquiryPage() {
  const cfg = config();

  return (
    <main id="main" className="grain relative min-h-screen px-5 py-12">
      <div className="mx-auto w-full max-w-xl">
        <p className="text-ink-muted mb-2 font-mono text-xs tracking-widest uppercase">
          {cfg.FIRM_NAME}
        </p>
        <h1 className="rule-brass text-3xl">Make an enquiry</h1>

        <p className="text-ink-muted mt-6 text-sm">
          Tell us what has happened and how to reach you. A member of the firm will respond. We
          cannot give legal advice through this form, and sending it does not create a
          solicitor-client relationship.
        </p>

        <form
          method="post"
          action="/api/public/enquiry/form"
          className="surface-raised mt-8 space-y-5 p-6"
        >
          <div>
            <label className="label" htmlFor="contactName">
              Your name
            </label>
            <input
              className="field"
              id="contactName"
              name="contactName"
              required
              maxLength={200}
              autoComplete="name"
            />
          </div>

          <div className="grid gap-5 sm:grid-cols-2">
            <div>
              <label className="label" htmlFor="contactEmail">
                Email
              </label>
              <input
                className="field"
                id="contactEmail"
                name="contactEmail"
                type="email"
                required
                maxLength={320}
                autoComplete="email"
              />
            </div>
            <div>
              <label className="label" htmlFor="contactPhone">
                Phone (optional)
              </label>
              <input
                className="field"
                id="contactPhone"
                name="contactPhone"
                type="tel"
                maxLength={40}
                autoComplete="tel"
              />
            </div>
          </div>

          <div>
            <label className="label" htmlFor="office">
              Nearest office
            </label>
            <select className="field" id="office" name="office" defaultValue="KL">
              <option value="KL">Kuala Lumpur</option>
              <option value="PJ">Petaling Jaya</option>
              <option value="IPOH">Ipoh</option>
            </select>
          </div>

          <div>
            <label className="label" htmlFor="message">
              What has happened?
            </label>
            <textarea
              className="field min-h-40"
              id="message"
              name="message"
              required
              maxLength={4000}
              placeholder="Please include dates, who is involved, and anything with a deadline."
            />
          </div>

          {/*
            Honeypot. Hidden from sight and from assistive technology, and
            excluded from the tab order, so no real person encounters it —
            a bot that fills every field trips it.
          */}
          <div aria-hidden="true" className="absolute left-[-9999px] h-px w-px overflow-hidden">
            <label htmlFor="website">Website</label>
            <input id="website" name="website" type="text" tabIndex={-1} autoComplete="off" />
          </div>

          <button className="btn btn-primary w-full" type="submit">
            Send enquiry
          </button>

          <p className="text-ink-faint text-xs">
            If someone is in immediate danger, call the police on 999.
          </p>
        </form>
      </div>
    </main>
  );
}

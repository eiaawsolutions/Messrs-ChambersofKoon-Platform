import type { Metadata } from 'next';
import { config } from '@/lib/config/env';
import { ENQUIRY_TYPES } from '@/lib/intake/enquiry-types';
import { resolveLocale, t } from '@/lib/i18n/catalogue';

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
export default async function EnquiryPage({
  searchParams,
}: {
  searchParams: Promise<{ lang?: string }>;
}) {
  const cfg = config();
  // NFR-5.2. Public copy comes from the catalogue, so Bahasa Malaysia is an
  // entry in one object rather than an edit to this page.
  const locale = resolveLocale((await searchParams).lang);

  return (
    <main id="main" className="grain relative min-h-screen px-5 py-12">
      <div className="mx-auto w-full max-w-xl">
        <p className="text-ink-muted mb-2 font-mono text-xs tracking-widest uppercase">
          {cfg.FIRM_NAME}
        </p>
        <h1 className="rule-brass text-3xl">{t('enquiry.title', locale)}</h1>

        <p className="text-ink-muted mt-6 text-sm">{t('enquiry.intro', locale)}</p>

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
                Contact number
              </label>
              <input
                className="field"
                id="contactPhone"
                name="contactPhone"
                type="tel"
                required
                maxLength={40}
                autoComplete="tel"
              />
            </div>
          </div>

          <div className="grid gap-5 sm:grid-cols-2">
            <div>
              <label className="label" htmlFor="enquiryType">
                Enquiry type
              </label>
              {/*
                Required, as it is in the widget. It decides which team the
                enquiry reaches before a word has been classified, and an
                enquiry with no type is one a lawyer has to route by hand.
              */}
              <select
                className="field"
                id="enquiryType"
                name="enquiryType"
                defaultValue=""
                required
              >
                <option value="">Select enquiry type</option>
                {ENQUIRY_TYPES.map((type) => (
                  <option key={type.id} value={type.id}>
                    {type.label}
                  </option>
                ))}
              </select>
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
          </div>

          <div>
            <label className="label" htmlFor="message">
              What has happened? <span className="text-ink-faint font-normal">(optional)</span>
            </label>
            <textarea
              className="field min-h-40"
              id="message"
              name="message"
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

          {/*
            PDPA §7.2: processing starts when this form is submitted, so the
            acceptance is a condition of submitting it — the same tick the
            firm's own website form requires, recorded with its version.
          */}
          <div className="flex items-start gap-3">
            <input className="mt-1" id="terms" name="terms" type="checkbox" required value="on" />
            <label className="text-ink-muted text-sm" htmlFor="terms">
              I accept the{' '}
              <a className="underline" href={cfg.TERMS_URL} target="_blank" rel="noreferrer">
                terms &amp; conditions
              </a>{' '}
              and{' '}
              <a className="underline" href={cfg.PRIVACY_URL} target="_blank" rel="noreferrer">
                privacy policy
              </a>
              .
            </label>
          </div>

          <button className="btn btn-primary w-full" type="submit">
            {t('enquiry.submit', locale)}
          </button>

          <p className="text-ink-faint text-xs">{t('received.emergency', locale)}</p>
        </form>
      </div>
    </main>
  );
}

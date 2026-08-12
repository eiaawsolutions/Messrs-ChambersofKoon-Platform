import type { Metadata } from 'next';
import { config } from '@/lib/config/env';

/**
 * Rendered per request, not at build time.
 *
 * The page prints the exact embed snippet the webmaster will paste, including
 * the public key and the app's own origin. Prerendered, those would be
 * whatever the build environment held — so rotating `WIDGET_PUBLIC_KEY`
 * without a rebuild would leave this page confidently handing out a key that
 * no longer works.
 */
export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Enquiry widget — preview for approval',
  description: 'Pre-approval preview of the intake widget as it will appear on the firm website.',
  robots: { index: false, follow: false, nocache: true },
};

/**
 * Client approval preview (gate for FR-2.1 go-live).
 *
 * The widget cannot honestly be signed off from a screenshot: what is being
 * approved is a conversation, on a page, on a phone. So this renders the real
 * bundle — the same /widget.js the firm will embed, hitting the same endpoint —
 * inside a page dressed as a firm web page, and puts the snippet the webmaster
 * will paste directly underneath it.
 *
 * Deliberately unauthenticated. Approval involves people who do not have
 * accounts on this platform: the partners, the firm's webmaster, whoever
 * maintains the WordPress site. Requiring a sign-in would mean provisioning
 * accounts for a review, and the page reveals nothing an enquirer visiting the
 * firm's own website would not see. It is noindex, and the enquiries it
 * produces are real — see the notice below.
 */
export default function WidgetPreviewPage() {
  const cfg = config();
  const embedUrl = new URL('/widget.js', cfg.APP_BASE_URL).href;
  const snippet = `<script src="${embedUrl}" data-key="${cfg.WIDGET_PUBLIC_KEY}" defer></script>`;

  return (
    <>
      {/* ---- Preview chrome. Never mistake this page for the firm's site. -- */}
      <div className="bg-navy-800 px-5 py-3 text-sm text-white">
        <div className="mx-auto flex max-w-5xl flex-wrap items-center gap-x-3 gap-y-1">
          <span className="pill pill-warning">Preview</span>
          <span>
            This is a demonstration page on the Matter Velocity platform, not {cfg.FIRM_NAME}
            &rsquo;s website.
          </span>
        </div>
      </div>

      <main id="main" className="grain relative min-h-screen">
        {/* ---- A page dressed as the firm's, so the widget is judged in context. */}
        <section className="border-line border-b bg-white">
          <div className="mx-auto max-w-5xl px-5 py-5">
            <p className="font-mono text-xs tracking-widest uppercase opacity-70">
              Advocates &amp; Solicitors
            </p>
            <p className="font-serif text-xl">{cfg.FIRM_NAME}</p>
          </div>
        </section>

        <section className="mx-auto max-w-5xl px-5 py-16">
          <h1 className="rule-brass max-w-2xl font-serif text-4xl leading-tight">
            Considered counsel for matters that matter.
          </h1>
          <p className="text-ink-muted mt-6 max-w-2xl">
            Kuala Lumpur, Petaling Jaya and Ipoh. Conveyancing, family, corporate advisory,
            employment and dispute resolution.
          </p>
          <p className="text-ink-faint mt-10 text-sm">
            Placeholder copy. The firm&rsquo;s real pages are unchanged — only the enquiry button in
            the corner is new.
          </p>

          <div className="mt-12 grid gap-4 sm:grid-cols-3">
            {['Conveyancing', 'Family', 'Dispute resolution'].map((area) => (
              <div key={area} className="surface p-5">
                <p className="font-serif text-lg">{area}</p>
                <p className="text-ink-muted mt-2 text-sm">
                  Placeholder section, present so the widget can be judged against a real page
                  rather than an empty one.
                </p>
              </div>
            ))}
          </div>
        </section>

        {/* ---- What is actually being approved. --------------------------- */}
        <section className="border-line border-t bg-white">
          <div className="mx-auto max-w-5xl px-5 py-14">
            <h2 className="rule-brass font-serif text-2xl">Before you approve</h2>

            <p className="text-ink-muted mt-6 max-w-2xl text-sm">
              Open the enquiry button in the bottom-right corner and take it through a full
              conversation, on a desktop browser and on a phone. Please check each of these:
            </p>

            <ol className="text-ink mt-6 max-w-2xl list-decimal space-y-3 pl-5 text-sm">
              <li>
                The button wording, position and colour sit correctly against the firm&rsquo;s
                pages.
              </li>
              <li>
                The firm&rsquo;s name and the opening line read the way the firm would say it.
              </li>
              <li>
                The <strong>terms &amp; conditions</strong> and <strong>privacy policy</strong>{' '}
                links open the correct pages on the firm&rsquo;s website.
              </li>
              <li>
                The questions asked are the ones a clerk would ask, and nothing is asked that the
                firm would not ask a stranger.
              </li>
              <li>
                The closing message — the point at which the enquiry passes to a lawyer, and the
                appointment time it proposes — is acceptable.
              </li>
              <li>
                The disclaimer (&ldquo;we cannot give legal advice here&rdquo;) is worded as the
                firm requires.
              </li>
              <li>On a phone, the panel fills the screen and the keyboard does not obscure it.</li>
            </ol>

            <div className="surface mt-8 max-w-2xl bg-amber-100/40 p-5">
              <p className="text-sm">
                <strong>Enquiries made here are real.</strong> A conversation taken to the end
                creates an enquiry in the platform and notifies the duty lawyer exactly as a live
                one would. Please tell us which test enquiries to remove once approved.
              </p>
            </div>
          </div>
        </section>

        {/* ---- Handover for the webmaster. -------------------------------- */}
        <section className="border-line border-t">
          <div className="mx-auto max-w-5xl px-5 py-14">
            <h2 className="rule-brass font-serif text-2xl">For the website administrator</h2>
            <p className="text-ink-muted mt-6 max-w-2xl text-sm">
              Once approved, this single line goes into the firm&rsquo;s site, immediately before
              the closing <code>&lt;/body&gt;</code> tag, on every page. Nothing else changes: no
              plugin, no theme rebuild, no stylesheet.
            </p>

            <pre className="surface-raised text-ink mt-6 overflow-x-auto p-5 font-mono text-xs">
              {snippet}
            </pre>

            <p className="text-ink-muted mt-6 max-w-2xl text-sm">
              The widget will not work until the firm&rsquo;s domain is added to the
              platform&rsquo;s permitted-origins list — that is deliberate, so the enquiry endpoint
              cannot be called from anywhere else. Full instructions, including where to paste this
              in WordPress and how to remove it again, are in{' '}
              <code>docs/website-integration.md</code>.
            </p>
          </div>
        </section>
      </main>

      {/*
        The real bundle, embedded exactly as the firm will embed it. `defer` and
        the single `data-key` attribute match the documented snippet above, so
        what is approved here is what gets pasted there.
      */}
      <script src="/widget.js" data-key={cfg.WIDGET_PUBLIC_KEY} defer />
    </>
  );
}

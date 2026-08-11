import type { Metadata } from 'next';
import Script from 'next/script';
import { config } from '@/lib/config/env';

export const metadata: Metadata = {
  title: 'Demo — firm website with intake widget',
  robots: { index: false, follow: false },
};
export const dynamic = 'force-dynamic';

/**
 * Demo harness for Scenario 1.
 *
 * A deliberately plain stand-in for chambersofkoon.com.my, carrying the same
 * one-line script tag the real site will carry. The point of demoing here
 * rather than on the live site is that the widget is shown doing exactly what
 * it will do in production — same endpoint, same triage, same routing — without
 * anyone touching the firm's website first.
 *
 * The banner is not decoration. A partner watching a convincing mock-up needs
 * to be told plainly which parts are real, or the demo becomes a claim nobody
 * can check.
 */
export default function DemoPage() {
  const cfg = config();

  return (
    <>
      <div className="border-b-brass-500 bg-brass-100 border-b-2 px-5 py-2.5">
        <p className="text-brass-700 mx-auto max-w-5xl text-xs">
          <strong>Demonstration harness.</strong> This page stands in for chambersofkoon.com.my. The
          enquiry widget, the triage, the case brief and the consultation slot are the real
          production system — only this surrounding page is a mock-up.
        </p>
      </div>

      <main id="main" className="bg-paper">
        {/* --- Mock firm site header ---------------------------------------- */}
        <header className="border-line bg-paper-raised border-b">
          <div className="mx-auto flex max-w-5xl flex-wrap items-center justify-between gap-4 px-5 py-5">
            <div>
              <p className="font-display text-ink text-xl leading-tight">{cfg.FIRM_NAME}</p>
              <p className="text-ink-faint text-xs tracking-wide uppercase">
                Advocates &amp; Solicitors · Kuala Lumpur · Petaling Jaya · Ipoh
              </p>
            </div>
            <nav aria-label="Demo site">
              <ul className="text-ink-muted flex flex-wrap gap-5 text-sm">
                <li>Practice areas</li>
                <li>Our people</li>
                <li>Insights</li>
                <li className="text-ink font-medium">Contact</li>
              </ul>
            </nav>
          </div>
        </header>

        {/* --- Hero ---------------------------------------------------------- */}
        <section className="mx-auto max-w-5xl px-5 py-16">
          <p className="text-brass-500 font-mono text-xs tracking-[0.2em] uppercase">
            Litigation-led
          </p>
          <h1 className="font-display text-ink mt-3 max-w-3xl text-4xl leading-tight">
            Big-firm quality without big-firm fees.
          </h1>
          <p className="text-ink-muted mt-5 max-w-2xl">
            Family and matrimonial, debt recovery, land and property, and corporate disputes.
            Founded in 2021, practising across three offices.
          </p>

          <div className="mt-10 grid gap-px overflow-hidden rounded-md border border-[color:var(--color-line)] bg-[color:var(--color-line)] sm:grid-cols-2 lg:grid-cols-4">
            {[
              ['Family & Matrimonial', 'Divorce, custody, maintenance'],
              ['Debt Recovery', 'Demands, claims, enforcement'],
              ['Land & Property', 'Conveyancing, title disputes'],
              ['Corporate Disputes', 'Shareholder and contract'],
            ].map(([title, blurb]) => (
              <article key={title} className="bg-paper-raised p-5">
                <h2 className="text-ink text-sm font-semibold">{title}</h2>
                <p className="text-ink-muted mt-2 text-sm">{blurb}</p>
              </article>
            ))}
          </div>
        </section>

        {/* --- What the demo is showing -------------------------------------- */}
        <section className="border-line bg-paper-sunken border-t">
          <div className="mx-auto max-w-5xl px-5 py-12">
            <h2 className="rule-brass font-display text-2xl">Try the intake agent</h2>
            <p className="text-ink-muted mt-5 max-w-2xl text-sm">
              Use the <strong>Make an enquiry</strong> button in the corner. Send one message at a
              time and let the agent ask its own questions — that is how a real enquirer uses it,
              and it is what produces a usable brief.
            </p>

            <div className="mt-8 grid gap-6 md:grid-cols-3">
              {[
                {
                  step: '1',
                  title: 'The enquirer types',
                  body: 'No form fields, no category dropdown. The agent works out the practice area from what they say.',
                },
                {
                  step: '2',
                  title: 'It produces a brief',
                  body: 'Facts, urgency, what is still unknown — timestamped at the moment the enquiry arrived, whatever the hour.',
                },
                {
                  step: '3',
                  title: 'A lawyer decides',
                  body: 'A slot is proposed to the right fee earner. Nothing reaches the enquirer until that lawyer accepts.',
                },
              ].map((item) => (
                <div key={item.step} className="surface p-5">
                  <span className="text-brass-500 font-display text-2xl">{item.step}</span>
                  <h3 className="text-ink mt-2 text-sm font-semibold">{item.title}</h3>
                  <p className="text-ink-muted mt-2 text-sm">{item.body}</p>
                </div>
              ))}
            </div>

            <div className="surface-raised mt-8 p-5">
              <h3 className="text-ink text-sm font-semibold">What the agent will not do</h3>
              <p className="text-ink-muted mt-2 text-sm">
                Ask it whether you will win, or what it will cost. It declines and offers a
                consultation instead. It cannot give legal advice, quote a fee or promise an outcome
                — and it will not adopt a different role if you instruct it to.
              </p>
            </div>

            <p className="text-ink-faint mt-8 text-xs">
              Embedding on the real site is one line, with no rebuild:
            </p>
            <pre className="scroll-x surface text-ink mt-2 p-4 font-mono text-xs">
              {`<script src="${cfg.APP_BASE_URL}/widget.js" data-key="…" data-office="PJ" defer></script>`}
            </pre>
          </div>
        </section>

        <footer className="border-line border-t px-5 py-8">
          <p className="text-ink-faint mx-auto max-w-5xl text-xs">
            Demonstration environment. Do not enter real client information.
          </p>
        </footer>
      </main>

      {/*
        The same tag the firm's site will carry. Routed to PJ / family so the
        Scenario 1 enquiry reaches Chan Wei Ling's queue.
      */}
      <Script
        src="/widget.js"
        data-key={cfg.WIDGET_PUBLIC_KEY}
        data-firm={cfg.FIRM_SHORT_NAME}
        data-office="PJ"
        strategy="afterInteractive"
      />
    </>
  );
}

import type { Metadata, Viewport } from 'next';
import { Newsreader, IBM_Plex_Sans, IBM_Plex_Mono } from 'next/font/google';
import './globals.css';

/**
 * Typefaces are self-hosted by next/font — no external request at runtime,
 * which keeps the CSP tight and removes a third-party dependency from the
 * critical render path.
 *
 * Newsreader carries the authority a chambers needs without tipping into
 * pastiche. IBM Plex Sans is the working surface: humanist, excellent at
 * small sizes, and not one of the fonts that signals "generated".
 */
const newsreader = Newsreader({
  subsets: ['latin'],
  weight: ['400', '500', '600'],
  style: ['normal', 'italic'],
  variable: '--font-newsreader',
  display: 'swap',
});

const plexSans = IBM_Plex_Sans({
  subsets: ['latin'],
  weight: ['400', '500', '600'],
  variable: '--font-plex-sans',
  display: 'swap',
});

const plexMono = IBM_Plex_Mono({
  subsets: ['latin'],
  weight: ['400', '500'],
  variable: '--font-plex-mono',
  display: 'swap',
});

export const metadata: Metadata = {
  title: {
    default: 'Matter Velocity — Messrs Chambers of Koon',
    template: '%s · Matter Velocity',
  },
  description: 'Matter management, intake triage and precedent retrieval for Chambers of Koon.',
  // This is a private practice system; it must never be indexed.
  robots: { index: false, follow: false, nocache: true },
  applicationName: 'Matter Velocity',
  formatDetection: { telephone: false, email: false, address: false },
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  themeColor: '#1f4460',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html
      lang="en-MY"
      className={`${newsreader.variable} ${plexSans.variable} ${plexMono.variable}`}
    >
      <body>
        <a href="#main" className="skip-link">
          Skip to content
        </a>
        {children}
      </body>
    </html>
  );
}

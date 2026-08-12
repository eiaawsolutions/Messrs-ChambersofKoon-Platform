import type { NextConfig } from 'next';

/**
 * Security headers applied to every response (NFR-1.1, pentest readiness).
 *
 * The widget route (/widget.js) and the public enquiry endpoint deliberately
 * relax frame/CORS rules — those exceptions live in their own route handlers,
 * not here, so the default stays restrictive.
 */
const securityHeaders = [
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  { key: 'X-DNS-Prefetch-Control', value: 'off' },
  { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=(), payment=()' },
  {
    key: 'Strict-Transport-Security',
    value: 'max-age=63072000; includeSubDomains; preload',
  },
  {
    key: 'Content-Security-Policy',
    value: [
      "default-src 'self'",
      // Turnstile needs its own script/frame origin; 'unsafe-inline' is required
      // by Next's inlined bootstrap script.
      "script-src 'self' 'unsafe-inline' https://challenges.cloudflare.com",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: blob:",
      "font-src 'self' data:",
      // Turnstile's script calls back to its own origin, not only into its
      // iframe. Without it here the challenge fails on any page of this app
      // that runs the widget — which includes /preview/widget, the page the
      // firm signs the widget off from.
      "connect-src 'self' https://challenges.cloudflare.com https://*.ingest.sentry.io https://*.ingest.de.sentry.io",
      'frame-src https://challenges.cloudflare.com',
      "object-src 'none'",
      "base-uri 'self'",
      "form-action 'self'",
      "frame-ancestors 'none'",
      'upgrade-insecure-requests',
    ].join('; '),
  },
];

/**
 * Headers for the embeddable bundle.
 *
 * The full set above cannot apply: `frame-ancestors 'none'` and a `default-src
 * 'self'` CSP describe a page, not a script another origin is meant to load.
 * What still matters is applied deliberately here rather than by omission.
 *
 * The cache window is short because FR-2.1 fixes the URL — the firm embeds
 * `/widget.js`, not a hashed filename, so a fix has to reach their visitors
 * without anyone being asked to purge a cache. Five minutes is the trade
 * between that and the request volume of a boutique firm's website.
 */
const widgetHeaders = [
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'Cross-Origin-Resource-Policy', value: 'cross-origin' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  {
    key: 'Strict-Transport-Security',
    value: 'max-age=63072000; includeSubDomains; preload',
  },
  { key: 'Cache-Control', value: 'public, max-age=300, stale-while-revalidate=86400' },
];

const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false, // no version disclosure (penetration-testing.md)
  productionBrowserSourceMaps: false,
  output: 'standalone',
  serverExternalPackages: ['pg', 'pg-boss', 'docxtemplater', 'pizzip', 'unpdf', 'mammoth'],
  experimental: {
    typedRoutes: true,
  },
  async headers() {
    return [
      {
        source: '/((?!widget.js).*)',
        headers: securityHeaders,
      },
      {
        source: '/widget.js',
        headers: widgetHeaders,
      },
    ];
  },
};

export default nextConfig;

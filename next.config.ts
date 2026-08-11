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
      "connect-src 'self' https://*.ingest.sentry.io https://*.ingest.de.sentry.io",
      'frame-src https://challenges.cloudflare.com',
      "object-src 'none'",
      "base-uri 'self'",
      "form-action 'self'",
      "frame-ancestors 'none'",
      'upgrade-insecure-requests',
    ].join('; '),
  },
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
    ];
  },
};

export default nextConfig;

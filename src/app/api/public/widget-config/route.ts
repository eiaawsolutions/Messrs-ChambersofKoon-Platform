import { NextResponse, type NextRequest } from 'next/server';
import { config } from '@/lib/config/env';
import { corsHeaders, resolveAllowedOrigin } from '@/lib/intake/protection';
import { ENQUIRY_TYPES } from '@/lib/intake/enquiry-types';
import { catalogueFor, resolveLocale, type Locale, type MessageKey } from '@/lib/i18n/catalogue';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Public widget configuration (supports FR-2.1).
 *
 * FR-2.1 fixes the embed contract at one script tag carrying one attribute:
 *
 *   <script src="https://<app-domain>/widget.js" data-key="<public-key>" defer></script>
 *
 * Everything else the widget needs to render honestly — the firm's name, the
 * Turnstile site key, where the terms and privacy links point, where to send
 * someone whose browser cannot run the challenge — is runtime configuration
 * that changes without the firm touching their website. Pushing it into
 * `data-` attributes would mean a WordPress edit every time the firm revises a
 * policy URL or rotates a site key, and a silently stale widget whenever that
 * edit is forgotten. So the widget asks the platform instead.
 *
 * Nothing here is a secret. A Turnstile *site* key is public by design — it
 * appears in the markup of every site that uses Turnstile — and the rest is
 * already on the firm's website. The corresponding secret key never leaves the
 * server (see verifyTurnstile).
 */

interface WidgetConfigResponse {
  firmName: string;
  /** Null when the bot check is switched off for this environment. */
  turnstileSiteKey: string | null;
  termsUrl: string;
  privacyUrl: string;
  /** The no-JavaScript form (FR-2.2), offered when the widget cannot proceed. */
  fallbackUrl: string;
  /**
   * The firm's four public enquiry types, for the widget's opening form.
   *
   * Served rather than compiled into the bundle so the list stays the firm's
   * to change: adding a fifth practice area becomes a deploy of this platform,
   * not an edit to the firm's website followed by a cache purge. A widget
   * holding a stale list would offer a type the server then refuses, which is
   * an enquiry lost at the last step.
   */
  enquiryTypes: Array<{ id: string; label: string }>;
  /**
   * The widget's own copy, in the requested language (NFR-5.2).
   *
   * Served rather than compiled in for the same reason as `enquiryTypes`: the
   * widget bundle is cached on the firm's website behind whatever CDN and
   * optimisation plugin they run, so a string baked into it is a string that
   * takes an unknown number of days to change. Adding Bahasa Malaysia should
   * reach visitors on the next configuration fetch, and it does.
   */
  locale: Locale;
  messages: Record<MessageKey, string>;
}

function payload(locale: Locale): WidgetConfigResponse {
  const cfg = config();
  return {
    locale,
    messages: catalogueFor(locale),
    firmName: cfg.FIRM_NAME,
    // Only advertise a site key when the server will actually check the token.
    // Advertising one while TURNSTILE_ENABLED is false would make the widget
    // block sends on a challenge nothing is verifying.
    turnstileSiteKey: cfg.TURNSTILE_ENABLED ? (cfg.TURNSTILE_SITE_KEY ?? null) : null,
    termsUrl: cfg.TERMS_URL,
    privacyUrl: cfg.PRIVACY_URL,
    fallbackUrl: new URL('/enquiry', cfg.APP_BASE_URL).href,
    // Label only. The blurb is the firm's own longer description and belongs
    // on the website, not in a 400px panel where it would push the form below
    // the fold on a phone.
    enquiryTypes: ENQUIRY_TYPES.map((type) => ({ id: type.id, label: type.label })),
  };
}

/**
 * `Vary: Origin` is set on every response, not only the allow-listed ones.
 *
 * The response is cacheable, and `corsHeaders` emits its own `Vary` only when
 * the origin passes. Without this, a shared cache could store the header-less
 * response produced for an unknown origin and later hand it to the firm's
 * site, which would then see no `access-control-allow-origin` and refuse its
 * own configuration.
 */
function headers(origin: string | null): Record<string, string> {
  return {
    ...corsHeaders(origin),
    vary: 'Origin',
    'cache-control': 'public, max-age=300',
  };
}

/**
 * The language for this response.
 *
 * `?lang=` first, because a firm that runs a Malay page wants the widget on it
 * in Malay regardless of the visitor's browser. `Accept-Language` second, so a
 * Malay-speaking visitor to an English page is met in their own language.
 * Anything unrecognised falls back to English rather than erroring.
 */
function localeFor(request: NextRequest): Locale {
  const explicit = request.nextUrl.searchParams.get('lang');
  if (explicit) return resolveLocale(explicit);

  const header = request.headers.get('accept-language') ?? '';
  // 'ms', 'ms-MY', 'ms-MY;q=0.9' — the primary subtag is what identifies it.
  if (/(^|,)\s*ms\b/i.test(header)) return resolveLocale('ms-MY');
  return resolveLocale(null);
}

export function OPTIONS(request: NextRequest): NextResponse {
  const origin = request.headers.get('origin');
  if (!resolveAllowedOrigin(origin)) {
    return new NextResponse(null, { status: 403 });
  }
  return new NextResponse(null, {
    status: 204,
    headers: { ...corsHeaders(origin), 'access-control-allow-methods': 'GET, OPTIONS' },
  });
}

/**
 * Unknown origins are answered, not refused.
 *
 * The body is public information, and a browser calling from a non-allow-listed
 * origin never sees it: without `access-control-allow-origin` the fetch fails
 * in the client. Returning 403 instead would only differ for non-browser
 * callers, who can read the same values off the firm's website anyway — and it
 * would turn the preview page, which is same-origin and therefore sends no
 * `Origin` header at all, into a special case.
 */
export function GET(request: NextRequest): NextResponse {
  const origin = request.headers.get('origin');
  return NextResponse.json(payload(localeFor(request)), {
    headers: {
      ...headers(origin),
      // The body now varies by language as well as by origin, so a shared
      // cache must not serve one visitor's language to the next.
      vary: 'Origin, Accept-Language',
    },
  });
}

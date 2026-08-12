import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { NextRequest } from 'next/server';
import { __resetConfigForTests } from '@/lib/config/env';
import { GET, OPTIONS } from './route';

/**
 * The widget reads its configuration from here on every page of the firm's
 * website, so the two failure modes worth fixing in place are: advertising a
 * bot check the server is not enforcing (which blocks sends for no reason),
 * and letting a cache hand one origin's CORS answer to another.
 */

const ORIGINAL = { ...process.env };
const FIRM_ORIGIN = 'https://chambersofkoon.com.my';

function request(origin: string | null): NextRequest {
  return new NextRequest('https://app.example.test/api/public/widget-config', {
    headers: origin ? { origin } : {},
  });
}

beforeEach(() => {
  process.env.APP_BASE_URL = 'https://app.example.test';
  process.env.WIDGET_ALLOWED_ORIGINS = FIRM_ORIGIN;
  process.env.FIRM_NAME = 'Messrs Chambers of Koon';
  process.env.TERMS_URL = 'https://chambersofkoon.com.my/terms-conditions';
  process.env.PRIVACY_URL = 'https://chambersofkoon.com.my/privacy-policy';
  process.env.TURNSTILE_ENABLED = 'true';
  process.env.TURNSTILE_SITE_KEY = '0x4AAAAAAA_test_site_key';
  __resetConfigForTests();
});

afterEach(() => {
  process.env = { ...ORIGINAL };
  __resetConfigForTests();
});

describe('GET /api/public/widget-config', () => {
  it('serves the firm details and policy links the widget renders', async () => {
    const body = await GET(request(FIRM_ORIGIN)).json();
    expect(body).toMatchObject({
      firmName: 'Messrs Chambers of Koon',
      termsUrl: 'https://chambersofkoon.com.my/terms-conditions',
      privacyUrl: 'https://chambersofkoon.com.my/privacy-policy',
    });
  });

  it('points the fallback at the no-JavaScript form on the app origin', async () => {
    const body = await GET(request(FIRM_ORIGIN)).json();
    expect(body.fallbackUrl).toBe('https://app.example.test/enquiry');
  });

  it("serves the firm's four public enquiry types for the opening form", async () => {
    // The widget renders this list. Compiled into the bundle it would go stale
    // against the server's own allow-list and offer a type that is then
    // refused — an enquiry lost at the last step.
    const body = await GET(request(FIRM_ORIGIN)).json();
    expect(body.enquiryTypes).toEqual([
      { id: 'family_matrimonial', label: 'Family and Matrimonial' },
      { id: 'corporate_commercial', label: 'Corporate & Commercial' },
      { id: 'dispute_resolution', label: 'Dispute Resolution' },
      { id: 'property_land', label: 'Property & Land' },
    ]);
  });

  it('never names debt recovery as a public type', async () => {
    // The firm advertises it under Corporate & Commercial. A type the website
    // does not offer would confuse the one person who has an unpaid invoice.
    const body = await GET(request(FIRM_ORIGIN)).json();
    const labels = (body.enquiryTypes as Array<{ label: string }>).map((t) => t.label).join(' ');
    expect(labels.toLowerCase()).not.toContain('debt');
  });

  it('advertises the site key when the server is checking tokens', async () => {
    const body = await GET(request(FIRM_ORIGIN)).json();
    expect(body.turnstileSiteKey).toBe('0x4AAAAAAA_test_site_key');
  });

  it('withholds the site key when the check is switched off', async () => {
    // Otherwise the widget waits on a challenge, and refuses to send without
    // one, while the server would have accepted the turn regardless.
    process.env.TURNSTILE_ENABLED = 'false';
    __resetConfigForTests();

    const body = await GET(request(FIRM_ORIGIN)).json();
    expect(body.turnstileSiteKey).toBeNull();
  });

  it('withholds the site key when it is enabled but unset', async () => {
    delete process.env.TURNSTILE_SITE_KEY;
    __resetConfigForTests();

    const body = await GET(request(FIRM_ORIGIN)).json();
    expect(body.turnstileSiteKey).toBeNull();
  });

  it('returns CORS headers to the allow-listed firm origin', () => {
    const response = GET(request(FIRM_ORIGIN));
    expect(response.headers.get('access-control-allow-origin')).toBe(FIRM_ORIGIN);
  });

  it('withholds CORS headers from an unknown origin, so the browser blocks it', () => {
    const response = GET(request('https://attacker.test'));
    expect(response.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('varies on Origin even when the origin was refused', () => {
    // The response is cacheable. Without this, the header-less answer produced
    // for an unknown origin could be replayed to the firm's own site.
    //
    // Asserted by inclusion rather than equality: the body also varies by
    // language (NFR-5.2), and pinning the whole header would fail the next
    // time a legitimate cache dimension is added without anything being wrong.
    for (const origin of ['https://attacker.test', null]) {
      const vary = GET(request(origin)).headers.get('vary') ?? '';
      expect(vary.split(',').map((part) => part.trim())).toContain('Origin');
    }
  });

  it('varies on Accept-Language, so one visitor’s language is not cached for the next', () => {
    const vary = GET(request(FIRM_ORIGIN)).headers.get('vary') ?? '';
    expect(vary.split(',').map((part) => part.trim())).toContain('Accept-Language');
  });

  it('serves the widget its copy, defaulting to English (NFR-5.2)', async () => {
    const body = (await GET(request(FIRM_ORIGIN)).json()) as {
      locale: string;
      messages: Record<string, string>;
    };

    expect(body.locale).toBe('en-MY');
    expect(body.messages['widget.launcher']).toBe('Make an enquiry');
    // Every string the widget renders must be present, or the panel shows a
    // blank where a label belongs.
    expect(Object.values(body.messages).every((value) => value.length > 0)).toBe(true);
  });

  it('answers a same-origin request that carries no Origin header', async () => {
    // The approval preview is served from the app itself.
    const response = GET(request(null));
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ firmName: 'Messrs Chambers of Koon' });
  });
});

describe('OPTIONS /api/public/widget-config', () => {
  it('preflights successfully for the firm origin', () => {
    const response = OPTIONS(request(FIRM_ORIGIN));
    expect(response.status).toBe(204);
    expect(response.headers.get('access-control-allow-methods')).toContain('GET');
  });

  it('refuses a preflight from an unknown origin', () => {
    expect(OPTIONS(request('https://attacker.test')).status).toBe(403);
  });
});

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { __resetConfigForTests } from '@/lib/config/env';
import { corsHeaders, isValidWidgetKey, resolveAllowedOrigin } from './protection';

/**
 * The origin allow-list is the outermost control on the only unauthenticated
 * write surface in the platform (FR-2.3), and it is about to be pointed at a
 * live website. These fix the two ways an allow-list usually fails: letting
 * through something that merely looks like the allowed host, and quietly
 * degrading to a wildcard when nothing matches.
 */

const ORIGINAL = { ...process.env };

beforeEach(() => {
  process.env.APP_BASE_URL = 'https://app.example.test';
  process.env.WIDGET_ALLOWED_ORIGINS =
    'https://chambersofkoon.com.my, https://www.chambersofkoon.com.my/';
  process.env.WIDGET_PUBLIC_KEY = 'cok_public_test_key';
  __resetConfigForTests();
});

afterEach(() => {
  process.env = { ...ORIGINAL };
  __resetConfigForTests();
});

describe('resolveAllowedOrigin', () => {
  it('allows a configured origin', () => {
    expect(resolveAllowedOrigin('https://chambersofkoon.com.my')).toBe(
      'https://chambersofkoon.com.my',
    );
  });

  it('allows the www form separately from the apex', () => {
    expect(resolveAllowedOrigin('https://www.chambersofkoon.com.my')).toBe(
      'https://www.chambersofkoon.com.my',
    );
  });

  it('normalises a trailing slash on both sides', () => {
    // Configured with a trailing slash above; browsers never send one.
    expect(resolveAllowedOrigin('https://www.chambersofkoon.com.my/')).toBe(
      'https://www.chambersofkoon.com.my',
    );
  });

  it("allows the app's own origin so the approval preview works", () => {
    expect(resolveAllowedOrigin('https://app.example.test')).toBe('https://app.example.test');
  });

  it('refuses a missing origin', () => {
    expect(resolveAllowedOrigin(null)).toBeNull();
  });

  it('refuses a host that merely ends with the allowed one', () => {
    expect(resolveAllowedOrigin('https://chambersofkoon.com.my.attacker.test')).toBeNull();
  });

  it('refuses a subdomain that was not listed', () => {
    expect(resolveAllowedOrigin('https://staging.chambersofkoon.com.my')).toBeNull();
  });

  it('refuses the same host over plain http', () => {
    expect(resolveAllowedOrigin('http://chambersofkoon.com.my')).toBeNull();
  });
});

describe('corsHeaders', () => {
  it('echoes exactly the requesting origin, never a wildcard', () => {
    const headers = corsHeaders('https://chambersofkoon.com.my');
    expect(headers['access-control-allow-origin']).toBe('https://chambersofkoon.com.my');
    expect(Object.values(headers)).not.toContain('*');
  });

  it('varies on Origin so a shared cache cannot cross the allow-list', () => {
    expect(corsHeaders('https://chambersofkoon.com.my').vary).toBe('Origin');
  });

  it('emits nothing at all for a refused origin', () => {
    expect(corsHeaders('https://attacker.test')).toEqual({});
  });

  it('permits the widget key header the widget actually sends', () => {
    expect(corsHeaders('https://chambersofkoon.com.my')['access-control-allow-headers']).toContain(
      'x-widget-key',
    );
  });
});

describe('isValidWidgetKey', () => {
  it('accepts the configured key', () => {
    expect(isValidWidgetKey('cok_public_test_key')).toBe(true);
  });

  it('refuses a missing key', () => {
    expect(isValidWidgetKey(null)).toBe(false);
    expect(isValidWidgetKey('')).toBe(false);
  });

  it('refuses a wrong key', () => {
    expect(isValidWidgetKey('cok_public_wrong_key')).toBe(false);
  });

  it('refuses a prefix of the configured key', () => {
    expect(isValidWidgetKey('cok_public_test')).toBe(false);
  });
});

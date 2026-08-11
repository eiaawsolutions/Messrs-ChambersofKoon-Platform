import { describe, expect, it } from 'vitest';
import { enforceMfa, hasMfaClaim, isDomainAllowed } from './policy';

describe('FR-1.3 — email domain allow-list', () => {
  const domains = ['chambersofkoon.com.my'];

  it('admits an address on the firm domain', () => {
    expect(isDomainAllowed('yongkoon@chambersofkoon.com.my', domains)).toBe(true);
  });

  it('is case-insensitive on the domain', () => {
    expect(isDomainAllowed('YongKoon@ChambersOfKoon.COM.MY', domains)).toBe(true);
  });

  it('refuses a look-alike domain', () => {
    expect(isDomainAllowed('attacker@chambersofkoon.com', domains)).toBe(false);
    expect(isDomainAllowed('attacker@notchambersofkoon.com.my', domains)).toBe(false);
  });

  it('refuses a subdomain that was not allow-listed', () => {
    expect(isDomainAllowed('a@mail.chambersofkoon.com.my', domains)).toBe(false);
  });

  it('is not fooled by an @ in the local part', () => {
    // lastIndexOf('@') is what makes this safe.
    expect(isDomainAllowed('"a@chambersofkoon.com.my"@evil.com', domains)).toBe(false);
  });

  it('refuses a malformed address', () => {
    expect(isDomainAllowed('no-at-sign', domains)).toBe(false);
    expect(isDomainAllowed('', domains)).toBe(false);
  });
});

describe('FR-1.2 — MFA claim handling', () => {
  it('detects amr containing mfa', () => {
    expect(hasMfaClaim({ amr: ['pwd', 'mfa'] })).toBe(true);
  });

  it('detects hardware-key and OTP factors', () => {
    expect(hasMfaClaim({ amr: ['fido'] })).toBe(true);
    expect(hasMfaClaim({ amr: ['otp'] })).toBe(true);
  });

  it('does not treat password-only as MFA', () => {
    expect(hasMfaClaim({ amr: ['pwd'] })).toBe(false);
  });

  it('handles a missing profile', () => {
    expect(hasMfaClaim(undefined)).toBe(false);
    expect(hasMfaClaim({})).toBe(false);
  });

  it('rejects an Entra session with no MFA claim', () => {
    const result = enforceMfa('microsoft-entra-id', { amr: ['pwd'] });
    expect(result.allowed).toBe(false);
  });

  it('admits an Entra session carrying the MFA claim', () => {
    const result = enforceMfa('microsoft-entra-id', { amr: ['pwd', 'mfa'] });
    expect(result.allowed).toBe(true);
    expect(result.promptSetup).toBe(false);
  });

  it('admits a Google session but flags setup, since Google emits no claim', () => {
    // Rejecting here would lock out the whole firm on a provider that simply
    // does not supply the signal.
    const result = enforceMfa('google', { email_verified: true });
    expect(result.allowed).toBe(true);
    expect(result.promptSetup).toBe(true);
  });
});

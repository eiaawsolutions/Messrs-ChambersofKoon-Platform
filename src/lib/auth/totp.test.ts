import { describe, expect, it } from 'vitest';
import {
  base32Decode,
  base32Encode,
  formatSecretForManualEntry,
  generateHotp,
  generateTotp,
  generateTotpSecret,
  otpauthUri,
  timeStep,
  verifyTotp,
} from './totp';

/**
 * The RFC test vectors are the point of this file. A TOTP implementation that
 * looks right but disagrees with the RFC by one step produces codes no
 * authenticator app accepts, and the failure only shows up when a real person
 * cannot sign in.
 */

/** RFC 4226 Appendix D: secret "12345678901234567890" (ASCII). */
const RFC4226_SECRET = base32Encode(Buffer.from('12345678901234567890', 'ascii'));

const RFC4226_HOTP = [
  '755224',
  '287082',
  '359152',
  '969429',
  '338314',
  '254676',
  '287922',
  '162583',
  '399871',
  '520489',
];

describe('base32', () => {
  it('round-trips arbitrary bytes', () => {
    const original = Buffer.from([0x00, 0xff, 0x10, 0x7a, 0x9c, 0x01]);
    expect(base32Decode(base32Encode(original)).equals(original)).toBe(true);
  });

  it('encodes the RFC test secret to the expected base32', () => {
    // "12345678901234567890" is GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ
    expect(RFC4226_SECRET).toBe('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ');
  });

  it('tolerates padding, whitespace and lower case', () => {
    const secret = generateTotpSecret();
    const messy = `${secret.toLowerCase().replace(/(.{4})/g, '$1 ')}===`;
    expect(base32Decode(messy).equals(base32Decode(secret))).toBe(true);
  });

  it('rejects an invalid character', () => {
    expect(() => base32Decode('ABC!DEF')).toThrow();
  });
});

describe('HOTP — RFC 4226 Appendix D vectors', () => {
  it.each(RFC4226_HOTP.map((code, counter) => [counter, code]))(
    'counter %i produces %s',
    (counter, expected) => {
      expect(generateHotp(RFC4226_SECRET, counter as number)).toBe(expected);
    },
  );
});

/**
 * RFC 6238 Appendix B vectors, SHA-1 rows only. The RFC prints 8-digit values;
 * this implementation emits the 6 digits every authenticator app uses, so the
 * expectation is the last six.
 */
describe('TOTP — RFC 6238 Appendix B vectors (SHA-1)', () => {
  const cases: Array<[number, string]> = [
    [59, '94287082'],
    [1111111109, '07081804'],
    [1111111111, '14050471'],
    [1234567890, '89005924'],
    [2000000000, '69279037'],
    [20000000000, '65353130'],
  ];

  it.each(cases)('at unix time %i', (seconds, eightDigit) => {
    const expected = eightDigit.slice(-6);
    expect(generateTotp(RFC4226_SECRET, seconds * 1000)).toBe(expected);
  });
});

describe('timeStep', () => {
  it('advances once per 30 seconds', () => {
    expect(timeStep(0)).toBe(0);
    expect(timeStep(29_999)).toBe(0);
    expect(timeStep(30_000)).toBe(1);
    expect(timeStep(59_999)).toBe(1);
  });
});

describe('verifyTotp', () => {
  const secret = generateTotpSecret();
  const now = 1_700_000_000_000;

  it('accepts the current code', () => {
    const code = generateTotp(secret, now);
    const result = verifyTotp({ secret, token: code, atMs: now });
    expect(result.valid).toBe(true);
    expect(result.step).toBe(timeStep(now));
  });

  it('accepts a code from the previous step, for clock drift', () => {
    const code = generateTotp(secret, now - 30_000);
    expect(verifyTotp({ secret, token: code, atMs: now }).valid).toBe(true);
  });

  it('accepts a code from the next step', () => {
    const code = generateTotp(secret, now + 30_000);
    expect(verifyTotp({ secret, token: code, atMs: now }).valid).toBe(true);
  });

  it('rejects a code two steps old', () => {
    const code = generateTotp(secret, now - 90_000);
    expect(verifyTotp({ secret, token: code, atMs: now }).valid).toBe(false);
  });

  it('rejects a wrong code', () => {
    expect(verifyTotp({ secret, token: '000000', atMs: now }).valid).toBe(false);
  });

  it('rejects a malformed code without throwing', () => {
    expect(verifyTotp({ secret, token: 'abcdef', atMs: now }).valid).toBe(false);
    expect(verifyTotp({ secret, token: '', atMs: now }).valid).toBe(false);
    expect(verifyTotp({ secret, token: '12345', atMs: now }).valid).toBe(false);
  });

  it('tolerates spaces, as typed from an authenticator app', () => {
    const code = generateTotp(secret, now);
    const spaced = `${code.slice(0, 3)} ${code.slice(3)}`;
    expect(verifyTotp({ secret, token: spaced, atMs: now }).valid).toBe(true);
  });

  describe('replay prevention', () => {
    it('refuses a code that was already used', () => {
      const code = generateTotp(secret, now);
      const first = verifyTotp({ secret, token: code, atMs: now });
      expect(first.valid).toBe(true);

      const replay = verifyTotp({
        secret,
        token: code,
        atMs: now,
        lastUsedStep: first.step,
      });
      expect(replay.valid).toBe(false);
    });

    it('refuses a code older than the last accepted one', () => {
      const previous = generateTotp(secret, now - 30_000);
      const result = verifyTotp({
        secret,
        token: previous,
        atMs: now,
        lastUsedStep: timeStep(now),
      });
      expect(result.valid).toBe(false);
    });

    it('still accepts the next period after a code is used', () => {
      const used = timeStep(now);
      const next = generateTotp(secret, now + 30_000);
      const result = verifyTotp({
        secret,
        token: next,
        atMs: now + 30_000,
        lastUsedStep: used,
      });
      expect(result.valid).toBe(true);
      expect(result.step).toBe(used + 1);
    });
  });
});

describe('otpauthUri', () => {
  const uri = otpauthUri({
    secret: 'JBSWY3DPEHPK3PXP',
    accountName: 'yongkoon@chambersofkoon.com.my',
    issuer: 'Matter Velocity',
  });

  it('uses the otpauth totp scheme', () => {
    expect(uri.startsWith('otpauth://totp/')).toBe(true);
  });

  it('carries the issuer as both label prefix and parameter', () => {
    // Older apps read the label, newer ones the parameter. Both are needed or
    // the account shows up unnamed in some apps.
    expect(uri).toContain('otpauth://totp/Matter%20Velocity:');
    expect(uri).toContain('issuer=Matter+Velocity');
  });

  it('carries the account, secret and standard parameters', () => {
    expect(uri).toContain('yongkoon%40chambersofkoon.com.my');
    expect(uri).toContain('secret=JBSWY3DPEHPK3PXP');
    expect(uri).toContain('algorithm=SHA1');
    expect(uri).toContain('digits=6');
    expect(uri).toContain('period=30');
  });
});

describe('generateTotpSecret', () => {
  it('is 160 bits, the RFC 4226 recommendation', () => {
    expect(base32Decode(generateTotpSecret()).length).toBe(20);
  });

  it('differs every time', () => {
    const secrets = new Set(Array.from({ length: 20 }, () => generateTotpSecret()));
    expect(secrets.size).toBe(20);
  });
});

describe('formatSecretForManualEntry', () => {
  it('groups in fours for reading aloud', () => {
    expect(formatSecretForManualEntry('JBSWY3DPEHPK3PXP')).toBe('JBSW Y3DP EHPK 3PXP');
  });
});

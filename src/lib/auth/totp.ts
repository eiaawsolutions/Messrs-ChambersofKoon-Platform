import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Time-based one-time passwords (RFC 6238 over RFC 4226).
 *
 * Implemented directly rather than pulled in, because the algorithm is about
 * forty lines and the dependency surface for authentication code is worth
 * keeping at zero. The output is verified against the RFC 6238 published test
 * vectors in totp.test.ts.
 *
 * Compatible with Google Authenticator, Microsoft Authenticator, 1Password,
 * Authy and anything else that reads an `otpauth://` URI: SHA-1, 6 digits,
 * 30-second period. Those parameters are not a security choice — they are what
 * every authenticator app actually implements, and a stronger configuration
 * that half the apps silently fail on would be worse.
 */

const DIGITS = 6;
const PERIOD_SECONDS = 30;
const ALGORITHM = 'sha1';

/**
 * How many steps either side of now are accepted. One step (±30s) tolerates
 * ordinary clock drift and the time taken to type the code. Wider windows
 * meaningfully increase the number of codes valid at any instant.
 */
export const DEFAULT_WINDOW = 1;

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Encode(buffer: Buffer): string {
  let bits = 0;
  let value = 0;
  let output = '';

  for (const byte of buffer) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) {
    output += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  }
  return output;
}

export function base32Decode(input: string): Buffer {
  const clean = input.toUpperCase().replace(/=+$/, '').replace(/\s/g, '');
  let bits = 0;
  let value = 0;
  const output: number[] = [];

  for (const char of clean) {
    const index = BASE32_ALPHABET.indexOf(char);
    if (index === -1) throw new Error('Invalid base32 character in TOTP secret');
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      output.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(output);
}

/** A fresh 160-bit secret — the size RFC 4226 recommends for HMAC-SHA1. */
export function generateTotpSecret(): string {
  return base32Encode(randomBytes(20));
}

/** Counter value for a given instant. Exported so callers can record it. */
export function timeStep(atMs: number = Date.now()): number {
  return Math.floor(atMs / 1000 / PERIOD_SECONDS);
}

/** HOTP (RFC 4226) for an explicit counter. */
export function generateHotp(secret: string, counter: number): string {
  const key = base32Decode(secret);

  const buffer = Buffer.alloc(8);
  // Counter is 64-bit big-endian. JS bitwise ops are 32-bit, so the halves are
  // written separately rather than shifted.
  buffer.writeUInt32BE(Math.floor(counter / 2 ** 32), 0);
  buffer.writeUInt32BE(counter >>> 0, 4);

  const digest = createHmac(ALGORITHM, key).update(buffer).digest();

  // Dynamic truncation, RFC 4226 §5.3.
  const offset = digest[digest.length - 1]! & 0x0f;
  const binary =
    ((digest[offset]! & 0x7f) << 24) |
    ((digest[offset + 1]! & 0xff) << 16) |
    ((digest[offset + 2]! & 0xff) << 8) |
    (digest[offset + 3]! & 0xff);

  return (binary % 10 ** DIGITS).toString().padStart(DIGITS, '0');
}

export function generateTotp(secret: string, atMs: number = Date.now()): string {
  return generateHotp(secret, timeStep(atMs));
}

export interface TotpVerifyResult {
  valid: boolean;
  /** The step that matched. Persist it to stop the same code being replayed. */
  step: number | null;
}

/**
 * Verify a submitted code.
 *
 * `lastUsedStep` is the replay guard: a TOTP code stays valid for its whole
 * period, so without it a code observed over someone's shoulder — or captured
 * in a phished form — can be used again within the same 30 seconds. Callers
 * persist the returned step and pass it back next time.
 */
export function verifyTotp(params: {
  secret: string;
  token: string;
  atMs?: number;
  window?: number;
  lastUsedStep?: number | null;
}): TotpVerifyResult {
  const token = params.token.replace(/\D/g, '');
  if (token.length !== DIGITS) return { valid: false, step: null };

  const window = params.window ?? DEFAULT_WINDOW;
  const current = timeStep(params.atMs ?? Date.now());

  for (let offset = -window; offset <= window; offset += 1) {
    const step = current + offset;
    if (
      params.lastUsedStep !== null &&
      params.lastUsedStep !== undefined &&
      step <= params.lastUsedStep
    ) {
      continue; // already used, or older than the last accepted code
    }

    const expected = generateHotp(params.secret, step);
    const a = Buffer.from(expected);
    const b = Buffer.from(token);
    if (a.length === b.length && timingSafeEqual(a, b)) {
      return { valid: true, step };
    }
  }

  return { valid: false, step: null };
}

/**
 * `otpauth://` URI for the enrolment QR code.
 *
 * The issuer appears both as a path prefix and as a parameter — older
 * authenticator apps read one, newer ones the other, and getting this wrong is
 * why some accounts show up in the app with no name against them.
 */
export function otpauthUri(params: {
  secret: string;
  accountName: string;
  issuer: string;
}): string {
  const issuer = encodeURIComponent(params.issuer);
  const account = encodeURIComponent(params.accountName);
  const query = new URLSearchParams({
    secret: params.secret,
    issuer: params.issuer,
    algorithm: 'SHA1',
    digits: String(DIGITS),
    period: String(PERIOD_SECONDS),
  });
  return `otpauth://totp/${issuer}:${account}?${query.toString()}`;
}

/** Grouped for reading aloud when a camera is not available. */
export function formatSecretForManualEntry(secret: string): string {
  return secret.replace(/(.{4})/g, '$1 ').trim();
}

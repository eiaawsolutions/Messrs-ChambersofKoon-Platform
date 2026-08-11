import { randomBytes, scrypt as scryptCb, timingSafeEqual, type ScryptOptions } from 'node:crypto';

/**
 * `promisify` resolves to the 3-argument overload, which cannot carry the
 * cost parameters, so the options form is wrapped by hand.
 */
function scrypt(
  password: string,
  salt: Buffer,
  keyLength: number,
  options: ScryptOptions,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scryptCb(password, salt, keyLength, options, (error, derivedKey) => {
      if (error) reject(error);
      else resolve(derivedKey);
    });
  });
}

/**
 * Password hashing.
 *
 * scrypt from node:crypto rather than Argon2id. Argon2id is the first choice in
 * the OWASP Password Storage guidance, but every Node binding for it is a
 * native module, and this project already hit a cross-platform lockfile failure
 * with one native dependency on the Railway builder. scrypt is the named
 * fallback in the same guidance, is in the standard library, and has no build
 * surface at all. The parameters below exceed the OWASP minimum
 * (N=2^17, r=8, p=1).
 *
 * Format: `scrypt$N$r$p$<salt-b64>$<hash-b64>`
 * Parameters are stored per hash so they can be raised later without
 * invalidating existing passwords — `needsRehash` detects the older ones.
 */

const ALGORITHM = 'scrypt';
const N = 2 ** 17;
const R = 8;
const P = 1;
const KEY_LENGTH = 64;
const SALT_BYTES = 16;

/**
 * scrypt needs roughly 128 * N * r bytes. At N=2^17, r=8 that is ~134 MB, well
 * above Node's default 32 MB cap, so it must be raised explicitly or the call
 * throws.
 */
const MAX_MEMORY = 192 * 1024 * 1024;

export async function hashPassword(plain: string): Promise<string> {
  const salt = randomBytes(SALT_BYTES);
  const derived = await scrypt(plain.normalize('NFKC'), salt, KEY_LENGTH, {
    N,
    r: R,
    p: P,
    maxmem: MAX_MEMORY,
  });

  return [ALGORITHM, N, R, P, salt.toString('base64'), derived.toString('base64')].join('$');
}

/**
 * Verify a password. Always performs the full derivation, and compares in
 * constant time, so a wrong password costs the same as a right one.
 */
export async function verifyPassword(plain: string, stored: string): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== ALGORITHM) return false;

  const n = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  if (!Number.isFinite(n) || !Number.isFinite(r) || !Number.isFinite(p)) return false;

  let salt: Buffer;
  let expected: Buffer;
  try {
    salt = Buffer.from(parts[4]!, 'base64');
    expected = Buffer.from(parts[5]!, 'base64');
  } catch {
    return false;
  }

  let derived: Buffer;
  try {
    derived = await scrypt(plain.normalize('NFKC'), salt, expected.length, {
      N: n,
      r,
      p,
      maxmem: MAX_MEMORY,
    });
  } catch {
    return false;
  }

  if (derived.length !== expected.length) return false;
  return timingSafeEqual(derived, expected);
}

/** True when a stored hash used weaker parameters than the current policy. */
export function needsRehash(stored: string): boolean {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== ALGORITHM) return true;
  return Number(parts[1]) < N || Number(parts[2]) < R || Number(parts[3]) < P;
}

export interface PasswordPolicyResult {
  ok: boolean;
  problems: string[];
}

/**
 * Password policy.
 *
 * Length-first, following current NIST guidance: a 12-character minimum with no
 * forced composition rules. Character-class requirements push people towards
 * `Password1!` and are not what makes a password hard to guess.
 *
 * The blocklist catches the handful of passwords that would actually be tried
 * first against this specific system.
 */
const MIN_LENGTH = 12;
const MAX_LENGTH = 200;

const BLOCKED = [
  'password',
  'passw0rd',
  'letmein',
  'welcome',
  'qwerty',
  'admin',
  'chambers',
  'chambersofkoon',
  'koon',
  'matter',
  'mattervelocity',
  'eiaaw',
  'legal',
  'lawyer',
  'malaysia',
];

export function checkPasswordPolicy(
  password: string,
  context: { email?: string; fullName?: string } = {},
): PasswordPolicyResult {
  const problems: string[] = [];
  const value = password.normalize('NFKC');
  const lower = value.toLowerCase();

  if (value.length < MIN_LENGTH) {
    problems.push(`Use at least ${MIN_LENGTH} characters.`);
  }
  if (value.length > MAX_LENGTH) {
    problems.push(`Use at most ${MAX_LENGTH} characters.`);
  }
  if (/^\s|\s$/.test(value)) {
    problems.push('Remove the leading or trailing space.');
  }

  for (const blocked of BLOCKED) {
    if (lower.includes(blocked)) {
      problems.push('Avoid words connected to this firm or to common passwords.');
      break;
    }
  }

  // A password containing the account's own identifiers is guessable by anyone
  // who knows who the account belongs to.
  const localPart = context.email?.split('@')[0]?.toLowerCase();
  if (localPart && localPart.length >= 4 && lower.includes(localPart)) {
    problems.push('Do not use your email address in the password.');
  }
  for (const namePart of (context.fullName ?? '').toLowerCase().split(/\s+/)) {
    if (namePart.length >= 4 && lower.includes(namePart)) {
      problems.push('Do not use your name in the password.');
      break;
    }
  }

  // Long runs of one character, or a straight sequence, add length without entropy.
  if (/(.)\1{3,}/.test(value)) {
    problems.push('Avoid repeating the same character four or more times.');
  }
  if (/(?:0123|1234|2345|3456|4567|5678|6789|abcd|bcde|cdef|qwer|asdf)/i.test(value)) {
    problems.push('Avoid keyboard or number sequences.');
  }

  return { ok: problems.length === 0, problems: [...new Set(problems)] };
}

/**
 * Temporary password for a newly created account. Readable aloud over the phone
 * — no characters that are ambiguous in print (0/O, 1/l/I) — and long enough
 * that its short life is not doing the security work on its own.
 */
export function generateTemporaryPassword(): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
  const groups: string[] = [];
  for (let group = 0; group < 4; group += 1) {
    let chunk = '';
    const bytes = randomBytes(5);
    for (let i = 0; i < 5; i += 1) {
      chunk += alphabet[bytes[i]! % alphabet.length];
    }
    groups.push(chunk);
  }
  return groups.join('-');
}

import 'server-only';
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  hkdfSync,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';
import { optionalSecret, secret } from '@/lib/config/env';

/**
 * Application-layer field encryption (NFR-1.2).
 *
 * Used for client identifier columns (IC / passport number) so that a database
 * dump alone does not disclose them. Storage-level encryption already covers
 * media loss; this covers the "someone has a backup file" case.
 *
 * Format: v1.<iv-b64>.<tag-b64>.<ciphertext-b64>
 * The version prefix exists so the algorithm can be rotated without guessing
 * the layout of historic rows.
 */

const ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12;
const VERSION = 'v1';

let cachedKey: Buffer | null = null;

/**
 * Domain separation label. Changing this string invalidates every ciphertext
 * derived through the fallback path, so it is fixed for the life of the
 * deployment.
 */
const HKDF_INFO = 'matter-velocity/field-encryption/v1';

/**
 * The field-encryption key.
 *
 * Preferred: a dedicated 32-byte `FIELD_ENCRYPTION_KEY`.
 *
 * Fallback: derive one from `AUTH_SECRET` via HKDF-SHA256 with a fixed info
 * label. The shared EIAAW vault has no dedicated field key, and deriving one
 * is materially better than reusing a signing secret verbatim: HKDF with
 * domain separation means the derived key is independent of the session
 * signing key even though both come from the same input material.
 *
 * The trade-off is real and must be understood before rotating anything:
 * while the fallback is in use, rotating AUTH_SECRET changes the derived key
 * and makes existing encrypted identifiers undecryptable. Add a dedicated
 * FIELD_ENCRYPTION_KEY to the vault before the first rotation.
 */
async function key(): Promise<Buffer> {
  if (cachedKey) return cachedKey;

  const dedicated = await optionalSecret('FIELD_ENCRYPTION_KEY');
  if (dedicated) {
    const buf = Buffer.from(dedicated, 'base64');
    if (buf.length !== 32) {
      throw new Error(
        `FIELD_ENCRYPTION_KEY must decode to exactly 32 bytes (got ${buf.length}). ` +
          'Generate with: openssl rand -base64 32',
      );
    }
    cachedKey = buf;
    return cachedKey;
  }

  const master = await secret('AUTH_SECRET');
  console.warn(
    '[crypto] No dedicated FIELD_ENCRYPTION_KEY; deriving one from AUTH_SECRET via HKDF. ' +
      'Add FIELD_ENCRYPTION_KEY to the vault before rotating AUTH_SECRET.',
  );
  // Empty salt is acceptable for HKDF when the info label provides separation
  // and the input material is a high-entropy secret.
  cachedKey = Buffer.from(hkdfSync('sha256', master, Buffer.alloc(0), HKDF_INFO, 32));
  return cachedKey;
}

/** Test seam — the key is cached for the process lifetime. */
export function __resetFieldKeyForTests(): void {
  cachedKey = null;
}

export async function encryptField(plaintext: string): Promise<string> {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, await key(), iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [
    VERSION,
    iv.toString('base64'),
    tag.toString('base64'),
    ciphertext.toString('base64'),
  ].join('.');
}

export async function decryptField(payload: string): Promise<string> {
  const parts = payload.split('.');
  if (parts.length !== 4 || parts[0] !== VERSION) {
    throw new Error('Malformed encrypted field payload');
  }
  const [, ivB64, tagB64, ctB64] = parts;
  const decipher = createDecipheriv(ALGORITHM, await key(), Buffer.from(ivB64!, 'base64'));
  decipher.setAuthTag(Buffer.from(tagB64!, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(ctB64!, 'base64')), decipher.final()]).toString(
    'utf8',
  );
}

/** SHA-256 hex. Used for content hashes, device fingerprints and prompt hashes. */
export function sha256(input: string | Buffer): string {
  return createHash('sha256').update(input).digest('hex');
}

/** URL-safe random token for reschedule links and widget sessions. */
export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

/** Constant-time comparison for tokens and webhook signatures. */
export function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

/**
 * Mask a client identifier for display to a role with masking enabled
 * (pupils, PRD §2.2). Keeps enough to correlate rows without disclosing
 * identity: "Tan Yong Koon" -> "T—— Y—— K——".
 */
export function maskName(fullName: string): string {
  return fullName
    .split(/\s+/)
    .filter(Boolean)
    .map((part) => `${part.charAt(0).toUpperCase()}——`)
    .join(' ');
}

export function maskEmail(email: string): string {
  const [local, domain] = email.split('@');
  if (!local || !domain) return '——';
  return `${local.charAt(0)}***@${domain}`;
}

export function maskPhone(phone: string): string {
  const digits = phone.replace(/\D/g, '');
  if (digits.length < 4) return '***';
  return `***${digits.slice(-3)}`;
}

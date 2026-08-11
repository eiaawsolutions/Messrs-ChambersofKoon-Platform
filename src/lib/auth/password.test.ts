import { describe, expect, it } from 'vitest';
import {
  checkPasswordPolicy,
  generateTemporaryPassword,
  hashPassword,
  needsRehash,
  verifyPassword,
} from './password';

describe('hashPassword / verifyPassword', () => {
  it('verifies a correct password', async () => {
    const hash = await hashPassword('correct horse battery staple');
    expect(await verifyPassword('correct horse battery staple', hash)).toBe(true);
  }, 20_000);

  it('rejects a wrong password', async () => {
    const hash = await hashPassword('correct horse battery staple');
    expect(await verifyPassword('Correct horse battery staple', hash)).toBe(false);
  }, 20_000);

  it('salts, so the same password hashes differently every time', async () => {
    const a = await hashPassword('the same password');
    const b = await hashPassword('the same password');
    expect(a).not.toBe(b);
    expect(await verifyPassword('the same password', a)).toBe(true);
    expect(await verifyPassword('the same password', b)).toBe(true);
  }, 30_000);

  it('records its parameters in the encoded hash', async () => {
    const hash = await hashPassword('whatever it is');
    const [algorithm, n, r, p] = hash.split('$');
    expect(algorithm).toBe('scrypt');
    expect(Number(n)).toBe(2 ** 17);
    expect(Number(r)).toBe(8);
    expect(Number(p)).toBe(1);
  }, 20_000);

  it('normalises unicode, so a password typed on another keyboard still works', async () => {
    // Same string, composed vs decomposed forms.
    const composed = 'café-parapluie-2026';
    const decomposed = 'café-parapluie-2026';
    const hash = await hashPassword(composed);
    expect(await verifyPassword(decomposed, hash)).toBe(true);
  }, 20_000);

  it('returns false rather than throwing on a malformed stored hash', async () => {
    expect(await verifyPassword('x', 'not-a-hash')).toBe(false);
    expect(await verifyPassword('x', '')).toBe(false);
    expect(await verifyPassword('x', 'scrypt$a$b$c$d$e')).toBe(false);
    expect(await verifyPassword('x', 'bcrypt$1$2$3$aaaa$bbbb')).toBe(false);
  });
});

describe('needsRehash', () => {
  it('is false for a hash at current parameters', async () => {
    expect(needsRehash(await hashPassword('a password to check'))).toBe(false);
  }, 20_000);

  it('is true for weaker parameters', () => {
    expect(needsRehash('scrypt$16384$8$1$c2FsdA==$aGFzaA==')).toBe(true);
  });

  it('is true for an unknown algorithm', () => {
    expect(needsRehash('argon2id$whatever')).toBe(true);
  });
});

describe('checkPasswordPolicy', () => {
  it('accepts a long, unrelated passphrase', () => {
    expect(checkPasswordPolicy('velvet harbour ledger 88').ok).toBe(true);
  });

  it('rejects anything under twelve characters', () => {
    const result = checkPasswordPolicy('Short1!x');
    expect(result.ok).toBe(false);
    expect(result.problems.join(' ')).toMatch(/at least 12/);
  });

  it('rejects passwords containing firm-related words', () => {
    expect(checkPasswordPolicy('chambersofkoon2026').ok).toBe(false);
    expect(checkPasswordPolicy('mattervelocity99').ok).toBe(false);
    expect(checkPasswordPolicy('my-password-here').ok).toBe(false);
  });

  it('rejects a password containing the account email local part', () => {
    const result = checkPasswordPolicy('yongkoon-is-here-99', {
      email: 'yongkoon@chambersofkoon.com.my',
    });
    expect(result.ok).toBe(false);
    expect(result.problems.join(' ')).toMatch(/email address/);
  });

  it('rejects a password containing the account holder name', () => {
    const result = checkPasswordPolicy('aminah-rides-a-bike', { fullName: 'Siti Aminah' });
    expect(result.ok).toBe(false);
    expect(result.problems.join(' ')).toMatch(/your name/);
  });

  it('rejects long repeats and keyboard runs', () => {
    expect(checkPasswordPolicy('aaaabbbbccccdddd').ok).toBe(false);
    expect(checkPasswordPolicy('zzz-qwerty-tulip-3').ok).toBe(false);
    expect(checkPasswordPolicy('xk-12345678-tulip').ok).toBe(false);
  });

  it('rejects leading or trailing whitespace', () => {
    expect(checkPasswordPolicy(' velvet harbour ledger').ok).toBe(false);
    expect(checkPasswordPolicy('velvet harbour ledger ').ok).toBe(false);
  });

  it('does not require mixed character classes', () => {
    // Length beats composition rules; forcing classes produces Password1!.
    expect(checkPasswordPolicy('velvetharbourledger').ok).toBe(true);
  });

  it('reports each problem once', () => {
    const result = checkPasswordPolicy('admin');
    expect(new Set(result.problems).size).toBe(result.problems.length);
  });
});

describe('generateTemporaryPassword', () => {
  it('satisfies the policy it will be checked against', () => {
    for (let i = 0; i < 25; i += 1) {
      expect(checkPasswordPolicy(generateTemporaryPassword()).ok).toBe(true);
    }
  });

  it('omits characters that are ambiguous when read aloud', () => {
    for (let i = 0; i < 25; i += 1) {
      // No 0/O, 1/l/I confusion for a password dictated over the phone.
      expect(generateTemporaryPassword()).not.toMatch(/[0O1lI]/);
    }
  });

  it('differs every time', () => {
    const generated = new Set(Array.from({ length: 50 }, generateTemporaryPassword));
    expect(generated.size).toBe(50);
  });
});

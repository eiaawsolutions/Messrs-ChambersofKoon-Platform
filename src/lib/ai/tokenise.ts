/**
 * Client identifier tokenisation (AI-1).
 *
 * "Client identifiers (full name, IC/passport number, phone, email, address,
 *  account numbers) are tokenised before the prompt leaves the platform and
 *  re-hydrated in the rendered output. The tokenisation map is per-request and
 *  never persisted with the prompt."
 *
 * The map lives only in the closure of one `TokenVault` instance, is never
 * written to the database, and is never included in an audit row or a log
 * line. The vault is created per request and discarded when the request ends.
 *
 * Design note: substitution is exact-match over registered values, longest
 * first. It is not an NER pass — guessing at names would produce both misses
 * and false positives on legal terms. The caller registers the identifiers it
 * knows from structured matter data, which is precisely the set that must not
 * leave the platform. Free-text the client typed themselves is a separate
 * problem, handled by `scrubFreeText` below.
 */

export type TokenKind =
  'PERSON' | 'ID_NUMBER' | 'PHONE' | 'EMAIL' | 'ADDRESS' | 'ACCOUNT' | 'ORG' | 'MATTER_REF';

export interface TokenVaultStats {
  registered: number;
  substituted: number;
}

export class TokenVault {
  /** token -> original value. Never leaves this object. */
  private readonly forward = new Map<string, string>();
  /** original value -> token, for idempotent registration. */
  private readonly reverse = new Map<string, string>();
  private readonly counters = new Map<TokenKind, number>();
  private substitutions = 0;

  /**
   * Register a value and get its placeholder. Registering the same value twice
   * returns the same token, so the model sees a consistent entity.
   */
  register(kind: TokenKind, value: string | null | undefined): string {
    const trimmed = value?.trim();
    if (!trimmed) return '';

    const existing = this.reverse.get(trimmed);
    if (existing) return existing;

    const next = (this.counters.get(kind) ?? 0) + 1;
    this.counters.set(kind, next);
    const token = `[${kind}_${next}]`;

    this.forward.set(token, trimmed);
    this.reverse.set(trimmed, token);
    return token;
  }

  /**
   * Replace every registered value found in `text` with its token.
   * Longest values first, so "Tan Yong Koon" wins over "Tan".
   */
  redact(text: string): string {
    if (!text) return text;
    const values = [...this.reverse.keys()].sort((a, b) => b.length - a.length);
    let out = text;
    for (const value of values) {
      const token = this.reverse.get(value)!;
      const pattern = new RegExp(escapeRegExp(value), 'gi');
      out = out.replace(pattern, () => {
        this.substitutions += 1;
        return token;
      });
    }
    return out;
  }

  /** Put the real values back into model output before it reaches a human. */
  rehydrate(text: string): string {
    if (!text) return text;
    let out = text;
    for (const [token, value] of this.forward) {
      out = out.split(token).join(value);
    }
    return out;
  }

  /** True when any registered identifier still appears verbatim. */
  containsRawIdentifier(text: string): boolean {
    for (const value of this.reverse.keys()) {
      if (value.length < 4) continue; // too short to be a meaningful identifier
      if (text.toLowerCase().includes(value.toLowerCase())) return true;
    }
    return false;
  }

  stats(): TokenVaultStats {
    return { registered: this.forward.size, substituted: this.substitutions };
  }

  /** Explicitly drop the map. Called at the end of a request. */
  dispose(): void {
    this.forward.clear();
    this.reverse.clear();
    this.counters.clear();
  }
}

function escapeRegExp(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Structural scrub for text the platform did not generate — an enquirer's own
 * message, or OCR output. Catches the identifier shapes that are recognisable
 * without knowing the value in advance.
 *
 * This runs *in addition to* vault redaction, never instead of it. It is a net,
 * not a guarantee: free text can always contain an identifier in a form no
 * pattern matches, which is why the drafting path uses structured matter data
 * rather than raw transcripts.
 */
export function scrubFreeText(text: string): string {
  if (!text) return text;
  return (
    text
      // Malaysian NRIC: YYMMDD-PB-###G
      .replace(/\b\d{6}-\d{2}-\d{4}\b/g, '[ID_NUMBER]')
      // NRIC without separators
      .replace(/\b\d{12}\b/g, '[ID_NUMBER]')
      // Malaysian passport: A followed by 8 digits
      .replace(/\b[A-Z]\d{8}\b/g, '[PASSPORT]')
      // Email
      .replace(/\b[\w.+-]+@[\w-]+\.[\w.-]+\b/g, '[EMAIL]')
      // Malaysian mobile: +60 / 0 followed by 9-10 digits, optional separators
      .replace(/(?:\+?60|0)1\d[-\s]?\d{3,4}[-\s]?\d{4}\b/g, '[PHONE]')
      // Bank account / long digit runs (13+) not already caught
      .replace(/\b\d{13,19}\b/g, '[ACCOUNT]')
  );
}

/**
 * Build a vault pre-loaded with the identifiers on a matter bundle.
 * Returns the vault plus a redactor bound to it.
 */
export function vaultForMatter(input: {
  clientName?: string | null;
  clientEmail?: string | null;
  clientPhone?: string | null;
  clientIdNumber?: string | null;
  clientAddress?: string | null;
  matterReference?: string | null;
  counterpartyNames?: string[];
}): TokenVault {
  const vault = new TokenVault();
  vault.register('PERSON', input.clientName);
  vault.register('EMAIL', input.clientEmail);
  vault.register('PHONE', input.clientPhone);
  vault.register('ID_NUMBER', input.clientIdNumber);
  vault.register('ADDRESS', input.clientAddress);
  vault.register('MATTER_REF', input.matterReference);
  for (const name of input.counterpartyNames ?? []) {
    vault.register('ORG', name);
  }
  return vault;
}

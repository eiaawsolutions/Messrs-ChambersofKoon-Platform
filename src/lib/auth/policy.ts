/**
 * Sign-in policy decisions (FR-1.2, FR-1.3).
 *
 * Deliberately free of any next-auth or Next.js import so the rules can be
 * unit-tested directly. auth.ts wires them into the provider callbacks.
 */

/** True when the ID token carries evidence the IdP enforced a second factor. */
export function hasMfaClaim(profile: Record<string, unknown> | undefined): boolean {
  if (!profile) return false;

  // Microsoft Entra: amr contains "mfa"; also matches hardware key and OTP.
  const amr = profile.amr;
  if (Array.isArray(amr) && amr.some((m) => typeof m === 'string' && /mfa|otp|fido|hwk/i.test(m))) {
    return true;
  }

  const acr = profile.acr;
  if (typeof acr === 'string' && /mfa|aal2|aal3/i.test(acr)) return true;

  return false;
}

/**
 * FR-1.2: "Reject a session whose token lacks an MFA claim where the provider
 * supplies one; surface a setup prompt on first login otherwise."
 *
 * Entra supplies `amr`, so a missing MFA claim there is a real signal and the
 * session is rejected. Google Workspace does not emit an MFA claim at all, so
 * absence is not evidence of absence — rejecting would lock out the whole firm
 * on a signal the provider never sends. Those accounts are admitted and
 * flagged, and the dashboard shows a 2-step-verification setup prompt.
 */
export function enforceMfa(
  provider: string,
  profile: Record<string, unknown> | undefined,
): { allowed: boolean; promptSetup: boolean } {
  const providerSuppliesClaim = provider === 'microsoft-entra-id';
  const present = hasMfaClaim(profile);

  if (providerSuppliesClaim) {
    return { allowed: present, promptSetup: false };
  }
  return { allowed: true, promptSetup: !present };
}

/**
 * FR-1.3 domain allow-list.
 *
 * Uses lastIndexOf('@') so a quoted local part containing an '@' cannot smuggle
 * an allow-listed domain past the check.
 */
export function isDomainAllowed(email: string, domains: string[]): boolean {
  const at = email.lastIndexOf('@');
  if (at < 0) return false;
  const domain = email.slice(at + 1).toLowerCase();
  return domains.includes(domain);
}

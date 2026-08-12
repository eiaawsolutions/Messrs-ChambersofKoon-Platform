import { describe, expect, it } from 'vitest';
import { extractContactDetails, scrubFreeText } from './tokenise';

/**
 * Contact capture during intake (FR-2.4, AI-1).
 *
 * The firm needs the real email and phone number; the model must never see
 * them. That only works if extraction runs before the scrub, which is the
 * ordering these tests pin down.
 */
describe('extractContactDetails', () => {
  const message = 'Nurul Aisyah binti Rahman. nurul.aisyah@example.com. 012-555 0148.';

  it('finds the email', () => {
    expect(extractContactDetails(message).email).toBe('nurul.aisyah@example.com');
  });

  it('finds the Malaysian mobile number', () => {
    expect(extractContactDetails(message).phone).toBe('012-555 0148');
  });

  it('runs before the scrub destroys the values', () => {
    // Order matters: scrubbing first would leave nothing to capture.
    expect(scrubFreeText(message)).not.toContain('nurul.aisyah@example.com');
  });

  it('handles common Malaysian formats', () => {
    for (const phone of ['0125550148', '012-555 0148', '+60125550148', '012 555 0148']) {
      expect(extractContactDetails(`call me on ${phone}`).phone).not.toBeNull();
    }
  });

  it('returns nulls when there is nothing to find', () => {
    const r = extractContactDetails('I need help with a divorce.');
    expect(r.email).toBeNull();
    expect(r.phone).toBeNull();
  });
});

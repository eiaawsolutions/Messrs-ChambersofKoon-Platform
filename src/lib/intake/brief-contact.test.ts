import { describe, expect, it } from 'vitest';
import { contactPatchFromBrief } from './brief-contact';

const STORED = {
  name: 'Nurul Aisyah binti Rahman',
  email: 'nurul.aisyah@example.com',
  phone: '+60125550148',
};

/** What the model actually returns, having read a scrubbed transcript. */
const REDACTED_BRIEF = {
  contactName: 'Nurul Aisyah binti Rahman',
  contactEmail: '[EMAIL]',
  contactPhone: '[PHONE]',
};

describe('contactPatchFromBrief', () => {
  it('does not overwrite stored details with redaction placeholders', () => {
    expect(contactPatchFromBrief(STORED, REDACTED_BRIEF)).toEqual({});
  });

  it('clears a stored placeholder rather than leaving an undeliverable address', () => {
    const patch = contactPatchFromBrief(
      { name: 'Nurul Aisyah binti Rahman', email: '[EMAIL]', phone: '[PHONE]' },
      REDACTED_BRIEF,
    );
    expect(patch).toEqual({ contactEmail: null, contactPhone: null });
  });

  it('fills a blank field from the brief when the value is real', () => {
    const patch = contactPatchFromBrief(
      { name: null, email: null, phone: null },
      {
        contactName: 'Chan Wei Ling',
        contactEmail: 'Chan.WeiLing@Example.COM',
        contactPhone: '012-555 0148',
      },
    );
    expect(patch).toEqual({
      contactName: 'Chan Wei Ling',
      contactEmail: 'chan.weiling@example.com',
      contactPhone: '+60125550148',
    });
  });

  it('keeps the stored address when the brief reports a different one', () => {
    // Usually the other side's solicitor, or an ex-spouse, quoted mid-transcript.
    const patch = contactPatchFromBrief(STORED, {
      ...REDACTED_BRIEF,
      contactEmail: 'opposing.counsel@example.com',
    });
    expect(patch).toEqual({});
  });

  it('refuses a brief value that would not pass the enquiry form', () => {
    const patch = contactPatchFromBrief(
      { name: null, email: null, phone: null },
      { contactName: 'N', contactEmail: 'not-an-address', contactPhone: '12' },
    );
    expect(patch).toEqual({});
  });

  it('normalises an empty column to null exactly once', () => {
    const first = contactPatchFromBrief(
      { name: '', email: '', phone: '' },
      { contactName: '', contactEmail: '', contactPhone: '' },
    );
    expect(first).toEqual({ contactName: null, contactEmail: null, contactPhone: null });

    expect(
      contactPatchFromBrief(
        { name: null, email: null, phone: null },
        { contactName: '', contactEmail: '', contactPhone: '' },
      ),
    ).toEqual({});
  });

  it('leaves a clean enquiry untouched', () => {
    expect(
      contactPatchFromBrief(STORED, { ...REDACTED_BRIEF, contactPhone: '+60125550148' }),
    ).toEqual({});
  });

  it('rejects a vault token, not only a scrub placeholder', () => {
    const patch = contactPatchFromBrief(
      { name: null, email: null, phone: null },
      { contactName: '[PERSON_1]', contactEmail: '[EMAIL_1]', contactPhone: '[PHONE_2]' },
    );
    expect(patch).toEqual({});
  });
});

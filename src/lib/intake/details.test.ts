import { describe, expect, it } from 'vitest';
import {
  composeInitialMessage,
  formatPhone,
  normalisePhone,
  parseEnquiryDetails,
  type EnquiryDetails,
} from './details';

/**
 * The widget and the no-JavaScript form both submit through this contract, so
 * these cover the two things that decide whether an enquiry survives: a real
 * Malaysian number in any of the shapes people actually type is accepted, and
 * anything that would leave the firm unable to reach someone is refused before
 * a conversation starts.
 */

const valid = {
  contactName: 'Nurul Aisyah binti Rahman',
  contactEmail: 'nurul.aisyah@example.com',
  contactPhone: '012-555 0148',
  enquiryType: 'family_matrimonial',
};

describe('normalisePhone', () => {
  it.each([
    ['012-555 0148', '+60125550148'],
    ['0125550148', '+60125550148'],
    ['012 555 0148', '+60125550148'],
    ['+60125550148', '+60125550148'],
    ['+60 12-555 0148', '+60125550148'],
    ['60125550148', '+60125550148'],
    ['(012) 555-0148', '+60125550148'],
  ])('canonicalises %s to one stored value', (input, expected) => {
    // Three shapes of the same number must not read as three clients.
    expect(normalisePhone(input)).toBe(expected);
  });

  it('accepts a Kuala Lumpur landline', () => {
    expect(normalisePhone('03-2856 7000')).toBe('+60328567000');
  });

  it('accepts an Ipoh landline, which is a digit shorter', () => {
    expect(normalisePhone('05-255 1234')).toBe('+6052551234');
  });

  it('keeps a foreign number rather than coercing it to Malaysia', () => {
    // +65 rewritten as +60 would dial a stranger.
    expect(normalisePhone('+65 6123 4567')).toBe('+6561234567');
  });

  it.each([['x'], ['-'], ['123'], ['012-555'], ['not a number'], ['']])(
    'refuses %s, which the firm could not call',
    (input) => {
      expect(normalisePhone(input)).toBeNull();
    },
  );

  it('refuses a Malaysian number with too many digits', () => {
    expect(normalisePhone('012-5550148999')).toBeNull();
  });
});

describe('formatPhone', () => {
  it('renders a stored mobile the way the firm writes it', () => {
    expect(formatPhone('+60125550148')).toBe('012-555 0148');
  });

  it('renders a stored landline with its one-digit area code', () => {
    // 032-856 7000 reads as a typo to every Malaysian who sees it.
    expect(formatPhone('+60328567000')).toBe('03-2856 7000');
  });

  it('renders a shorter state landline', () => {
    expect(formatPhone('+6052551234')).toBe('05-255 1234');
  });

  it('renders a ten-digit mobile', () => {
    expect(formatPhone('+601123456789')).toBe('011-2345 6789');
  });

  it('leaves a foreign number alone rather than guessing its grouping', () => {
    expect(formatPhone('+6561234567')).toBe('+6561234567');
  });
});

describe('parseEnquiryDetails', () => {
  it('accepts the four required answers and normalises them', () => {
    const result = parseEnquiryDetails(valid);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.details).toEqual({
      contactName: 'Nurul Aisyah binti Rahman',
      contactEmail: 'nurul.aisyah@example.com',
      contactPhone: '+60125550148',
      enquiryType: 'family_matrimonial',
    });
  });

  it('lower-cases the email so one person is one client', () => {
    const result = parseEnquiryDetails({ ...valid, contactEmail: '  Nurul.Aisyah@Example.COM ' });
    expect(result.ok && result.details.contactEmail).toBe('nurul.aisyah@example.com');
  });

  it('collapses runs of whitespace in a pasted name', () => {
    const result = parseEnquiryDetails({ ...valid, contactName: '  Chan   Wei  Ling ' });
    expect(result.ok && result.details.contactName).toBe('Chan Wei Ling');
  });

  it('keeps the optional message when one was written', () => {
    const result = parseEnquiryDetails({ ...valid, message: '  I need help with a divorce.  ' });
    expect(result.ok && result.details.message).toBe('I need help with a divorce.');
  });

  it('omits the message entirely when the box was left blank', () => {
    const result = parseEnquiryDetails({ ...valid, message: '   ' });
    expect(result.ok).toBe(true);
    expect(result.ok && 'message' in result.details).toBe(false);
  });

  it('accepts a two-letter surname', () => {
    // "Ng" is a real name and refusing it would be the kind of validation bug
    // that only shows up in the wrong country.
    expect(parseEnquiryDetails({ ...valid, contactName: 'Ng' }).ok).toBe(true);
  });

  it.each([
    ['contactName', '', 'name_required'],
    ['contactName', 'A', 'name_too_short'],
    ['contactEmail', '', 'email_required'],
    ['contactEmail', 'nurul.aisyah.example.com', 'email_invalid'],
    ['contactPhone', '', 'phone_required'],
    ['contactPhone', 'x', 'phone_invalid'],
    ['enquiryType', '', 'type_required'],
    ['enquiryType', 'immigration', 'type_unknown'],
  ])('rejects %s = "%s" with code %s', (field, value, expected) => {
    const result = parseEnquiryDetails({ ...valid, [field]: value });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors[field as keyof typeof result.errors]).toBe(expected);
  });

  it('reports a missing field as required rather than leaking zod wording', () => {
    const { contactPhone, ...withoutPhone } = valid;
    void contactPhone;
    const result = parseEnquiryDetails(withoutPhone);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.contactPhone).toBe('phone_required');
  });

  it('reports every bad field at once, so the form is corrected in one pass', () => {
    const result = parseEnquiryDetails({
      contactName: '',
      contactEmail: 'nope',
      contactPhone: 'x',
      enquiryType: '',
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(Object.keys(result.errors).sort()).toEqual([
      'contactEmail',
      'contactName',
      'contactPhone',
      'enquiryType',
    ]);
  });

  it('reports one code per field rather than stacking them', () => {
    const result = parseEnquiryDetails({ ...valid, contactName: '' });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.contactName).toBe('name_required');
  });

  it('refuses a message past the column budget', () => {
    const result = parseEnquiryDetails({ ...valid, message: 'a'.repeat(4001) });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.message).toBe('message_too_long');
  });

  it('refuses a non-object payload without throwing', () => {
    expect(parseEnquiryDetails(null).ok).toBe(false);
    expect(parseEnquiryDetails('nurul').ok).toBe(false);
  });
});

describe('composeInitialMessage', () => {
  const base: EnquiryDetails = {
    contactName: 'Nurul Aisyah binti Rahman',
    contactEmail: 'nurul.aisyah@example.com',
    contactPhone: '+60125550148',
    enquiryType: 'family_matrimonial',
  };

  it("states the type in the firm's own public wording", () => {
    // Never "family_matrimonial" — the person picked "Family and Matrimonial"
    // and the brief should not translate their choice into an internal name.
    expect(composeInitialMessage(base)).toContain('Family and Matrimonial');
  });

  it('carries the message through when one was written', () => {
    const composed = composeInitialMessage({ ...base, message: 'We have agreed to separate.' });
    expect(composed).toContain('We have agreed to separate.');
    expect(composed).toContain('Family and Matrimonial');
  });

  it('still gives triage something to classify when no message was written', () => {
    expect(composeInitialMessage(base).length).toBeGreaterThan(0);
  });

  it('names debt recovery the way the firm advertises it', () => {
    // The firm sells debt recovery under Corporate & Commercial. Saying "debt
    // recovery" would name a category the enquirer never saw on the website.
    const composed = composeInitialMessage({ ...base, enquiryType: 'corporate_commercial' });
    expect(composed).toContain('Corporate & Commercial');
  });
});

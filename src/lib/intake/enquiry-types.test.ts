import { describe, expect, it } from 'vitest';
import {
  ENQUIRY_TYPES,
  enquiryTypeById,
  enquiryTypeLabelFor,
  isMismatched,
  practiceAreaForEnquiryType,
} from './enquiry-types';

/**
 * Four public enquiry types over five internal practice areas. The seams are
 * where enquiries would be misrouted, so each one is pinned here.
 */

describe('the firm’s enquiry types', () => {
  it('offers exactly the four the firm advertises', () => {
    expect(ENQUIRY_TYPES.map((t) => t.label)).toEqual([
      'Family and Matrimonial',
      'Corporate & Commercial',
      'Dispute Resolution',
      'Property & Land',
    ]);
  });

  it('routes each type somewhere a lawyer can actually be scheduled', () => {
    for (const type of ENQUIRY_TYPES) {
      // 'general' has no availability rule or template scoped to it, so no
      // type may default there.
      expect(type.defaultPracticeArea, type.label).not.toBe('general');
      expect(type.resolvesTo, type.label).toContain(type.defaultPracticeArea);
    }
  });

  it('lets a debt claim in through Corporate & Commercial, where the firm advertises it', () => {
    // The firm's own wording: "construction law, conveyancing, business
    // disputes, contracts, debt recovery, and company law". Reading the labels
    // alone would send this to Dispute Resolution and the wrong team.
    const corporate = enquiryTypeById('corporate_commercial');
    expect(corporate?.resolvesTo).toContain('debt_recovery');
  });

  it('lets conveyancing in through Corporate & Commercial too', () => {
    expect(enquiryTypeById('corporate_commercial')?.resolvesTo).toContain('land_property');
  });

  it('speaks of debt recovery as Corporate & Commercial, the heading the client read', () => {
    expect(enquiryTypeLabelFor('debt_recovery')).toBe('Corporate & Commercial');
  });

  it('does not default Dispute Resolution to debt recovery', () => {
    // Dispute Resolution is "contract breaches, insurance, corporate
    // conflicts, and damage claims" — a debt claim can arrive here, but it is
    // not the expected case.
    expect(practiceAreaForEnquiryType('dispute_resolution')).toBe('corporate_disputes');
  });

  it('maps the two straightforward types one to one', () => {
    expect(practiceAreaForEnquiryType('family_matrimonial')).toBe('family_matrimonial');
    expect(practiceAreaForEnquiryType('property_land')).toBe('land_property');
  });

  it('quotes the firm’s own description against every type', () => {
    for (const type of ENQUIRY_TYPES) {
      expect(type.blurb.length, type.label).toBeGreaterThan(20);
    }
  });

  it('returns nothing for an unknown or absent selection', () => {
    expect(practiceAreaForEnquiryType(null)).toBeNull();
    expect(practiceAreaForEnquiryType('conveyancing')).toBeNull();
    expect(enquiryTypeById(undefined)).toBeNull();
  });
});

describe('isMismatched', () => {
  it('accepts a dispute filed as a shareholder matter', () => {
    // Dispute Resolution legitimately covers several practice areas.
    expect(isMismatched('dispute_resolution', 'corporate_disputes')).toBe(false);
    expect(isMismatched('dispute_resolution', 'land_property')).toBe(false);
  });

  it('accepts an unpaid invoice raised under Corporate & Commercial', () => {
    // The single most likely real enquiry. It must not be flagged as a
    // routing error, or every debt claim arrives with a warning on it.
    expect(isMismatched('corporate_commercial', 'debt_recovery')).toBe(false);
  });

  it('flags a family selection filed as a land matter', () => {
    expect(isMismatched('family_matrimonial', 'land_property')).toBe(true);
  });

  it('flags a property selection filed as a debt claim', () => {
    expect(isMismatched('property_land', 'debt_recovery')).toBe(true);
  });

  it('stays quiet when there is nothing to compare', () => {
    expect(isMismatched(null, 'debt_recovery')).toBe(false);
    expect(isMismatched('family_matrimonial', null)).toBe(false);
  });
});

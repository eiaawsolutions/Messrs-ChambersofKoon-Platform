import { describe, expect, it } from 'vitest';
import { caseBriefSchema, clauseDraftSchema, classificationSchema } from './schemas';

/**
 * Live intake discarded a complete brief because `facts` arrived as prose and
 * `openQuestions` was absent. These pin the tolerance that fixed it, and pin
 * the strictness that must not be loosened with it.
 */

const validBrief = {
  contactName: 'Nurul Aisyah binti Rahman',
  contactEmail: 'nurul@example.com',
  contactPhone: '012-555 0148',
  practiceArea: 'family_matrimonial',
  urgency: 'normal',
  confidence: 92,
  summary: 'Mutual divorce, two children, agreed division.',
  facts: ['Married 2017', 'Two children aged 7 and 4'],
  openQuestions: ['Has the husband moved out?'],
  suggestedNextStep: 'First consultation with the family law lead',
  safetyConcern: false,
  complete: true,
};

describe('caseBriefSchema — tolerance for shape', () => {
  it('accepts the well-formed shape unchanged', () => {
    const parsed = caseBriefSchema.parse(validBrief);
    expect(parsed.facts).toEqual(['Married 2017', 'Two children aged 7 and 4']);
  });

  it('accepts facts delivered as a single prose string', () => {
    const parsed = caseBriefSchema.parse({ ...validBrief, facts: 'Married in 2017.' });
    expect(parsed.facts).toEqual(['Married in 2017.']);
  });

  it('splits a bulleted list delivered as one string', () => {
    const parsed = caseBriefSchema.parse({
      ...validBrief,
      facts: '- Married 2017\n- Two children\n- Puchong apartment',
    });
    expect(parsed.facts).toEqual(['Married 2017', 'Two children', 'Puchong apartment']);
  });

  it('splits a numbered list too', () => {
    const parsed = caseBriefSchema.parse({
      ...validBrief,
      openQuestions: '1. Has he moved out?\n2. Is maintenance agreed?',
    });
    expect(parsed.openQuestions).toEqual(['Has he moved out?', 'Is maintenance agreed?']);
  });

  it('treats an omitted list as empty rather than failing', () => {
    const { openQuestions, ...withoutQuestions } = validBrief;
    void openQuestions;
    expect(caseBriefSchema.parse(withoutQuestions).openQuestions).toEqual([]);
  });

  it('treats an empty string as an empty list', () => {
    expect(caseBriefSchema.parse({ ...validBrief, facts: '   ' }).facts).toEqual([]);
  });

  it('still rejects a brief with no summary', () => {
    expect(() => caseBriefSchema.parse({ ...validBrief, summary: '' })).toThrow();
  });
});

describe('caseBriefSchema — strictness that must not be loosened', () => {
  it('rejects an unknown practice area', () => {
    // Routing depends on this; a wrong value must reach a human, not a lawyer's diary.
    expect(() => caseBriefSchema.parse({ ...validBrief, practiceArea: 'shipping' })).toThrow();
  });

  it('rejects an unknown urgency', () => {
    expect(() => caseBriefSchema.parse({ ...validBrief, urgency: 'whenever' })).toThrow();
  });

  it('rejects a confidence outside 0-100', () => {
    expect(() => caseBriefSchema.parse({ ...validBrief, confidence: 140 })).toThrow();
    expect(() => caseBriefSchema.parse({ ...validBrief, confidence: -1 })).toThrow();
  });

  it('rejects a missing confidence, so a low score cannot be assumed high', () => {
    const { confidence, ...withoutConfidence } = validBrief;
    void confidence;
    expect(() => caseBriefSchema.parse(withoutConfidence)).toThrow();
  });
});

describe('clauseDraftSchema', () => {
  it('tolerates reporting lists arriving as prose', () => {
    const parsed = clauseDraftSchema.parse({
      text: 'The Petitioner and the Respondent were married on…',
      missingFacts: 'Date of separation',
      citedSources: [],
    });
    expect(parsed.missingFacts).toEqual(['Date of separation']);
  });

  it('still rejects a draft with no clause text (AI-3)', () => {
    expect(() =>
      clauseDraftSchema.parse({ text: '', missingFacts: [], citedSources: [] }),
    ).toThrow();
  });
});

describe('classificationSchema stays strict', () => {
  it('rejects an out-of-range confidence', () => {
    expect(() =>
      classificationSchema.parse({
        practiceArea: 'general',
        urgency: 'normal',
        confidence: 1000,
        reasoning: 'x',
      }),
    ).toThrow();
  });
});

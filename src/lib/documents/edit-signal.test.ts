import { describe, expect, it } from 'vitest';
import { detectEditedBlocks, similarity } from './edit-signal';

const GROUNDS =
  'The marriage has irretrievably broken down by reason of the Respondent having behaved in such a way that the Petitioner cannot reasonably be expected to live with the Respondent.';

const REWRITTEN =
  'The marriage has irretrievably broken down. The Respondent has behaved in such a way that the Petitioner cannot reasonably be expected to continue living with him.';

describe('similarity', () => {
  it('scores identical text at 1', () => {
    expect(similarity(GROUNDS, GROUNDS)).toBe(1);
  });

  it('scores unrelated text at 0', () => {
    expect(similarity('letter of demand for unpaid invoices', GROUNDS)).toBe(0);
  });

  it('scores a rewrite of the same clause well above an unrelated one', () => {
    const rewrite = similarity(GROUNDS, REWRITTEN);
    const unrelated = similarity(GROUNDS, 'The Plaintiff claims the sum of RM 248,500.');
    expect(rewrite).toBeGreaterThan(0.5);
    expect(rewrite).toBeGreaterThan(unrelated);
  });

  it('ignores case and punctuation', () => {
    expect(similarity('Filed at the High Court', 'filed at the high court!!')).toBe(1);
  });

  it('does not call a reordering of the same words identical', () => {
    // Unigram overlap would score this 1. Word order is most of the difference
    // between two drafts of the same clause, so bigrams are used.
    expect(similarity('the petitioner seeks custody', 'custody seeks petitioner the')).toBeLessThan(
      0.5,
    );
  });

  it('handles empty input without dividing by zero', () => {
    expect(similarity('', GROUNDS)).toBe(0);
    expect(similarity('', '')).toBe(0);
  });
});

describe('detectEditedBlocks (FR-4.8)', () => {
  it('records nothing when the model text survives verbatim', () => {
    expect(
      detectEditedBlocks({
        aiBlocks: { 'ai:grounds': GROUNDS },
        revisedParagraphs: [
          'IN THE HIGH COURT OF MALAYA',
          GROUNDS,
          'Dated this 13th day of August.',
        ],
      }),
    ).toEqual([]);
  });

  it('pairs a rewritten block with what replaced it', () => {
    const signals = detectEditedBlocks({
      aiBlocks: { 'ai:grounds': GROUNDS },
      revisedParagraphs: ['IN THE HIGH COURT OF MALAYA', REWRITTEN],
    });

    expect(signals).toHaveLength(1);
    expect(signals[0]!.blockName).toBe('ai:grounds');
    expect(signals[0]!.aiText).toBe(GROUNDS);
    expect(signals[0]!.editedText).toBe(REWRITTEN);
  });

  it('reports an empty replacement when the block was cut entirely', () => {
    // Not a failure: nothing derived from the model's wording remains, which
    // is the strongest thing this can say about a block.
    const signals = detectEditedBlocks({
      aiBlocks: { 'ai:grounds': GROUNDS },
      revisedParagraphs: ['IN THE HIGH COURT OF MALAYA', 'The parties have agreed terms.'],
    });

    expect(signals).toHaveLength(1);
    expect(signals[0]!.editedText).toBe('');
  });

  it('does not blame a long paragraph that merely shares the vocabulary', () => {
    // A recital running several times the length of the block. It is built
    // from the same words, so overlap alone would name it the replacement —
    // the length ratio is what stops a whole schedule being recorded as one
    // partner's preferred wording for a single clause.
    const recital = `${REWRITTEN} ${REWRITTEN} ${REWRITTEN} ${REWRITTEN}`;

    const signals = detectEditedBlocks({
      aiBlocks: { 'ai:grounds': GROUNDS },
      revisedParagraphs: [recital],
    });

    expect(signals).toHaveLength(1);
    expect(signals[0]!.editedText).toBe('');
  });

  it('reports each edited block separately and leaves untouched ones out', () => {
    const signals = detectEditedBlocks({
      aiBlocks: { 'ai:grounds': GROUNDS, 'ai:prayer': 'The Petitioner prays for a decree nisi.' },
      revisedParagraphs: [REWRITTEN, 'The Petitioner prays for a decree nisi.'],
    });

    expect(signals.map((s) => s.blockName)).toEqual(['ai:grounds']);
  });

  it('skips blocks the model left empty', () => {
    expect(
      detectEditedBlocks({
        aiBlocks: { 'ai:grounds': '   ', 'ai:prayer': '' },
        revisedParagraphs: ['Anything at all.'],
      }),
    ).toEqual([]);
  });

  it('treats a Windows line ending as the same text', () => {
    const block = 'First line.\nSecond line.';
    expect(
      detectEditedBlocks({
        aiBlocks: { 'ai:grounds': block },
        revisedParagraphs: ['First line.\r\nSecond line.'],
      }),
    ).toEqual([]);
  });

  it('returns nothing when the revision has no readable paragraphs', () => {
    const signals = detectEditedBlocks({
      aiBlocks: { 'ai:grounds': GROUNDS },
      revisedParagraphs: [],
    });
    expect(signals).toHaveLength(1);
    expect(signals[0]!.editedText).toBe('');
  });
});

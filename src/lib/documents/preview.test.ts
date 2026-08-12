import { describe, expect, it } from 'vitest';
import { buildStarterDocx, STARTER_TEMPLATES } from './starter-templates';
import { assembleDocx, parseTemplate } from './template';
import { aiShare, buildDraftPreview, type DraftPreview } from './preview';

/**
 * These tests run the real pipeline — starter template → assembleDocx → preview
 * — rather than a hand-built XML fixture, because the thing most likely to
 * break the colour coding is a change in how docxtemplater writes the rendered
 * text, not a change in this module. A fixture would keep passing while the
 * screen quietly went all-blue.
 */

const PETITION = STARTER_TEMPLATES[0]!;

function renderPetition(
  aiText: Record<string, string>,
  options: { omit?: string[] } = {},
): { preview: DraftPreview; aiBlocks: Record<string, string> } {
  const templateBuffer = buildStarterDocx(PETITION);
  const { schema } = parseTemplate(templateBuffer);

  const deterministic = Object.fromEntries(
    schema.deterministic
      .filter((field) => !options.omit?.includes(field.name))
      .map((field) => [field.name, `«${field.name}»`]),
  );

  const aiBlocks = Object.fromEntries(
    schema.ai.map((block) => [block.name, aiText[block.name] ?? `Drafted ${block.label}.`]),
  );

  const assembled = assembleDocx({ templateBuffer, deterministic, aiBlocks });
  return { preview: buildDraftPreview({ docxBuffer: assembled.buffer, aiBlocks }), aiBlocks };
}

function textOf(preview: DraftPreview, kind: 'template' | 'ai' | 'missing'): string {
  return preview.paragraphs
    .flatMap((p) => p.segments)
    .filter((s) => s.kind === kind)
    .map((s) => s.text)
    .join('\n');
}

describe('draft preview', () => {
  it('attributes every stored AI block to the model', () => {
    const { preview, aiBlocks } = renderPetition({
      'ai:groundsOfPetition': 'The marriage has irretrievably broken down.',
      'ai:prayer': 'The Petitioners pray that the marriage be dissolved.',
    });

    expect(preview.readable).toBe(true);

    const ai = textOf(preview, 'ai');
    expect(ai).toContain('The marriage has irretrievably broken down.');
    expect(ai).toContain('The Petitioners pray that the marriage be dissolved.');

    // Every block the version recorded is accounted for in the document.
    expect(preview.blocks).toHaveLength(Object.keys(aiBlocks).length);
    expect(preview.blocks.every((b) => b.matched)).toBe(true);
  });

  it('never attributes template wording or matter data to the model', () => {
    const { preview } = renderPetition({});

    const template = textOf(preview, 'template');
    // Fixed wording from the firm's precedent.
    expect(template).toContain('JOINT PETITION pursuant to Section 52');
    expect(template).toContain('PRAYER');
    // A deterministic value filled from matter data (FR-4.2).
    expect(template).toContain('«clientName»');

    const ai = textOf(preview, 'ai');
    expect(ai).not.toContain('JOINT PETITION');
    expect(ai).not.toContain('«clientName»');
  });

  it('marks unfilled deterministic fields as gaps, not as drafted text', () => {
    const { preview } = renderPetition({}, { omit: ['clientName'] });

    expect(preview.missingMarkers.join(' ')).toContain('[TO CONFIRM: Client Name]');

    const missing = textOf(preview, 'missing');
    expect(missing).toContain('[TO CONFIRM: Client Name]');
    // AT-09: the gap is a gap. It is not template text and it is not AI text.
    expect(textOf(preview, 'ai')).not.toContain('TO CONFIRM');
  });

  it('keeps multi-line drafted text in one attributed run', () => {
    const drafted = 'First ground.\nSecond ground.\nThird ground.';
    const { preview } = renderPetition({ 'ai:groundsOfPetition': drafted });

    const segment = preview.paragraphs
      .flatMap((p) => p.segments)
      .find((s) => s.blockName === 'ai:groundsOfPetition');

    // Word writes the newlines as <w:br/>; the block must still read back whole.
    expect(segment?.text).toBe(drafted);
  });

  it('reports a block whose text is no longer in the document', () => {
    const templateBuffer = buildStarterDocx(PETITION);
    const { schema } = parseTemplate(templateBuffer);
    const aiBlocks = Object.fromEntries(schema.ai.map((b) => [b.name, `Drafted ${b.label}.`]));

    const assembled = assembleDocx({
      templateBuffer,
      deterministic: {},
      aiBlocks,
    });

    // The lawyer rewrote one block in Word before re-uploading.
    const edited = { ...aiBlocks, 'ai:prayer': 'Text that was replaced in Word.' };
    const preview = buildDraftPreview({ docxBuffer: assembled.buffer, aiBlocks: edited });

    const prayer = preview.blocks.find((b) => b.name === 'ai:prayer');
    expect(prayer?.matched).toBe(false);
    // The rest of the highlighting is still trustworthy.
    expect(preview.blocks.filter((b) => b.name !== 'ai:prayer').every((b) => b.matched)).toBe(true);
  });

  it('attributes identical drafted text to a block rather than dropping one', () => {
    const same = 'Identical drafted wording.';
    const { preview } = renderPetition({
      'ai:groundsOfPetition': same,
      'ai:childArrangements': same,
    });

    // Both names are recorded against the text that is genuinely in the file.
    for (const name of ['ai:groundsOfPetition', 'ai:childArrangements']) {
      expect(preview.blocks.find((b) => b.name === name)?.matched).toBe(true);
    }
  });

  it('treats a version with no stored blocks as entirely unattributed', () => {
    // A lawyer's own revision stores no AI blocks — revise.ts records none.
    const templateBuffer = buildStarterDocx(PETITION);
    const assembled = assembleDocx({
      templateBuffer,
      deterministic: { clientName: 'Tan Mei Ling' },
      aiBlocks: { 'ai:groundsOfPetition': 'Drafted grounds.' },
    });

    const preview = buildDraftPreview({ docxBuffer: assembled.buffer, aiBlocks: {} });

    expect(preview.blocks).toHaveLength(0);
    expect(preview.aiChars).toBe(0);
    expect(aiShare(preview)).toBe(0);
    // Nothing is claimed as model-written, including text that in fact was.
    expect(textOf(preview, 'ai')).toBe('');
    expect(textOf(preview, 'template')).toContain('Drafted grounds.');
  });

  it('preserves the document’s heading structure and centring', () => {
    const { preview } = renderPetition({});

    const centred = preview.paragraphs.filter((p) => p.align === 'center');
    expect(centred.length).toBeGreaterThan(0);
    expect(centred.some((p) => p.segments.some((s) => s.text.includes('BAHAGIAN KELUARGA')))).toBe(
      true,
    );

    const headings = preview.paragraphs.filter((p) => p.strong);
    expect(headings.some((p) => p.segments.some((s) => s.text.includes('PRAYER')))).toBe(true);
  });

  it('escapes nothing and invents nothing — text round-trips through XML', () => {
    const tricky = 'Costs of RM5,000 & "expenses" <including> disbursements — see §7.';
    const { preview } = renderPetition({ 'ai:groundsOfPetition': tricky });

    const segment = preview.paragraphs
      .flatMap((p) => p.segments)
      .find((s) => s.blockName === 'ai:groundsOfPetition');

    expect(segment?.text).toBe(tricky);
  });

  it('reports an unreadable stored file instead of throwing', () => {
    const preview = buildDraftPreview({
      docxBuffer: Buffer.from('not a docx'),
      aiBlocks: { 'ai:prayer': 'Drafted prayer.' },
    });

    expect(preview.readable).toBe(false);
    expect(preview.paragraphs).toEqual([]);
    expect(preview.blocks[0]?.matched).toBe(false);
  });

  it('classifies past the render cap so a late block is not called missing', () => {
    // An exhibit list runs long. The preview stops rendering, but a block that
    // only appears near the end must not be reported as edited away.
    const long = {
      ...PETITION,
      body: [
        ...Array.from({ length: 1600 }, (_, i) => ({ text: `Exhibit ${i + 1}.` })),
        { text: '{ai:prayer}' },
      ],
    };

    const templateBuffer = buildStarterDocx(long);
    const aiBlocks = { 'ai:prayer': 'The Petitioners pray accordingly.' };
    const assembled = assembleDocx({ templateBuffer, deterministic: {}, aiBlocks });
    const preview = buildDraftPreview({ docxBuffer: assembled.buffer, aiBlocks });

    expect(preview.truncated).toBe(true);
    expect(preview.paragraphs.length).toBeLessThan(1601);
    expect(preview.blocks[0]?.matched).toBe(true);
    expect(preview.aiChars).toBe(aiBlocks['ai:prayer'].length);
  });

  it('computes the model’s share of the document', () => {
    const { preview } = renderPetition({});

    expect(preview.aiChars).toBeGreaterThan(0);
    expect(preview.templateChars).toBeGreaterThan(0);

    const share = aiShare(preview);
    expect(share).toBeGreaterThan(0);
    expect(share).toBeLessThan(100);
  });
});

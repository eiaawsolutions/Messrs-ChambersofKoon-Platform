import { describe, expect, it } from 'vitest';
import PizZip from 'pizzip';
import {
  appendCitedExcerpt,
  citationLine,
  InsertRejected,
  INSERT_ERRORS,
  type ExcerptCitation,
} from './insert-excerpt';
import { buildStarterDocx, STARTER_TEMPLATES } from './starter-templates';

/**
 * The insertion edits OOXML by hand, so the risk is not that it fails loudly —
 * it is that it produces a .docx Word refuses to open, which a lawyer would
 * only discover with the document already sent. These assertions cover the
 * structural rules that make the difference.
 */

const citation: ExcerptCitation = {
  source: 'PJ-2024-0181 Statement of Claim.pdf',
  locator: 'p. 4',
  matterReference: 'PJ/DR/2024/0181',
  practiceArea: 'debt_recovery',
  ref: '3f9a2c1e',
  insertedBy: 'Chan Wei Ling',
  insertedOn: '12 August 2026',
  masked: false,
};

function documentXml(docx: Buffer): string {
  return new PizZip(docx).file('word/document.xml')!.asText();
}

/** A minimal document with a body-level sectPr, as Word always writes. */
function minimalDocx(body: string): Buffer {
  const zip = new PizZip();
  zip.file(
    '[Content_Types].xml',
    '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>',
  );
  zip
    .folder('word')
    ?.file(
      'document.xml',
      '<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
        `<w:body>${body}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/></w:sectPr></w:body></w:document>`,
    );
  return zip.generate({ type: 'nodebuffer' }) as Buffer;
}

describe('appendCitedExcerpt', () => {
  it('places the excerpt before the body-level sectPr, which Word requires last', () => {
    const xml = documentXml(
      appendCitedExcerpt(minimalDocx('<w:p><w:r><w:t>Existing</w:t></w:r></w:p>'), {
        excerpt: 'The defendant admitted receipt of the goods.',
        citation,
      }),
    );

    const excerptAt = xml.indexOf('The defendant admitted receipt');
    const sectPrAt = xml.indexOf('<w:sectPr');

    expect(excerptAt).toBeGreaterThan(-1);
    expect(excerptAt).toBeLessThan(sectPrAt);
    expect(xml.indexOf('Existing')).toBeLessThan(excerptAt);
  });

  it('leaves the original body untouched', () => {
    const before = documentXml(minimalDocx('<w:p><w:r><w:t>Clause one</w:t></w:r></w:p>'));
    const after = documentXml(
      appendCitedExcerpt(minimalDocx('<w:p><w:r><w:t>Clause one</w:t></w:r></w:p>'), {
        excerpt: 'Excerpt',
        citation,
      }),
    );

    // Everything that was there is still there, in order, ahead of the addition.
    expect(after.startsWith(before.slice(0, before.indexOf('<w:sectPr')))).toBe(true);
  });

  it('does not split a section break nested inside a paragraph', () => {
    // A mid-document section break. Inserting before *this* sectPr would put
    // paragraphs inside a <w:pPr> and corrupt the file.
    const nested = '<w:p><w:pPr><w:sectPr><w:type w:val="nextPage"/></w:sectPr></w:pPr></w:p>';
    const xml = documentXml(
      appendCitedExcerpt(minimalDocx(`${nested}<w:p><w:r><w:t>After break</w:t></w:r></w:p>`), {
        excerpt: 'Excerpt',
        citation,
      }),
    );

    expect(xml.indexOf('Excerpt')).toBeGreaterThan(xml.indexOf('After break'));
    // The nested break is still whole.
    expect(xml).toContain(nested);
  });

  it('still inserts when the document has no sectPr at all', () => {
    const zip = new PizZip();
    zip
      .folder('word')
      ?.file(
        'document.xml',
        '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
          '<w:body><w:p><w:r><w:t>Only</w:t></w:r></w:p></w:body></w:document>',
      );

    const xml = documentXml(
      appendCitedExcerpt(zip.generate({ type: 'nodebuffer' }) as Buffer, {
        excerpt: 'Excerpt',
        citation,
      }),
    );

    expect(xml.indexOf('Excerpt')).toBeGreaterThan(xml.indexOf('Only'));
    expect(xml.indexOf('Excerpt')).toBeLessThan(xml.indexOf('</w:body>'));
  });

  it('escapes markup in the excerpt rather than emitting it', () => {
    const xml = documentXml(
      appendCitedExcerpt(minimalDocx(''), {
        excerpt: 'Clause 5 <b>& "the Purchaser" shall</b> indemnify',
        citation,
      }),
    );

    expect(xml).toContain('&lt;b&gt;');
    expect(xml).toContain('&amp;');
    expect(xml).toContain('&quot;the Purchaser&quot;');
    // The closing tag of our own run must still be intact and unescaped.
    expect(xml).toContain('</w:t>');
  });

  it('strips control characters OCR leaves behind', () => {
    const xml = documentXml(
      appendCitedExcerpt(minimalDocx(''), {
        excerpt: 'Sum of RM\u0007248,500 outstanding\u0000',
        citation,
      }),
    );

    expect(xml).toContain('RM248,500 outstanding');
    expect(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/.test(xml)).toBe(false);
  });

  it('writes each line of a multi-line excerpt as its own paragraph', () => {
    const xml = documentXml(
      appendCitedExcerpt(minimalDocx(''), {
        excerpt: 'First paragraph.\n\nSecond paragraph.\nThird.',
        citation,
      }),
    );

    for (const line of ['First paragraph.', 'Second paragraph.', 'Third.']) {
      expect(xml).toContain(line);
    }
    // Heading + 3 excerpt lines + citation, and nothing for the blank line.
    expect(xml.match(/<w:p>/g)?.length).toBe(5);
  });

  it('carries the citation into the document itself', () => {
    const xml = documentXml(appendCitedExcerpt(minimalDocx(''), { excerpt: 'Excerpt', citation }));

    expect(xml).toContain('PJ-2024-0181 Statement of Claim.pdf');
    expect(xml).toContain('p. 4');
    expect(xml).toContain('PJ/DR/2024/0181');
    expect(xml).toContain('Chan Wei Ling');
    expect(xml).toContain('3f9a2c1e');
  });

  it('labels the excerpt as research rather than drafted text', () => {
    const xml = documentXml(appendCitedExcerpt(minimalDocx(''), { excerpt: 'X', citation }));
    expect(xml).toContain('PRECEDENT EXCERPT');
  });

  it('produces a docx that reopens as a zip with its other parts intact', () => {
    const original = buildStarterDocx(STARTER_TEMPLATES[0]!);
    const amended = appendCitedExcerpt(original, { excerpt: 'Excerpt', citation });
    const zip = new PizZip(amended);

    expect(zip.file('word/document.xml')).toBeTruthy();
    expect(zip.file('[Content_Types].xml')).toBeTruthy();
    expect(zip.file('_rels/.rels')).toBeTruthy();
    // Placeholders in the template survive — insertion is not a re-render.
    expect(zip.file('word/document.xml')!.asText()).toContain('{ai:groundsOfPetition}');
  });

  it('rejects bytes that are not a Word document', () => {
    expect(() =>
      appendCitedExcerpt(Buffer.from('not a zip'), { excerpt: 'X', citation }),
    ).toThrowError(InsertRejected);

    const notWord = new PizZip();
    notWord.file('photo.jpg', 'binary');
    expect(() =>
      appendCitedExcerpt(notWord.generate({ type: 'nodebuffer' }) as Buffer, {
        excerpt: 'X',
        citation,
      }),
    ).toThrowError(InsertRejected);
  });

  it('gives every rejection code a message for the page to render', () => {
    for (const [code, message] of Object.entries(INSERT_ERRORS)) {
      expect(message.length, code).toBeGreaterThan(0);
    }
  });
});

describe('citationLine', () => {
  it('omits parts the source does not have rather than printing empties', () => {
    const line = citationLine({
      ...citation,
      locator: null,
      matterReference: null,
      practiceArea: null,
    });

    expect(line).toBe(
      'Source: PJ-2024-0181 Statement of Claim.pdf · inserted by Chan Wei Ling on 12 August 2026 · ref 3f9a2c1e',
    );
    expect(line).not.toContain('··');
  });

  it('says so when the excerpt was masked for the reader', () => {
    expect(citationLine({ ...citation, masked: true })).toContain('identifiers masked');
    expect(citationLine(citation)).not.toContain('identifiers masked');
  });
});

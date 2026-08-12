import 'server-only';
import PizZip from 'pizzip';
import type { PracticeArea } from '@/lib/db/schema';

/**
 * Starter document templates.
 *
 * These are scaffolding, not precedent. Each one carries the correct heading
 * structure, the parties and recitals a document of its kind must identify,
 * and the placeholder contract the generator needs — and deliberately no
 * substantive drafted clauses. Everything that constitutes legal drafting is
 * an `{ai:…}` block, which means it is written against the matter's own facts
 * at generation time and reviewed by a lawyer before it goes anywhere.
 *
 * The reason for that split is not architectural tidiness. A template shipped
 * with pre-written clause text is a document the firm did not draft and did
 * not review, sitting in their system under their letterhead, one "generate"
 * away from a filing. The firm replaces each of these with its own precedent;
 * until it does, the banner at the head of every one of them says so.
 *
 * Placeholder convention matches parseTemplate:
 *   {clientName}          — deterministic, filled from matter data
 *   {ai:groundsOfPetition} — an AI block the model drafts
 */

export interface StarterTemplate {
  name: string;
  practiceArea: PracticeArea;
  docType: string;
  /** Paragraphs in document order. */
  body: StarterParagraph[];
}

interface StarterParagraph {
  text: string;
  style?: 'title' | 'heading' | 'centre' | 'body' | 'note';
}

const REPLACE_ME =
  'STARTER TEMPLATE — replace with the firm’s own precedent before use. ' +
  'Structure and placeholders only; no clause wording has been supplied.';

export const STARTER_TEMPLATES: StarterTemplate[] = [
  {
    name: 'Joint Petition (Section 52 LRA)',
    practiceArea: 'family_matrimonial',
    docType: 'petition',
    body: [
      { text: REPLACE_ME, style: 'note' },
      { text: 'DALAM MAHKAMAH TINGGI MALAYA DI {courtLocation}', style: 'title' },
      { text: '(BAHAGIAN KELUARGA)', style: 'centre' },
      { text: 'PETISYEN PERCERAIAN BERSAMA NO: {caseNumber}', style: 'centre' },
      { text: 'ANTARA', style: 'centre' },
      { text: '{clientName} … Pempetisyen Pertama', style: 'centre' },
      { text: '{respondentName} … Pempetisyen Kedua', style: 'centre' },
      {
        text: 'JOINT PETITION pursuant to Section 52, Law Reform (Marriage and Divorce) Act 1976',
        style: 'heading',
      },
      {
        text: '1. The Petitioners, {clientName} and {respondentName}, were lawfully married on {marriageDate} at {marriagePlace}, and the said marriage was duly registered.',
      },
      { text: '2. There are {childCount} children of the marriage.' },
      { text: '3. {ai:groundsOfPetition}' },
      { text: '4. {ai:childArrangements}' },
      { text: '5. {ai:divisionOfAssets}' },
      { text: 'PRAYER', style: 'heading' },
      { text: '{ai:prayer}' },
      { text: 'Dated this {documentDate}.', style: 'body' },
      { text: 'Solicitors for the Petitioners', style: 'body' },
      { text: '{firmName}', style: 'body' },
    ],
  },
  {
    name: 'Letter of Demand — supply of goods',
    practiceArea: 'debt_recovery',
    docType: 'letter_of_demand',
    body: [
      { text: REPLACE_ME, style: 'note' },
      { text: '{firmName}', style: 'title' },
      { text: 'Our ref: {matterReference}', style: 'body' },
      { text: '{documentDate}', style: 'body' },
      { text: 'To: {debtorName}', style: 'body' },
      { text: '{debtorAddress}', style: 'body' },
      { text: 'WITHOUT PREJUDICE SAVE AS TO COSTS', style: 'heading' },
      { text: 'LETTER OF DEMAND — {matterTitle}', style: 'heading' },
      { text: '1. We act for {clientName} ("our client").' },
      {
        text: '2. Our client’s records show a sum of {amountOwed} outstanding in respect of {goodsDescription}, the last payment received on {lastPaymentDate}.',
      },
      { text: '3. {ai:factualBackground}' },
      { text: '4. {ai:demandAndConsequences}' },
      {
        text: '5. Payment is required within {demandDays} days of the date of this letter, failing which our client reserves its rights.',
      },
      { text: 'Yours faithfully', style: 'body' },
      { text: '{firmName}', style: 'body' },
    ],
  },
  {
    name: 'SPA cover letter',
    practiceArea: 'land_property',
    docType: 'cover_letter',
    body: [
      { text: REPLACE_ME, style: 'note' },
      { text: '{firmName}', style: 'title' },
      { text: 'Our ref: {matterReference}', style: 'body' },
      { text: '{documentDate}', style: 'body' },
      { text: 'To: {clientName}', style: 'body' },
      { text: '{clientAddress}', style: 'body' },
      {
        text: 'SALE AND PURCHASE AGREEMENT — {propertyAddress}',
        style: 'heading',
      },
      { text: 'Dear {clientSalutation},' },
      {
        text: '1. We enclose the Sale and Purchase Agreement in respect of {propertyAddress} for your execution.',
      },
      { text: '2. {ai:documentsEnclosed}' },
      { text: '3. {ai:nextStepsAndTimeline}' },
      {
        text: '4. Should you have any queries, please contact {handlingLawyer} at this office.',
      },
      { text: 'Yours faithfully', style: 'body' },
      { text: '{firmName}', style: 'body' },
    ],
  },
];

// ---------------------------------------------------------------------------
// Minimal OOXML writer
// ---------------------------------------------------------------------------

/**
 * Built here rather than committed as binary fixtures.
 *
 * A .docx in the repository is an opaque blob: nobody reviewing a pull request
 * can see that a placeholder was renamed or a clause quietly added. Generating
 * them from the declarations above keeps the whole template reviewable as
 * text, and the output is a genuine Word document either way.
 */

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function paragraph(item: StarterParagraph): string {
  const style = item.style ?? 'body';
  const justify = style === 'title' || style === 'centre' ? '<w:jc w:val="center"/>' : '';
  const spacing = '<w:spacing w:after="160"/>';
  const bold = style === 'title' || style === 'heading' ? '<w:b/>' : '';
  const italic = style === 'note' ? '<w:i/>' : '';
  const colour = style === 'note' ? '<w:color w:val="9A7B2F"/>' : '';
  const size = style === 'title' ? '<w:sz w:val="28"/>' : '';

  return (
    `<w:p><w:pPr>${spacing}${justify}</w:pPr>` +
    `<w:r><w:rPr>${bold}${italic}${colour}${size}</w:rPr>` +
    `<w:t xml:space="preserve">${escapeXml(item.text)}</w:t></w:r></w:p>`
  );
}

const CONTENT_TYPES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>`;

const ROOT_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`;

export function buildStarterDocx(template: StarterTemplate): Buffer {
  const body = template.body.map(paragraph).join('');
  const document = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:body>${body}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"/></w:sectPr></w:body>
</w:document>`;

  const zip = new PizZip();
  zip.file('[Content_Types].xml', CONTENT_TYPES);
  zip.folder('_rels')?.file('.rels', ROOT_RELS);
  zip.folder('word')?.file('document.xml', document);

  return zip.generate({ type: 'nodebuffer', compression: 'DEFLATE' }) as Buffer;
}

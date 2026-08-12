import 'server-only';
import PizZip from 'pizzip';
import { humaniseTag } from '@/lib/documents/template';

/**
 * Colour-coded draft preview (FR-4.2, FR-4.4).
 *
 * The .docx a lawyer downloads is one undifferentiated document. Nothing in it
 * says which sentences came from the firm's own precedent and which a model
 * wrote this morning — and that is precisely the question a supervising
 * partner asks first. This module reconstructs that distinction from what the
 * platform already recorded, so the answer is visible on screen before anyone
 * opens Word.
 *
 * The classification is evidence-based, not inferred. `documentVersions.aiBlocks`
 * stores the exact rendered text of every block the model produced for that
 * version; those strings are located in the stored document and everything else
 * is, by elimination, the firm's template and its own matter data. No heuristic
 * decides what "looks AI-written" — if a run of text is not one the model
 * returned, it is not marked as one.
 *
 * Two consequences worth stating plainly, because the UI has to be honest
 * about both:
 *
 *  - A version uploaded by a lawyer (`generatedBy: 'human'`) stores no AI
 *    blocks at all, by design — see revise.ts. Its preview is therefore
 *    entirely unattributed, and the screen says so rather than implying the
 *    document contains no model-written text.
 *  - If a block's text cannot be found in the document, it is reported as
 *    unmatched instead of being silently dropped. That happens when someone
 *    edits the generated text in Word and re-uploads it, and the lawyer needs
 *    to know the highlighting is no longer complete.
 *
 * Text is extracted rather than rendered. Everything this returns is a plain
 * string handed to React as a child, so model output is escaped by the
 * renderer and never becomes markup (LLM output is treated as untrusted input).
 */

/** How a run of text got into the document. */
export type PreviewSegmentKind =
  /** The firm's precedent wording, or a deterministic value from matter data. */
  | 'template'
  /** Drafted by the model for this version. */
  | 'ai'
  /** A deterministic field with no value — rendered as [TO CONFIRM: …] (AT-09). */
  | 'missing';

export interface PreviewSegment {
  kind: PreviewSegmentKind;
  text: string;
  /** Present on `ai` segments: the `ai:` placeholder that produced this run. */
  blockName?: string;
}

export type PreviewAlign = 'left' | 'center' | 'right' | 'justify';

export interface PreviewParagraph {
  segments: PreviewSegment[];
  align: PreviewAlign;
  /** Whole paragraph is bold — a heading or a title in the firm's template. */
  strong: boolean;
}

export interface PreviewBlock {
  /** The placeholder name, e.g. `ai:groundsOfPetition`. */
  name: string;
  /** Human label, matching the wording used elsewhere in the app. */
  label: string;
  /** Characters of drafted text stored for this block. */
  chars: number;
  /** False when the stored text no longer appears in the document. */
  matched: boolean;
}

export interface DraftPreview {
  paragraphs: PreviewParagraph[];
  blocks: PreviewBlock[];
  /** Characters attributed to the model. */
  aiChars: number;
  /** Characters attributed to the template and matter data, gaps included. */
  templateChars: number;
  /** The distinct [TO CONFIRM: …] markers found, in document order. */
  missingMarkers: string[];
  /** False when the stored file could not be read as a Word document. */
  readable: boolean;
  /** True when the document was longer than the preview renders. */
  truncated: boolean;
}

/**
 * A pleading runs to tens of paragraphs; a bundled exhibit list can run to
 * thousands. The cap keeps one oversized document from producing a page that
 * takes seconds to serialise, and the UI tells the reader it stopped.
 */
const MAX_PARAGRAPHS = 1500;

/** Rendered by assembleDocx for a deterministic field with no value. */
const MISSING_MARKER = /\[TO CONFIRM: [^\]]*\]/g;

export function buildDraftPreview(input: {
  docxBuffer: Buffer;
  aiBlocks: Record<string, string>;
}): DraftPreview {
  const xml = readDocumentXml(input.docxBuffer);

  if (xml === null) {
    return {
      paragraphs: [],
      blocks: blockSummary(input.aiBlocks, new Set()),
      aiChars: 0,
      templateChars: 0,
      missingMarkers: [],
      readable: false,
      truncated: false,
    };
  }

  const needles = buildNeedles(input.aiBlocks);
  const raw = extractParagraphs(xml);
  const truncated = raw.length > MAX_PARAGRAPHS;

  const paragraphs: PreviewParagraph[] = [];
  const matchedNames = new Set<string>();
  const missingMarkers: string[] = [];
  let aiChars = 0;
  let templateChars = 0;

  // Every paragraph is classified, but only the first MAX_PARAGRAPHS are
  // returned for rendering. Matching the whole document matters even when the
  // rendering stops early: a block that appears only past the cap would
  // otherwise be reported as "no longer in this file", which is a warning the
  // lawyer would act on and which would be false.
  for (const [index, para] of raw.entries()) {
    const segments = segmentText(para.text, needles);

    for (const segment of segments) {
      if (segment.kind === 'ai') {
        aiChars += segment.text.length;
      } else {
        templateChars += segment.text.length;
        if (segment.kind === 'missing' && !missingMarkers.includes(segment.text)) {
          missingMarkers.push(segment.text);
        }
      }
    }

    // An empty paragraph is spacing in the original and should stay spacing
    // here — it is kept with no segments rather than dropped.
    if (index < MAX_PARAGRAPHS) {
      paragraphs.push({ segments, align: para.align, strong: para.strong });
    }
  }

  for (const needle of needles) {
    if (needle.used) for (const name of needle.names) matchedNames.add(name);
  }

  return {
    paragraphs,
    blocks: blockSummary(input.aiBlocks, matchedNames),
    aiChars,
    templateChars,
    missingMarkers,
    readable: true,
    truncated,
  };
}

/** Share of the visible document the model wrote, 0–100. */
export function aiShare(preview: DraftPreview): number {
  const total = preview.aiChars + preview.templateChars;
  if (total === 0) return 0;
  return Math.round((preview.aiChars / total) * 100);
}

// ---------------------------------------------------------------------------
// Matching
// ---------------------------------------------------------------------------

interface Needle {
  /** Every block name that produced this identical text. */
  names: string[];
  text: string;
  used: boolean;
}

/**
 * Longest first, so a short block cannot claim a position inside a longer one.
 * Blocks that rendered to identical text share a needle: attributing the same
 * characters to two names twice would double-count them, and reporting the
 * second as unmatched would be wrong — it is in the document.
 */
function buildNeedles(aiBlocks: Record<string, string>): Needle[] {
  const byText = new Map<string, string[]>();

  for (const [name, value] of Object.entries(aiBlocks)) {
    const text = normalise(value);
    // An empty needle would match at every position.
    if (text.trim().length === 0) continue;
    const names = byText.get(text);
    if (names) names.push(name);
    else byText.set(text, [name]);
  }

  return [...byText.entries()]
    .map(([text, names]) => ({ text, names, used: false }))
    .sort((a, b) => b.text.length - a.text.length);
}

/**
 * Walk the paragraph once, taking the earliest block match at each step and
 * treating everything between matches as template text.
 */
function segmentText(text: string, needles: Needle[]): PreviewSegment[] {
  if (text.length === 0) return [];
  if (needles.length === 0) return templateSegments(text);

  const out: PreviewSegment[] = [];
  const at = needles.map((needle) => text.indexOf(needle.text));
  let cursor = 0;
  let pending = '';

  while (cursor < text.length) {
    let best = -1;

    for (let i = 0; i < needles.length; i += 1) {
      if (at[i]! !== -1 && at[i]! < cursor) {
        at[i] = text.indexOf(needles[i]!.text, cursor);
      }
      if (at[i]! === -1) continue;
      if (best === -1 || at[i]! < at[best]!) best = i;
    }

    if (best === -1) {
      pending += text.slice(cursor);
      break;
    }

    const needle = needles[best]!;
    pending += text.slice(cursor, at[best]!);
    out.push(...templateSegments(pending));
    pending = '';

    needle.used = true;
    out.push({ kind: 'ai', text: needle.text, blockName: needle.names[0] });
    cursor = at[best]! + needle.text.length;
  }

  out.push(...templateSegments(pending));
  return out;
}

/** Split template text so the [TO CONFIRM: …] gaps carry their own colour. */
function templateSegments(text: string): PreviewSegment[] {
  if (text.length === 0) return [];

  const out: PreviewSegment[] = [];
  let cursor = 0;

  MISSING_MARKER.lastIndex = 0;
  for (const match of text.matchAll(MISSING_MARKER)) {
    const start = match.index;
    if (start > cursor) out.push({ kind: 'template', text: text.slice(cursor, start) });
    out.push({ kind: 'missing', text: match[0] });
    cursor = start + match[0].length;
  }

  if (cursor < text.length) out.push({ kind: 'template', text: text.slice(cursor) });
  return out;
}

function blockSummary(aiBlocks: Record<string, string>, matched: Set<string>): PreviewBlock[] {
  return Object.entries(aiBlocks)
    .map(([name, value]) => ({
      name,
      label: humaniseTag(name),
      chars: normalise(value).length,
      matched: matched.has(name),
    }))
    .sort((a, b) => b.chars - a.chars);
}

/**
 * Word writes a line break as an element, not a character. Normalising both
 * the extracted text and the stored block the same way is what makes an exact
 * comparison possible at all.
 */
function normalise(value: string): string {
  return value.replace(/\r\n?/g, '\n');
}

// ---------------------------------------------------------------------------
// OOXML text extraction
// ---------------------------------------------------------------------------

interface RawParagraph {
  text: string;
  align: PreviewAlign;
  strong: boolean;
}

function readDocumentXml(buffer: Buffer): string | null {
  try {
    const zip = new PizZip(buffer);
    return zip.file('word/document.xml')?.asText() ?? null;
  } catch {
    // A stored file that is not a readable .docx is a real possibility — an
    // interrupted upload, a truncated object. The preview says it cannot show
    // the document rather than failing the whole page.
    return null;
  }
}

// `<w:p>` but not `<w:pPr>`: the next character must end the tag or start an
// attribute. Paragraphs never nest, so a lazy match pairs them correctly even
// inside table cells.
const PARAGRAPH = /<w:p(?:\s[^>]*)?>([\s\S]*?)<\/w:p>/g;
const RUN = /<w:r(?:\s[^>]*)?>([\s\S]*?)<\/w:r>/g;
const RUN_PROPS = /<w:rPr>([\s\S]*?)<\/w:rPr>/;
const PARA_PROPS = /<w:pPr>([\s\S]*?)<\/w:pPr>/;
const JUSTIFY = /<w:jc\s[^>]*w:val="([a-z]+)"/;
const BOLD = /<w:b(\s[^>]*?)?\/>/;
const OFF = /w:val="(?:0|false|off)"/;
/** Text, breaks and tabs in the order they appear inside a run. */
const RUN_CONTENT = /<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>|<w:br\s*\/?>|<w:cr\s*\/?>|<w:tab\s*\/?>/g;

function extractParagraphs(xml: string): RawParagraph[] {
  const body = xml.slice(
    xml.indexOf('<w:body>') === -1 ? 0 : xml.indexOf('<w:body>'),
    xml.indexOf('</w:body>') === -1 ? xml.length : xml.indexOf('</w:body>'),
  );

  const paragraphs: RawParagraph[] = [];

  PARAGRAPH.lastIndex = 0;
  for (const match of body.matchAll(PARAGRAPH)) {
    const inner = match[1] ?? '';
    const props = PARA_PROPS.exec(inner)?.[1] ?? '';

    let text = '';
    let bolded = 0;
    let counted = 0;

    RUN.lastIndex = 0;
    for (const run of inner.matchAll(RUN)) {
      const content = run[1] ?? '';
      const runText = extractRunText(content);
      text += runText;

      // Whitespace-only runs say nothing about the paragraph's emphasis.
      if (runText.trim().length > 0) {
        counted += 1;
        if (isBold(RUN_PROPS.exec(content)?.[1] ?? '')) bolded += 1;
      }
    }

    paragraphs.push({
      text: normalise(text),
      align: alignOf(props),
      strong: counted > 0 && bolded === counted,
    });
  }

  return paragraphs;
}

function extractRunText(content: string): string {
  let text = '';

  RUN_CONTENT.lastIndex = 0;
  for (const token of content.matchAll(RUN_CONTENT)) {
    const literal = token[1];
    if (literal !== undefined) text += decodeEntities(literal);
    else if (token[0].startsWith('<w:tab')) text += '\t';
    else text += '\n';
  }

  return text;
}

function isBold(runProps: string): boolean {
  const bold = BOLD.exec(runProps);
  if (!bold) return false;
  return !OFF.test(bold[1] ?? '');
}

function alignOf(paraProps: string): PreviewAlign {
  const value = JUSTIFY.exec(paraProps)?.[1];
  if (value === 'center' || value === 'right' || value === 'both' || value === 'justify') {
    return value === 'both' ? 'justify' : value;
  }
  return 'left';
}

/** `&amp;` last, so `&amp;lt;` does not decode twice into `<`. */
function decodeEntities(value: string): string {
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, code: string) => String.fromCodePoint(parseInt(code, 16)))
    .replace(/&amp;/g, '&');
}

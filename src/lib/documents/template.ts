import 'server-only';
import PizZip from 'pizzip';
import Docxtemplater from 'docxtemplater';
import type { TemplatePlaceholderSchema } from '@/lib/db/schema';

/**
 * .docx template parsing and assembly (M4, FR-4.1 – FR-4.3).
 *
 * The firm supplies its own precedent templates as .docx with named
 * placeholders. Output is an editable .docx that preserves firm styles,
 * numbering and track-changes readiness (FR-4.3), which is why the template is
 * *filled* rather than regenerated: rebuilding a document from scratch loses
 * the firm's numbering scheme and paragraph styles, and a lawyer would notice
 * immediately.
 *
 * Placeholder convention:
 *   {clientName}      — deterministic, filled from matter data, never model output
 *   {ai:groundsOfPetition}  — an AI block; the model drafts only these
 *
 * FR-4.2 is the load-bearing rule: "Deterministic fields are never
 * model-generated." The two namespaces are kept separate all the way through,
 * and `assembleDocx` takes them as separate arguments so they cannot be
 * accidentally merged at the call site.
 */

const AI_PREFIX = 'ai:';

export interface ParsedTemplate {
  schema: TemplatePlaceholderSchema;
  /** Every placeholder found, in document order. */
  allTags: string[];
}

/**
 * Read a template's placeholders without rendering it.
 * Uses docxtemplater's inspect module so split runs — Word routinely breaks
 * `{clientName}` across three XML runs — are resolved the same way they will
 * be at render time.
 */
export function parseTemplate(buffer: Buffer): ParsedTemplate {
  const zip = new PizZip(buffer);
  const doc = new Docxtemplater(zip, {
    paragraphLoop: true,
    linebreaks: true,
    delimiters: { start: '{', end: '}' },
    // Report every missing tag rather than throwing on the first.
    errorLogging: false,
    nullGetter: () => '',
  });

  const tags = collectTags(doc);

  const deterministic: TemplatePlaceholderSchema['deterministic'] = [];
  const ai: TemplatePlaceholderSchema['ai'] = [];

  for (const tag of tags) {
    if (tag.startsWith(AI_PREFIX)) {
      const name = tag.slice(AI_PREFIX.length);
      ai.push({
        name: tag,
        label: humanise(name),
        instruction: `Draft the "${humanise(name)}" section of this document.`,
      });
    } else {
      deterministic.push({
        name: tag,
        label: humanise(tag),
        required: true,
        source: inferSource(tag),
      });
    }
  }

  return { schema: { deterministic, ai }, allTags: tags };
}

/**
 * docxtemplater exposes discovered tags through its internal module list;
 * the shape differs between versions, so this reads defensively and falls back
 * to a regex over the raw XML rather than throwing.
 */
function collectTags(doc: Docxtemplater): string[] {
  const found = new Set<string>();

  try {
    const inspect = (doc as unknown as { getFullText?: () => string }).getFullText?.() ?? '';
    for (const match of inspect.matchAll(/\{([^{}]+)\}/g)) {
      const tag = match[1]?.trim();
      if (tag) found.add(tag);
    }
  } catch {
    // fall through to the XML scan below
  }

  if (found.size === 0) {
    try {
      const zip = (doc as unknown as { getZip: () => PizZip }).getZip();
      const xml = zip.file('word/document.xml')?.asText() ?? '';
      // Strip run boundaries first so a tag split across runs is seen whole.
      const flattened = xml.replace(/<\/w:t>.*?<w:t[^>]*>/gs, '');
      for (const match of flattened.matchAll(/\{([^{}<>]+)\}/g)) {
        const tag = match[1]?.trim();
        if (tag) found.add(tag);
      }
    } catch {
      // An unreadable template surfaces as an empty schema, which the admin
      // console shows as "no placeholders found" rather than a stack trace.
    }
  }

  return [...found];
}

function humanise(tag: string): string {
  return tag
    .replace(/[_.]/g, ' ')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/^\w/, (c) => c.toUpperCase());
}

/** Best-guess mapping from placeholder name to matter-data path. */
function inferSource(tag: string): string | undefined {
  const map: Record<string, string> = {
    clientName: 'client.fullName',
    clientAddress: 'client.address',
    clientIdNumber: 'client.idNumber',
    clientEmail: 'client.email',
    clientPhone: 'client.phone',
    matterReference: 'matter.reference',
    matterTitle: 'matter.title',
    practiceArea: 'matter.practiceArea',
    lawyerName: 'lawyer.fullName',
    office: 'matter.office',
    todayDate: 'system.today',
  };
  return map[tag];
}

export interface AssembleInput {
  templateBuffer: Buffer;
  /** Filled from matter data. Never model output (FR-4.2). */
  deterministic: Record<string, string>;
  /** Model-drafted narrative blocks, keyed by their `ai:` tag. */
  aiBlocks: Record<string, string>;
}

export interface AssembleResult {
  buffer: Buffer;
  /** Deterministic placeholders with no value — surfaced to the lawyer (AT-09). */
  missingDeterministic: string[];
}

/**
 * Render the template.
 *
 * AT-09: "Draft generation with missing intake data — deterministic
 * placeholders flagged, no invented values." A missing deterministic field
 * renders as a visible `[TO CONFIRM: …]` marker and is returned in
 * `missingDeterministic`, so the gap is obvious in the document AND actionable
 * in the UI. It is never filled with a plausible-looking guess.
 */
export function assembleDocx(input: AssembleInput): AssembleResult {
  const zip = new PizZip(input.templateBuffer);
  const missing: string[] = [];

  const data: Record<string, string> = {};
  for (const [key, value] of Object.entries(input.deterministic)) {
    data[key] = value;
  }
  for (const [key, value] of Object.entries(input.aiBlocks)) {
    data[key] = value;
  }

  const doc = new Docxtemplater(zip, {
    paragraphLoop: true,
    linebreaks: true,
    delimiters: { start: '{', end: '}' },
    nullGetter: (part: { value?: string; module?: string }) => {
      const tag = part.value ?? 'unknown';
      if (!tag.startsWith(AI_PREFIX)) {
        missing.push(tag);
        return `[TO CONFIRM: ${humanise(tag)}]`;
      }
      return '';
    },
  });

  doc.render(data);

  const buffer = doc.getZip().generate({
    type: 'nodebuffer',
    compression: 'DEFLATE',
  }) as Buffer;

  return { buffer, missingDeterministic: [...new Set(missing)] };
}

/** Plain-text diff summary between two versions (FR-4.6). */
export function summariseChanges(
  previous: Record<string, string>,
  next: Record<string, string>,
): string {
  const changed: string[] = [];
  const added: string[] = [];

  for (const [key, value] of Object.entries(next)) {
    if (!(key in previous)) {
      added.push(humanise(key.replace(AI_PREFIX, '')));
    } else if (previous[key] !== value) {
      changed.push(humanise(key.replace(AI_PREFIX, '')));
    }
  }

  const parts: string[] = [];
  if (added.length > 0) parts.push(`Added: ${added.join(', ')}`);
  if (changed.length > 0) parts.push(`Revised: ${changed.join(', ')}`);
  return parts.length > 0 ? parts.join('. ') : 'No textual changes.';
}

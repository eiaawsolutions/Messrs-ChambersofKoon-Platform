/**
 * What the lawyer changed about the model's wording (FR-4.8).
 *
 * "Lawyer edits to AI blocks captured as signal for prompt refinement (stored,
 *  not used for model training)."
 *
 * The signal is recoverable without asking anyone to annotate anything.
 * `documentVersions.aiBlocks` holds the exact text the model returned for each
 * block; the revision a lawyer uploads is the same document after they worked
 * on it. A block whose stored text is no longer present verbatim is one they
 * rewrote, and the paragraph that stands in its place is what they preferred.
 *
 * Both halves are needed to be useful. "Block X gets edited a lot" tells a
 * prompt author almost nothing; "the model wrote this, and three partners
 * independently replaced it with that" tells them what to change.
 *
 * Two limits, stated because the stored rows should not be read as more than
 * they are:
 *
 * - The replacement is matched by word overlap, not tracked through Word's
 *   revision marks. It is the most similar paragraph in the revised document,
 *   which for a rewrite is right and for a wholesale replacement may be empty.
 * - An empty `editedText` is a real result and not a failure: it means the
 *   model's wording is gone and nothing recognisably derived from it remains.
 *   That is the strongest possible signal about a block.
 *
 * Nothing here is fed back into a model. The PRD is explicit — stored as
 * signal, not used for training — and the rows exist to be read by whoever
 * next edits the prompt.
 */

export interface EditSignal {
  blockName: string;
  /** Exactly what the model produced for this block. */
  aiText: string;
  /** The closest paragraph in the revision, or '' when nothing is close. */
  editedText: string;
}

/**
 * How similar a paragraph must be before it is called the replacement.
 *
 * Below this, the paragraphs sharing words with the model's text are the ones
 * that merely mention the same parties, and naming one of them as "what the
 * lawyer preferred" would put a misleading pair in front of a prompt author.
 */
const SIMILARITY_FLOOR = 0.35;

/** A rewritten clause stays clause-sized; anything longer is a different part. */
const MAX_LENGTH_RATIO = 3;

function words(value: string): string[] {
  return value
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter(Boolean);
}

/**
 * Sørensen–Dice over word bigrams.
 *
 * Bigrams rather than single words because word order carries most of the
 * difference between two drafts of the same clause: two paragraphs built from
 * the same legal vocabulary in a different order are not the same sentence,
 * and a unigram measure would call them near-identical.
 */
export function similarity(a: string, b: string): number {
  const left = bigrams(words(a));
  const right = bigrams(words(b));
  if (left.length === 0 || right.length === 0) return 0;

  const pool = new Map<string, number>();
  for (const gram of left) pool.set(gram, (pool.get(gram) ?? 0) + 1);

  let shared = 0;
  for (const gram of right) {
    const remaining = pool.get(gram) ?? 0;
    if (remaining > 0) {
      shared += 1;
      pool.set(gram, remaining - 1);
    }
  }

  return (2 * shared) / (left.length + right.length);
}

function bigrams(tokens: string[]): string[] {
  // A single-word block has no bigram; pair it with itself so it can still
  // match rather than scoring zero against everything.
  if (tokens.length === 1) return [`${tokens[0]} ${tokens[0]}`];
  const out: string[] = [];
  for (let i = 0; i < tokens.length - 1; i += 1) out.push(`${tokens[i]} ${tokens[i + 1]}`);
  return out;
}

function normalise(value: string): string {
  return value.replace(/\r\n?/g, '\n');
}

/**
 * Which blocks were rewritten, and what replaced them.
 *
 * `revisedParagraphs` is the plain text of the uploaded document, one entry per
 * paragraph — `buildDraftPreview` produces exactly this shape.
 */
export function detectEditedBlocks(input: {
  aiBlocks: Record<string, string>;
  revisedParagraphs: string[];
}): EditSignal[] {
  const paragraphs = input.revisedParagraphs.map(normalise).filter((p) => p.trim().length > 0);
  const haystack = paragraphs.join('\n');

  const signals: EditSignal[] = [];

  for (const [blockName, rawText] of Object.entries(input.aiBlocks)) {
    const aiText = normalise(rawText);
    if (aiText.trim().length === 0) continue;

    // Still present verbatim: the lawyer left this block alone.
    if (haystack.includes(aiText)) continue;

    let best = '';
    let bestScore = 0;

    for (const paragraph of paragraphs) {
      // A paragraph many times the length of the block is a different part of
      // the document that happens to share vocabulary, not a rewrite of it.
      if (paragraph.length > aiText.length * MAX_LENGTH_RATIO) continue;

      const score = similarity(aiText, paragraph);
      if (score > bestScore) {
        bestScore = score;
        best = paragraph;
      }
    }

    signals.push({
      blockName,
      aiText,
      editedText: bestScore >= SIMILARITY_FLOOR ? best : '',
    });
  }

  return signals;
}

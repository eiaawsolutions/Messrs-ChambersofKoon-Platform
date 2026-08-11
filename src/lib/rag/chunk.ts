/**
 * Text chunking for retrieval (FR-5.5).
 *
 * "Extracted text is chunked (target 800–1200 tokens, 15% overlap, split on
 *  document structure where possible), embedded and written to chunks."
 *
 * Structure-aware: the splitter tries paragraph and heading boundaries before
 * falling back to sentences, and only splits mid-sentence when a single
 * sentence exceeds the budget. A pleading cut in the middle of a clause
 * retrieves badly — the excerpt a lawyer sees has to be quotable.
 *
 * Token counting is an estimate. Calling the model's tokeniser per chunk would
 * cost a round trip per document; for English legal prose ~4 characters per
 * token is close enough to keep chunks inside the embedding model's window,
 * which is the only hard constraint.
 */

export interface ChunkOptions {
  targetTokens?: number;
  maxTokens?: number;
  overlapRatio?: number;
}

export interface TextChunk {
  index: number;
  text: string;
  tokenCount: number;
  /** Human-readable locator for the citation, e.g. "p. 4" or "Clause 7.2". */
  locator: string | null;
}

const DEFAULTS = {
  targetTokens: 1000,
  maxTokens: 1200,
  overlapRatio: 0.15,
};

/** Rough token estimate: ~4 characters per token for English legal prose. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/**
 * Detect a locator from the text of a block: a page marker inserted by the
 * extractor, or a numbered clause heading.
 */
export function detectLocator(block: string): string | null {
  const page = block.match(/\[\[page:(\d+)\]\]/);
  if (page) return `p. ${page[1]}`;

  const clause = block.match(/^\s*(\d+(?:\.\d+)*)[.)]\s+\S/);
  if (clause) return `Clause ${clause[1]}`;

  const heading = block.match(/^\s*([A-Z][A-Z \d.'-]{4,60})\s*$/m);
  if (heading?.[1]) return heading[1].trim().slice(0, 60);

  return null;
}

function stripMarkers(text: string): string {
  return text.replace(/\[\[page:\d+\]\]/g, '').trim();
}

/** Split into paragraph-ish blocks, keeping page markers attached. */
function toBlocks(text: string): string[] {
  return text
    .split(/\n{2,}/)
    .map((b) => b.trim())
    .filter(Boolean);
}

/** Sentence split that tolerates legal abbreviations and numbered clauses. */
export function splitSentences(text: string): string[] {
  const parts = text.split(/(?<=[.!?])\s+(?=[A-Z(“"])/);
  const merged: string[] = [];
  for (const part of parts) {
    const previous = merged[merged.length - 1];
    // Re-join fragments left by "No.", "Sdn.", "v.", "Ors." and similar.
    if (previous && /\b(?:No|Sdn|Bhd|v|Ors|Anor|Ltd|Pte|s|ss|art|cl)\.$/i.test(previous)) {
      merged[merged.length - 1] = `${previous} ${part}`;
    } else {
      merged.push(part);
    }
  }
  return merged.filter(Boolean);
}

export function chunkText(raw: string, options: ChunkOptions = {}): TextChunk[] {
  const targetTokens = options.targetTokens ?? DEFAULTS.targetTokens;
  const maxTokens = options.maxTokens ?? DEFAULTS.maxTokens;
  const overlapRatio = options.overlapRatio ?? DEFAULTS.overlapRatio;

  const text = raw.replace(/\r\n/g, '\n').trim();
  if (!text) return [];

  const blocks = toBlocks(text);
  const chunks: TextChunk[] = [];

  let buffer: string[] = [];
  let bufferTokens = 0;
  let locator: string | null = null;
  let currentPage: string | null = null;

  const flush = (): void => {
    if (buffer.length === 0) return;
    const body = stripMarkers(buffer.join('\n\n'));
    if (!body) {
      buffer = [];
      bufferTokens = 0;
      return;
    }
    chunks.push({
      index: chunks.length,
      text: body,
      tokenCount: estimateTokens(body),
      locator: locator ?? currentPage,
    });

    // Carry the tail of this chunk into the next one so a passage split across
    // a boundary is still retrievable from either side.
    const overlapTokens = Math.floor(targetTokens * overlapRatio);
    if (overlapTokens > 0) {
      const tail: string[] = [];
      let tailTokens = 0;
      for (let i = buffer.length - 1; i >= 0 && tailTokens < overlapTokens; i -= 1) {
        tail.unshift(buffer[i]!);
        tailTokens += estimateTokens(buffer[i]!);
      }
      buffer = tail;
      bufferTokens = tailTokens;
    } else {
      buffer = [];
      bufferTokens = 0;
    }
    locator = null;
  };

  for (const block of blocks) {
    const pageMarker = block.match(/\[\[page:(\d+)\]\]/);
    if (pageMarker) currentPage = `p. ${pageMarker[1]}`;

    const blockTokens = estimateTokens(block);

    // A single block larger than the ceiling is split on sentences.
    if (blockTokens > maxTokens) {
      flush();
      let sentenceBuffer: string[] = [];
      let sentenceTokens = 0;

      for (const sentence of splitSentences(block)) {
        const tokens = estimateTokens(sentence);
        if (sentenceTokens + tokens > targetTokens && sentenceBuffer.length > 0) {
          const body = stripMarkers(sentenceBuffer.join(' '));
          if (body) {
            chunks.push({
              index: chunks.length,
              text: body,
              tokenCount: estimateTokens(body),
              locator: detectLocator(block) ?? currentPage,
            });
          }
          sentenceBuffer = [];
          sentenceTokens = 0;
        }
        sentenceBuffer.push(sentence);
        sentenceTokens += tokens;
      }

      if (sentenceBuffer.length > 0) {
        buffer = [sentenceBuffer.join(' ')];
        bufferTokens = sentenceTokens;
        locator = detectLocator(block) ?? currentPage;
      }
      continue;
    }

    if (bufferTokens + blockTokens > targetTokens && buffer.length > 0) {
      flush();
    }

    if (!locator) locator = detectLocator(block);
    buffer.push(block);
    bufferTokens += blockTokens;
  }

  flush();

  // The overlap carry can leave a final chunk that duplicates its predecessor.
  const last = chunks[chunks.length - 1];
  const penultimate = chunks[chunks.length - 2];
  if (last && penultimate && penultimate.text.includes(last.text)) {
    chunks.pop();
  }

  return chunks.map((chunk, index) => ({ ...chunk, index }));
}

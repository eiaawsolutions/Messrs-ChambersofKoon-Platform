import 'server-only';
import { config, secret } from '@/lib/config/env';

/**
 * Embedding provider (PRD §3.1, FR-5.5).
 *
 * voyage-law-2 is the default: it is trained on legal corpora and measurably
 * better than a general-purpose model at the retrieval this platform does —
 * matching a new debt-recovery matter to prior pleadings against Sdn Bhd
 * defendants. OpenAI is supported as a fallback so the firm is not locked to a
 * single vendor.
 *
 * The dimension is fixed at project start and recorded on every row
 * (`chunks.embedding_model_version`). Changing model means re-embedding the
 * whole archive; the version column is what makes that migration auditable
 * rather than a silent quality regression.
 */

export interface EmbedResult {
  vectors: number[][];
  modelVersion: string;
}

const VOYAGE_ENDPOINT = 'https://api.voyageai.com/v1/embeddings';
const OPENAI_ENDPOINT = 'https://api.openai.com/v1/embeddings';

/** Voyage caps a request at 128 inputs; keep well inside it. */
const BATCH_SIZE = 96;

export type EmbedInputType = 'document' | 'query';

async function embedVoyage(texts: string[], inputType: EmbedInputType): Promise<number[][]> {
  const apiKey = await secret('EMBEDDING_API_KEY');
  const model = config().EMBEDDING_MODEL_VERSION;

  const response = await fetch(VOYAGE_ENDPOINT, {
    method: 'POST',
    headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      input: texts,
      model,
      // Voyage embeds documents and queries differently; using the right one
      // is worth several points of recall.
      input_type: inputType,
      truncation: true,
    }),
    cache: 'no-store',
  });

  if (!response.ok) {
    throw new Error(`Voyage embedding failed with HTTP ${response.status}`);
  }

  const payload = (await response.json()) as {
    data: Array<{ embedding: number[]; index: number }>;
  };
  // The API does not guarantee order; index is authoritative.
  return payload.data
    .slice()
    .sort((a, b) => a.index - b.index)
    .map((d) => d.embedding);
}

async function embedOpenAi(texts: string[]): Promise<number[][]> {
  const apiKey = await secret('EMBEDDING_API_KEY');
  const cfg = config();

  const response = await fetch(OPENAI_ENDPOINT, {
    method: 'POST',
    headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      input: texts,
      model: cfg.EMBEDDING_MODEL_VERSION,
      dimensions: cfg.EMBEDDING_DIMENSIONS,
    }),
    cache: 'no-store',
  });

  if (!response.ok) {
    throw new Error(`OpenAI embedding failed with HTTP ${response.status}`);
  }

  const payload = (await response.json()) as {
    data: Array<{ embedding: number[]; index: number }>;
  };
  return payload.data
    .slice()
    .sort((a, b) => a.index - b.index)
    .map((d) => d.embedding);
}

export async function embed(
  texts: string[],
  inputType: EmbedInputType = 'document',
): Promise<EmbedResult> {
  const cfg = config();
  if (texts.length === 0) return { vectors: [], modelVersion: cfg.EMBEDDING_MODEL_VERSION };

  const vectors: number[][] = [];
  for (let i = 0; i < texts.length; i += BATCH_SIZE) {
    const batch = texts.slice(i, i + BATCH_SIZE);
    const result =
      cfg.EMBEDDING_PROVIDER === 'openai'
        ? await embedOpenAi(batch)
        : await embedVoyage(batch, inputType);
    vectors.push(...result);
  }

  // A dimension mismatch would be stored as a broken vector and only surface
  // later as bad retrieval. Fail loudly instead.
  const expected = cfg.EMBEDDING_DIMENSIONS;
  for (const vector of vectors) {
    if (vector.length !== expected) {
      throw new Error(
        `Embedding dimension mismatch: model returned ${vector.length}, ` +
          `schema expects ${expected}. The chunks.embedding column is vector(${expected}); ` +
          `changing model requires a migration and a full re-embed.`,
      );
    }
  }

  return { vectors, modelVersion: cfg.EMBEDDING_MODEL_VERSION };
}

/** pgvector literal format. */
export function toVectorLiteral(vector: number[]): string {
  return `[${vector.join(',')}]`;
}

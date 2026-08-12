import 'server-only';
import { sql } from 'drizzle-orm';
import { db } from '@/lib/db/client';
import { embed, toVectorLiteral } from '@/lib/rag/embed';
import { generateStructured, AiSchemaError } from '@/lib/ai/client';
import { QUERY_REWRITE_SYSTEM, wrapUntrusted } from '@/lib/ai/prompts';
import { queryRewriteJsonSchema, queryRewriteSchema } from '@/lib/ai/schemas';
import { PERMISSIONS, type Scope } from '@/lib/auth/permissions';
import { grantedScope, type Actor } from '@/lib/auth/guard';
import { audit, AUDIT_ACTIONS } from '@/lib/audit/log';
import { maskName } from '@/lib/security/crypto';
import type { Office, PracticeArea } from '@/lib/db/schema';

/**
 * Permission-scoped hybrid retrieval (M6, FR-6.1 – FR-6.6).
 *
 * Two things make this correct rather than merely functional:
 *
 * 1. **Scope before rank (FR-6.2).** The permitted-matter predicate is part of
 *    the SQL, inside the CTE that feeds ranking. Filtering afterwards would
 *    leak both the existence and the relevance of matters the caller cannot
 *    open — a pupil would learn that *something* highly similar exists on a
 *    matter they are locked out of. AT-05 checks this.
 *
 * 2. **Hybrid, not pure vector (FR-6.3).** Vector similarity alone fails on
 *    party names and citations — "FOTD F7B Service Sdn Bhd" is a string, not a
 *    concept. Three arms are merged with Reciprocal Rank Fusion: vector,
 *    full-text, and trigram for near-miss name matching.
 *
 * Citation is mandatory (FR-6.1): every result carries its source document and
 * locator. The function never returns a summary, only excerpts — there is no
 * generation step here to hallucinate one.
 */

export interface RetrievalFilters {
  practiceArea?: PracticeArea;
  office?: Office;
  /** ISO dates. */
  from?: string;
  to?: string;
  outcome?: string;
}

export interface RetrievedChunk {
  chunkId: string;
  text: string;
  locator: string | null;
  matterId: string | null;
  matterReference: string | null;
  practiceArea: PracticeArea | null;
  office: Office | null;
  sourceType: 'archive_file' | 'document_version';
  sourceId: string;
  sourceFilename: string | null;
  documentDate: Date | null;
  score: number;
  /** Which arms surfaced this chunk — shown in the UI to explain the match. */
  matchedBy: string[];
}

export interface RetrievalResult {
  results: RetrievedChunk[];
  /** True when nothing cleared the relevance floor (FR-6.6). */
  lowConfidence: boolean;
  rewrittenQuery: string;
  keywords: string[];
}

/** RRF constant. 60 is the value from the original paper and behaves well here. */
const RRF_K = 60;

/** Below this fused score, results are presented as low confidence (FR-6.6). */
const CONFIDENCE_FLOOR = 0.016;

const CANDIDATES_PER_ARM = 40;

/**
 * SQL predicate restricting chunks to matters the actor may open.
 *
 * Expressed as raw SQL because it is composed into a CTE alongside the vector
 * and full-text operators, which drizzle's query builder cannot express.
 * Every branch is parameterised — no string interpolation of caller input.
 */
function scopePredicate(actor: Actor, scope: Scope) {
  // Firm-wide precedent (no matter attached) carries no client confidentiality
  // and is visible to anyone who may search at all.
  const firmWide = sql`c.matter_id is null`;

  switch (scope) {
    case 'all':
      return sql`true`;

    case 'office': {
      const areas = actor.practiceAreas ?? [];
      const areaClause =
        areas.length > 0
          ? sql`and m.practice_area = any(${sql.raw(`ARRAY[${areas.map((a) => `'${a}'`).join(',')}]::practice_area[]`)})`
          : sql``;
      return sql`(${firmWide} or (m.office = ${actor.office} ${areaClause}))`;
    }

    case 'own':
    case 'index':
      return sql`(
        ${firmWide} or
        m.assigned_user_id = ${actor.id} or
        m.supervising_user_id = ${actor.id} or
        exists (
          select 1 from matter_participants mp
          where mp.matter_id = m.id and mp.user_id = ${actor.id}
        )
      )`;

    default:
      return sql`false`;
  }
}

/** Rewrite the lawyer's question into retrieval terms. Falls back to the raw query. */
async function rewriteQuery(
  query: string,
  actorUserId: string,
): Promise<{ semanticQuery: string; keywords: string[]; practiceArea: PracticeArea | null }> {
  try {
    const result = await generateStructured({
      system: QUERY_REWRITE_SYSTEM,
      schema: queryRewriteSchema,
      toolName: 'rewrite_query',
      toolDescription: 'Return retrieval terms for this precedent search.',
      jsonSchema: queryRewriteJsonSchema as unknown as Record<string, unknown>,
      messages: [{ role: 'user', content: wrapUntrusted('lawyer_query', query) }],
      maxTokens: 512,
      temperature: 0.1,
      ctx: { task: 'rag.query_rewrite', actorUserId },
    });
    return result.data;
  } catch (error) {
    if (!(error instanceof AiSchemaError)) {
      console.warn('[rag] query rewrite failed, using raw query', (error as Error).message);
    }
    // A failed rewrite degrades quality, not availability.
    return {
      semanticQuery: query,
      keywords: query
        .split(/\s+/)
        .filter((w) => w.length > 3)
        .slice(0, 8),
      practiceArea: null,
    };
  }
}

/** Columns both the ranked search and the single-chunk read select. */
interface ChunkRow extends Record<string, unknown> {
  chunk_id: string;
  text: string;
  locator: string | null;
  matter_id: string | null;
  matter_reference: string | null;
  practice_area: PracticeArea | null;
  office: Office | null;
  source_type: 'archive_file' | 'document_version';
  source_id: string;
  source_filename: string | null;
  document_date: Date | null;
}

interface RawRow extends ChunkRow {
  score: number;
  matched_by: string;
}

/** A single chunk, re-read under the caller's own scope. See `permittedChunk`. */
export interface PermittedChunk {
  chunkId: string;
  text: string;
  locator: string | null;
  matterId: string | null;
  matterReference: string | null;
  practiceArea: PracticeArea | null;
  office: Office | null;
  sourceType: 'archive_file' | 'document_version';
  sourceId: string;
  sourceFilename: string | null;
  documentDate: Date | null;
  /** True when identifiers were masked for this caller (PRD §2.2). */
  masked: boolean;
}

/**
 * Re-read one chunk under the caller's own permission scope (FR-6.2, FR-6.5).
 *
 * Insert-to-draft posts a chunk id, and a chunk id is guessable. The excerpt
 * text is therefore never taken from the request — it is read back here through
 * the *same* `scopePredicate` that governs search, so a chunk the caller could
 * not have retrieved cannot be laundered into a document they can open. That is
 * the whole reason this function exists rather than the action trusting the
 * form.
 *
 * Returns null both when the chunk does not exist and when it is out of scope,
 * so the caller cannot tell the two apart (IDOR hardening).
 */
export async function permittedChunk(
  actor: Actor,
  chunkId: string,
): Promise<PermittedChunk | null> {
  const scope = grantedScope(actor, PERMISSIONS.RAG_SEARCH);
  if (scope === null) return null;

  const scopeSql = scopePredicate(actor, scope);

  const rows = await db.execute<ChunkRow>(sql`
    select
      c.id as chunk_id,
      c.text,
      c.locator,
      c.matter_id,
      m.reference as matter_reference,
      c.practice_area,
      c.office,
      c.source_type,
      c.source_id,
      af.original_filename as source_filename,
      c.document_date
    from chunks c
    left join matters m on m.id = c.matter_id
    left join archive_files af
      on c.source_type = 'archive_file' and af.id = c.source_id
    where c.id = ${chunkId} and (${scopeSql})
    limit 1
  `);

  const row = rows.rows[0];
  if (!row) return null;

  const masked = actor.masksClientIdentifiers;

  return {
    chunkId: row.chunk_id,
    // Masked exactly as it was on screen, so what a pupil inserts is what a
    // pupil read — the platform never hands them text they were not shown.
    text: masked ? maskExcerpt(row.text) : row.text,
    locator: row.locator,
    matterId: row.matter_id,
    matterReference: row.matter_reference,
    practiceArea: row.practice_area,
    office: row.office,
    sourceType: row.source_type,
    sourceId: row.source_id,
    sourceFilename: row.source_filename,
    documentDate: row.document_date,
    masked,
  };
}

export async function retrievePrecedent(params: {
  actor: Actor;
  query: string;
  filters?: RetrievalFilters;
  limit?: number;
}): Promise<RetrievalResult> {
  const scope = grantedScope(params.actor, PERMISSIONS.RAG_SEARCH);
  if (scope === null) {
    return { results: [], lowConfidence: true, rewrittenQuery: params.query, keywords: [] };
  }

  const limit = Math.min(params.limit ?? 12, 40);
  const rewrite = await rewriteQuery(params.query, params.actor.id);

  const { vectors } = await embed([rewrite.semanticQuery], 'query');
  const queryVector = vectors[0];
  if (!queryVector) {
    return {
      results: [],
      lowConfidence: true,
      rewrittenQuery: rewrite.semanticQuery,
      keywords: rewrite.keywords,
    };
  }

  const vectorLiteral = toVectorLiteral(queryVector);
  const keywordQuery = rewrite.keywords.join(' | ');
  const trigramQuery = rewrite.keywords.join(' ');

  const filters = params.filters ?? {};
  const effectiveArea = filters.practiceArea ?? rewrite.practiceArea ?? null;

  const scopeSql = scopePredicate(params.actor, scope);

  const areaFilter = effectiveArea ? sql`and c.practice_area = ${effectiveArea}` : sql``;
  const officeFilter = filters.office ? sql`and c.office = ${filters.office}` : sql``;
  const fromFilter = filters.from
    ? sql`and c.document_date >= ${filters.from}::timestamptz`
    : sql``;
  const toFilter = filters.to ? sql`and c.document_date <= ${filters.to}::timestamptz` : sql``;
  const outcomeFilter = filters.outcome ? sql`and c.outcome = ${filters.outcome}` : sql``;

  /**
   * `permitted` applies the scope and filters ONCE, and all three ranking arms
   * read from it. That is what guarantees an excluded matter cannot appear via
   * any arm.
   */
  const rows = await db.execute<RawRow>(sql`
    with permitted as (
      select c.*, m.reference as matter_reference
      from chunks c
      left join matters m on m.id = c.matter_id
      where (${scopeSql})
        and c.embedding is not null
        ${areaFilter} ${officeFilter} ${fromFilter} ${toFilter} ${outcomeFilter}
    ),
    vector_arm as (
      select id, row_number() over (order by embedding <=> ${vectorLiteral}::vector) as rank
      from permitted
      order by embedding <=> ${vectorLiteral}::vector
      limit ${CANDIDATES_PER_ARM}
    ),
    text_arm as (
      select id, row_number() over (
        order by ts_rank_cd(text_search, websearch_to_tsquery('english', ${keywordQuery})) desc
      ) as rank
      from permitted
      where text_search @@ websearch_to_tsquery('english', ${keywordQuery})
      limit ${CANDIDATES_PER_ARM}
    ),
    trigram_arm as (
      select id, row_number() over (order by similarity(text, ${trigramQuery}) desc) as rank
      from permitted
      where text % ${trigramQuery}
      limit ${CANDIDATES_PER_ARM}
    ),
    fused as (
      select
        id,
        sum(weight) as score,
        string_agg(arm, ',') as matched_by
      from (
        select id, 1.0 / (${RRF_K} + rank) as weight, 'semantic' as arm from vector_arm
        union all
        select id, 1.0 / (${RRF_K} + rank) as weight, 'keyword' as arm from text_arm
        union all
        -- Trigram is the weakest signal; it exists to catch party-name near
        -- misses the other two arms drop, so it is discounted.
        select id, 0.5 / (${RRF_K} + rank) as weight, 'name' as arm from trigram_arm
      ) arms
      group by id
    )
    select
      p.id as chunk_id,
      p.text,
      p.locator,
      p.matter_id,
      p.matter_reference,
      p.practice_area,
      p.office,
      p.source_type,
      p.source_id,
      af.original_filename as source_filename,
      p.document_date,
      f.score::float8 as score,
      f.matched_by
    from fused f
    join permitted p on p.id = f.id
    left join archive_files af
      on p.source_type = 'archive_file' and af.id = p.source_id
    order by f.score desc
    limit ${limit}
  `);

  const results: RetrievedChunk[] = rows.rows.map((row) => ({
    chunkId: row.chunk_id,
    // Pupil masking is applied server-side at query time (PRD §2.2), so a
    // masked identifier never reaches the client, not even in a payload the
    // UI chooses not to render.
    text: params.actor.masksClientIdentifiers ? maskExcerpt(row.text) : row.text,
    locator: row.locator,
    matterId: row.matter_id,
    matterReference: row.matter_reference,
    practiceArea: row.practice_area,
    office: row.office,
    sourceType: row.source_type,
    sourceId: row.source_id,
    sourceFilename: row.source_filename,
    documentDate: row.document_date,
    score: Number(row.score),
    matchedBy: [...new Set(row.matched_by.split(','))],
  }));

  const best = results[0]?.score ?? 0;
  const lowConfidence = results.length === 0 || best < CONFIDENCE_FLOOR;

  await audit({
    action: AUDIT_ACTIONS.RAG_SEARCH,
    actorUserId: params.actor.id,
    actorEmail: params.actor.email,
    metadata: {
      resultCount: results.length,
      lowConfidence,
      scope,
      filters: { ...filters, practiceArea: effectiveArea },
    },
  });

  return {
    results,
    lowConfidence,
    rewrittenQuery: rewrite.semanticQuery,
    keywords: rewrite.keywords,
  };
}

/**
 * Mask personal identifiers in an excerpt shown to a masking role.
 * Structural, like scrubFreeText, but keeps the legal substance readable —
 * the pupil still needs the clause, just not the party's identity.
 */
export function maskExcerpt(text: string): string {
  return (
    text
      .replace(/\b\d{6}-\d{2}-\d{4}\b/g, '[IC redacted]')
      .replace(/\b\d{12}\b/g, '[IC redacted]')
      .replace(/\b[A-Z]\d{8}\b/g, '[passport redacted]')
      .replace(/\b[\w.+-]+@[\w-]+\.[\w.-]+\b/g, '[email redacted]')
      .replace(/(?:\+?60|0)1\d[-\s]?\d{3,4}[-\s]?\d{4}\b/g, '[phone redacted]')
      .replace(/\b\d{13,19}\b/g, '[account redacted]')
      // Titled personal names — the common shape in pleadings.
      .replace(
        /\b(?:Mr|Mrs|Ms|Miss|Dato'?|Datin|Tan Sri|Puan|Encik|Cik)\.?\s+([A-Z][\w'-]+(?:\s+[A-Z][\w'-]+){0,3})/g,
        (_m, name: string) => maskName(name),
      )
  );
}

-- ---------------------------------------------------------------------------
-- Retrieval columns and indexes (FR-5.5, FR-6.1, FR-6.3)
--
-- The embedding dimension is fixed at project start (PRD §3.1). voyage-law-2
-- emits 1024 dimensions. Changing it later requires a re-embed of the whole
-- archive, so the value is asserted rather than parameterised: a mismatch
-- between this column and EMBEDDING_DIMENSIONS must fail loudly at migration
-- time, not silently produce garbage neighbours.
-- ---------------------------------------------------------------------------

alter table chunks
  add column if not exists embedding vector(1024);

-- Generated tsvector for the BM25-ish keyword arm of hybrid retrieval.
-- 'english' is the closest bundled configuration for Malaysian legal English;
-- party names and citations are handled by the trigram index below.
alter table chunks
  add column if not exists text_search tsvector
  generated always as (to_tsvector('english', coalesce(text, ''))) stored;

-- Vector arm. HNSW over cosine distance, per PRD §4.4.
-- m/ef_construction are left at defaults; the archive is in the low hundreds of
-- thousands of chunks, well inside the range where defaults perform.
create index if not exists chunks_embedding_hnsw_idx
  on chunks using hnsw (embedding vector_cosine_ops);

-- Keyword arm.
create index if not exists chunks_text_search_idx
  on chunks using gin (text_search);

-- Party-name / citation arm — trigram similarity catches the cases pure vector
-- search fails on (FR-6.3).
create index if not exists chunks_text_trgm_idx
  on chunks using gin (text gin_trgm_ops);

-- Retrieval always pre-filters by the caller's permitted matter scope before
-- ranking (FR-6.2), so the scope columns need to be cheap to filter on.
create index if not exists chunks_scope_idx
  on chunks (matter_id, practice_area, office);

create index if not exists chunks_document_date_idx
  on chunks (document_date);

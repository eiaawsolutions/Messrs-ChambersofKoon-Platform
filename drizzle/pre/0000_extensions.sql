-- Extensions must exist before any table DDL or index creation.

-- pgvector: embeddings for RAG precedent retrieval (PRD §3.1, §4.4).
create extension if not exists vector;

-- pg_trgm: trigram similarity, used to fuzzy-match party names in hybrid
-- retrieval where BM25 alone misses transliteration variants
-- ("Sdn. Bhd." vs "Sdn Bhd").
create extension if not exists pg_trgm;

-- Deterministic UUID generation for seeds and idempotency keys.
create extension if not exists pgcrypto;

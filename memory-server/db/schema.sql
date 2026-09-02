
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS knowledge_sources (
    source_id       UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    file_path       TEXT NOT NULL,
    file_hash       TEXT NOT NULL,
    file_size       BIGINT,

    source_type     TEXT NOT NULL,

    language        TEXT,

    ingested_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    ingested_by     TEXT NOT NULL,

    parent_source   UUID REFERENCES knowledge_sources(source_id),

    metadata        JSONB NOT NULL DEFAULT '{}'::jsonb,

    CONSTRAINT knowledge_sources_hash_unique UNIQUE (file_hash)
);

CREATE INDEX IF NOT EXISTS idx_sources_type
    ON knowledge_sources(source_type);
CREATE INDEX IF NOT EXISTS idx_sources_ingested_at
    ON knowledge_sources(ingested_at DESC);
CREATE INDEX IF NOT EXISTS idx_sources_parent
    ON knowledge_sources(parent_source);
CREATE INDEX IF NOT EXISTS idx_sources_metadata
    ON knowledge_sources USING gin(metadata);

CREATE TABLE IF NOT EXISTS primary_indices (
    chunk_id        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    source_id       UUID NOT NULL
        REFERENCES knowledge_sources(source_id) ON DELETE CASCADE,

    chunk_seq       INT  NOT NULL,
    start_offset    INT  NOT NULL,
    end_offset      INT  NOT NULL,

    text            TEXT NOT NULL,
    text_hash       TEXT NOT NULL,
    token_count     INT,

    embedding       vector(768),
    embedded_at     TIMESTAMPTZ,
    embedding_model TEXT,

    CONSTRAINT primary_indices_seq_unique UNIQUE (source_id, chunk_seq),
    CONSTRAINT primary_indices_offsets_valid CHECK (end_offset > start_offset)
);

CREATE INDEX IF NOT EXISTS idx_primary_embedding
    ON primary_indices USING ivfflat (embedding vector_cosine_ops)
    WITH (lists = 100);

CREATE INDEX IF NOT EXISTS idx_primary_source
    ON primary_indices(source_id);
CREATE INDEX IF NOT EXISTS idx_primary_pending_embed
    ON primary_indices(source_id) WHERE embedding IS NULL;

CREATE TABLE IF NOT EXISTS entity_mentions (
    mention_id      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    chunk_id        UUID NOT NULL
        REFERENCES primary_indices(chunk_id) ON DELETE CASCADE,

    entity_text     TEXT NOT NULL,
    entity_type     TEXT,

    start_offset    INT,
    end_offset      INT,

    confidence      REAL,
    extracted_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    extracted_by    TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_mentions_chunk
    ON entity_mentions(chunk_id);
CREATE INDEX IF NOT EXISTS idx_mentions_text_lower
    ON entity_mentions(LOWER(entity_text));
CREATE INDEX IF NOT EXISTS idx_mentions_type
    ON entity_mentions(entity_type);

CREATE TABLE IF NOT EXISTS ingest_audit (
    audit_id        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    occurred_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    file_path       TEXT,
    file_hash       TEXT,
    source_id       UUID,
    ingested_by     TEXT,
    result          TEXT NOT NULL,
    error_message   TEXT,
    chunks_created  INT
);

CREATE INDEX IF NOT EXISTS idx_audit_time
    ON ingest_audit(occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_result
    ON ingest_audit(result);

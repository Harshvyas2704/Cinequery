-- Movie embeddings and the log of every LLM and embedding call (PLAN.md section 6).

CREATE TABLE movie_embeddings (
  movie_id     integer NOT NULL REFERENCES movies(id) ON DELETE CASCADE,
  model        text NOT NULL,
  -- Hash of the embedded text plus model and dimensions. A matching hash means
  -- the stored vector is still right and the movie is skipped.
  content_hash text NOT NULL,
  -- 768 dimensions (D-021). EMBEDDING_DIMENSIONS in config must match; the embed
  -- job checks this before it starts.
  embedding    vector(768) NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (movie_id, model)
);

-- Approximate nearest neighbour search by cosine distance (the <=> operator).
CREATE INDEX movie_embeddings_hnsw_idx
  ON movie_embeddings USING hnsw (embedding vector_cosine_ops);

CREATE TABLE llm_calls (
  id             bigserial PRIMARY KEY,
  request_id     text,
  stage          text NOT NULL,               -- parse, embed_query, embed_batch, pick, tag
  model          text NOT NULL,
  prompt_version text,
  input_tokens   integer,
  output_tokens  integer,
  latency_ms     integer NOT NULL,
  status         text NOT NULL,               -- ok, timeout, rate_limited, invalid_output, error
  created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX llm_calls_created_at_idx ON llm_calls (created_at);

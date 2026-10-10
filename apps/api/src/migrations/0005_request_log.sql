-- One row per recommend request, for GET /api/stats (D-049). The request text
-- is deliberately not stored: this is a log of how requests went, not of what
-- people asked for.
CREATE TABLE request_log (
  id          bigserial PRIMARY KEY,
  request_id  text NOT NULL,                 -- the same id as in llm_calls and x-request-id
  route       text NOT NULL,                 -- recommend, recommend_stream
  outcome     text NOT NULL,                 -- ok, error, cancelled
  cached      boolean NOT NULL,              -- answered without any LLM call
  results     integer NOT NULL,
  total_ms    integer NOT NULL,
  stages      jsonb NOT NULL,                -- [{ "name": "parse", "ms": 12, "status": "ok" }, ...]
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX request_log_created_at_idx ON request_log (created_at);

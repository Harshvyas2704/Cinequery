-- Finding a movie by a title someone typed ("like Inception", Phase 6).
-- pg_trgm compares strings by their three-letter pieces, so a small typo or a
-- missing "The" still finds the film. The index makes that fast.
CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE INDEX movies_title_trgm_idx ON movies USING gin (lower(title) gin_trgm_ops);

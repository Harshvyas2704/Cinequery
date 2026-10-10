-- The catalog, its tags and the numbers behind the weighted rating (PLAN.md section 6).

-- array_to_string is only STABLE in Postgres (for some element types its output
-- depends on settings), so a generated column cannot call it. For text[] the
-- result never changes, which this wrapper states.
CREATE FUNCTION text_array_to_string(text[], text) RETURNS text
  LANGUAGE sql IMMUTABLE PARALLEL SAFE
  RETURN array_to_string($1, $2);

CREATE TABLE movies (
  id              serial PRIMARY KEY,
  tmdb_id         integer UNIQUE NOT NULL,
  title           text NOT NULL,
  overview        text NOT NULL,
  tagline         text,
  genres          text[] NOT NULL,
  keywords        text[] NOT NULL DEFAULT '{}',
  release_year    integer,
  runtime_minutes integer,
  language        text,
  vote_average    numeric(4,2),
  vote_count      integer NOT NULL DEFAULT 0,
  popularity      numeric,
  poster_path     text,
  imdb_id         text,
  -- Full-text search: title counts most (A), then keywords (B), then tagline and overview (C).
  search_tsv      tsvector GENERATED ALWAYS AS (
                    setweight(to_tsvector('english', title), 'A') ||
                    setweight(to_tsvector('english', text_array_to_string(keywords, ' ')), 'B') ||
                    setweight(to_tsvector('english', coalesce(tagline, '') || ' ' || overview), 'C')
                  ) STORED,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX movies_search_tsv_idx   ON movies USING gin (search_tsv);
CREATE INDEX movies_genres_idx       ON movies USING gin (genres);
CREATE INDEX movies_keywords_idx     ON movies USING gin (keywords);
CREATE INDEX movies_release_year_idx ON movies (release_year);
CREATE INDEX movies_vote_count_idx   ON movies (vote_count);
CREATE INDEX movies_language_idx     ON movies (language);

CREATE TABLE movie_tags (
  movie_id   integer NOT NULL REFERENCES movies(id) ON DELETE CASCADE,
  tag        text NOT NULL,
  relevance  real NOT NULL,
  source     text NOT NULL DEFAULT 'genome',   -- 'genome' or 'llm' (Phase 10)
  PRIMARY KEY (movie_id, tag)
);

-- "Which movies have this tag, most relevant first."
CREATE INDEX movie_tags_tag_relevance_idx ON movie_tags (tag, relevance DESC);

-- One row: the inputs of the weighted rating. The id column makes a second row impossible.
CREATE TABLE rating_stats (
  id                boolean PRIMARY KEY DEFAULT true CHECK (id),
  mean_vote_average numeric NOT NULL,          -- C
  min_votes         integer NOT NULL,          -- m
  computed_at       timestamptz NOT NULL DEFAULT now()
);

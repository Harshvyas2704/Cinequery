-- Prepares the catalog and its tags from the raw datasets (PLAN.md Phase 1).
--
--   in:  data/raw/TMDB_movie_dataset_v11.csv            (bash scripts/download-data.sh)
--        data/raw/ml-25m/{genome-scores,genome-tags,links}.csv
--        packages/shared/src/curated-tags.json
--   out: data/clean/movies.parquet
--        data/clean/movie_tags.parquet
--
-- Run from the repo root:   duckdb < scripts/prepare-data.sql
-- It can be rerun at any time. The same inputs give byte-identical outputs.

.bail on
.maxrows 60

-- ---------------------------------------------------------------------------
-- Settings. Change them here, nowhere else. Reasons are in DECISIONS.md.
-- ---------------------------------------------------------------------------
SET VARIABLE min_votes = 50;                 -- D-031: minimum vote_count
SET VARIABLE min_votes_lower = 20;           -- D-032: for the languages below
SET VARIABLE lower_threshold_languages = ['hi', 'ta', 'te', 'ml', 'kn', 'bn', 'mr'];
SET VARIABLE min_tag_relevance = 0.5;        -- D-015
SET VARIABLE top_tags_per_movie = 25;        -- D-015
SET VARIABLE keep_curated_tags = true;       -- D-033: also keep curated tags below the top 25

-- ---------------------------------------------------------------------------
.print
.print == 1. Raw TMDB file ==
-- ---------------------------------------------------------------------------
CREATE TEMP TABLE raw_movies AS
SELECT *
FROM read_csv(
  'data/raw/TMDB_movie_dataset_v11.csv',
  header = true,
  types = {
    'id': 'INTEGER', 'vote_count': 'INTEGER', 'vote_average': 'DOUBLE', 'popularity': 'DOUBLE',
    'runtime': 'INTEGER', 'adult': 'BOOLEAN', 'release_date': 'DATE'
  }
);

SELECT column_name, column_type FROM (DESCRIBE raw_movies);

SELECT
  count(*)                                            AS raw_rows,
  count(DISTINCT id)                                  AS distinct_ids,
  count(*) - count(DISTINCT id)                       AS duplicate_rows,
  count(*) FILTER (status <> 'Released')              AS not_released,
  count(*) FILTER (adult)                             AS adult,
  count(*) FILTER (trim(coalesce(overview, '')) = '') AS no_overview
FROM raw_movies;

-- Every filter from PLAN.md 5.2 except the vote count, with duplicate ids removed
-- (the row with the most votes wins).
CREATE TEMP TABLE eligible AS
SELECT *
FROM raw_movies
WHERE status = 'Released'
  AND NOT adult
  AND trim(coalesce(overview, '')) <> ''
  AND trim(coalesce(title, '')) <> ''
QUALIFY row_number() OVER (
  PARTITION BY id
  ORDER BY vote_count DESC, popularity DESC, release_date DESC NULLS LAST, title
) = 1;

-- ---------------------------------------------------------------------------
.print
.print == 2. Catalog size at each vote threshold ==
-- ---------------------------------------------------------------------------
SELECT
  count(*)                              AS eligible,
  count(*) FILTER (vote_count >= 20)    AS votes_20,
  count(*) FILTER (vote_count >= 50)    AS votes_50,
  count(*) FILTER (vote_count >= 100)   AS votes_100,
  count(*) FILTER (vote_count >= 200)   AS votes_200,
  max(release_date) FILTER (vote_count >= 50) AS newest_release
FROM eligible;

-- ---------------------------------------------------------------------------
.print
.print == 3. Movies by original language at each threshold ==
-- ---------------------------------------------------------------------------
.print Top 15 languages:
SELECT
  original_language                     AS language,
  count(*) FILTER (vote_count >= 20)    AS votes_20,
  count(*) FILTER (vote_count >= 50)    AS votes_50,
  count(*) FILTER (vote_count >= 100)   AS votes_100,
  count(*) FILTER (vote_count >= 200)   AS votes_200
FROM eligible
GROUP BY 1
ORDER BY votes_50 DESC, language
LIMIT 15;

.print Languages that get the lower threshold:
SELECT
  original_language                     AS language,
  count(*) FILTER (vote_count >= 20)    AS votes_20,
  count(*) FILTER (vote_count >= 50)    AS votes_50,
  count(*) FILTER (vote_count >= 100)   AS votes_100,
  count(*) FILTER (vote_count >= 200)   AS votes_200
FROM eligible
WHERE list_contains(getvariable('lower_threshold_languages'), original_language)
GROUP BY 1
ORDER BY votes_50 DESC, language;

-- ---------------------------------------------------------------------------
.print
.print == 5. Export data/clean/movies.parquet ==
-- ---------------------------------------------------------------------------
-- (Step 4, missing data, is reported below on the catalog that was exported.)
CREATE TEMP TABLE catalog AS
SELECT
  id                                  AS tmdb_id,
  trim(title)                         AS title,
  trim(overview)                      AS overview,
  nullif(trim(tagline), '')           AS tagline,
  coalesce(trim(genres), '')          AS genres,       -- comma-separated; split at ingest
  nullif(trim(keywords), '')          AS keywords,     -- comma-separated; split at ingest
  year(release_date)::INTEGER         AS release_year,
  nullif(runtime, 0)                  AS runtime_minutes,
  original_language                   AS language,
  vote_average,
  vote_count,
  popularity,
  nullif(trim(poster_path), '')       AS poster_path,
  nullif(trim(imdb_id), '')           AS imdb_id
FROM eligible
WHERE vote_count >= CASE
  WHEN list_contains(getvariable('lower_threshold_languages'), original_language)
    THEN getvariable('min_votes_lower')
  ELSE getvariable('min_votes')
END;

.shell mkdir -p data/clean
COPY (SELECT * FROM catalog ORDER BY tmdb_id)
  TO 'data/clean/movies.parquet' (FORMAT parquet, COMPRESSION zstd);

SELECT
  count(*)                            AS catalog_movies,
  min(release_year)                   AS oldest_year,
  max(release_year)                   AS newest_year,
  count(*) FILTER (release_year >= 2015) AS from_2015_on
FROM catalog;

.print Catalog by language (top 15):
SELECT language, count(*) AS movies, round(100.0 * count(*) / sum(count(*)) OVER (), 1) AS percent
FROM catalog
GROUP BY 1
ORDER BY movies DESC, language
LIMIT 15;

-- ---------------------------------------------------------------------------
.print
.print == 4. Missing data in the catalog ==
-- ---------------------------------------------------------------------------
SELECT
  count(*)                                    AS movies,
  count(*) FILTER (genres = '')               AS no_genres,
  count(*) FILTER (keywords IS NULL)          AS no_keywords,
  count(*) FILTER (tagline IS NULL)           AS no_tagline,
  count(*) FILTER (poster_path IS NULL)       AS no_poster,
  count(*) FILTER (runtime_minutes IS NULL)   AS no_runtime,
  count(*) FILTER (release_year IS NULL)      AS no_release_date,
  count(*) FILTER (imdb_id IS NULL)           AS no_imdb_id,
  round(100.0 * count(poster_path) / count(*), 2) AS percent_with_poster
FROM catalog;

-- ---------------------------------------------------------------------------
.print
.print == 6. Curated tags exist in the Tag Genome ==
-- ---------------------------------------------------------------------------
CREATE TEMP TABLE genome_tags AS
SELECT tagId AS tag_id, tag FROM read_csv('data/raw/ml-25m/genome-tags.csv', header = true);

CREATE TEMP TABLE curated AS
SELECT tag AS curated_tag, "group" AS tag_group, unnest(genomeTags) AS genome_tag
FROM read_json('packages/shared/src/curated-tags.json');

SELECT
  count(DISTINCT curated_tag)                 AS curated_tags,
  count(*)                                    AS genome_tags_mapped,
  (SELECT count(*) FROM genome_tags)          AS genome_tags_total,
  count(*) FILTER (genome_tag NOT IN (SELECT tag FROM genome_tags)) AS missing_from_genome
FROM curated;

-- Stops the script if the curated list names a tag the genome does not have,
-- or maps one genome tag to two curated tags.
-- (A passing check returns no rows, so its empty result is not printed.)
.output /dev/null
SELECT error('Not a Tag Genome tag: ' || string_agg(genome_tag, ', '))
FROM curated
WHERE genome_tag NOT IN (SELECT tag FROM genome_tags)
HAVING count(*) > 0;

SELECT error('Genome tag mapped more than once: ' || string_agg(genome_tag, ', '))
FROM (SELECT genome_tag FROM curated GROUP BY 1 HAVING count(*) > 1)
HAVING count(*) > 0;
.output

-- ---------------------------------------------------------------------------
.print
.print == 7. Export data/clean/movie_tags.parquet ==
-- ---------------------------------------------------------------------------
-- genome-scores has a score for every (movie, tag) pair: 13,816 movies x 1,128 tags.
-- MovieLens ids become TMDB ids through links.csv. A few TMDB ids have two
-- MovieLens entries; the higher relevance wins.
CREATE TEMP TABLE relevant AS
SELECT
  links.tmdbId::INTEGER               AS tmdb_id,
  genome_tags.tag,
  max(scores.relevance)               AS relevance
FROM read_csv('data/raw/ml-25m/genome-scores.csv', header = true) AS scores
JOIN read_csv('data/raw/ml-25m/links.csv', header = true) AS links USING (movieId)
JOIN genome_tags ON genome_tags.tag_id = scores.tagId
WHERE scores.relevance >= getvariable('min_tag_relevance')
  AND links.tmdbId IN (SELECT tmdb_id FROM catalog)
GROUP BY 1, 2;

CREATE TEMP TABLE ranked AS
SELECT
  *,
  row_number() OVER (PARTITION BY tmdb_id ORDER BY relevance DESC, tag) AS tag_rank,
  tag IN (SELECT genome_tag FROM curated) AS is_curated
FROM relevant;

CREATE TEMP TABLE movie_tags AS
SELECT tmdb_id, tag, round(relevance, 4)::FLOAT AS relevance
FROM ranked
WHERE tag_rank <= getvariable('top_tags_per_movie')
   OR (getvariable('keep_curated_tags') AND is_curated);

COPY (SELECT * FROM movie_tags ORDER BY tmdb_id, relevance DESC, tag)
  TO 'data/clean/movie_tags.parquet' (FORMAT parquet, COMPRESSION zstd);

SELECT
  (SELECT count(*) FROM catalog)              AS catalog_movies,
  count(DISTINCT tmdb_id)                     AS movies_with_tags,
  round(100.0 * count(DISTINCT tmdb_id) / (SELECT count(*) FROM catalog), 1) AS percent_with_tags,
  count(*)                                    AS tag_rows,
  round(count(*) / count(DISTINCT tmdb_id), 1) AS avg_tags_per_movie
FROM movie_tags;

.print What each rule keeps (rows at relevance 0.5 or more):
SELECT
  count(*)                                              AS all_rows,
  count(*) FILTER (tag_rank <= getvariable('top_tags_per_movie')) AS top_n_only,
  count(*) FILTER (is_curated)                          AS curated_rows,
  count(*) FILTER (is_curated AND tag_rank <= getvariable('top_tags_per_movie')) AS curated_inside_top_n,
  count(*) FILTER (tag_rank <= getvariable('top_tags_per_movie') OR is_curated) AS top_n_plus_curated
FROM ranked;

.print Tag coverage by release decade (the genome ends in 2019):
SELECT
  (release_year // 10) * 10                   AS decade_start,
  count(*)                                    AS movies,
  count(*) FILTER (tmdb_id IN (SELECT tmdb_id FROM movie_tags)) AS with_tags,
  round(100.0 * count(*) FILTER (tmdb_id IN (SELECT tmdb_id FROM movie_tags)) / count(*)) AS percent
FROM catalog
WHERE release_year >= 1950
GROUP BY 1
ORDER BY 1;

.print Tag coverage for the lower-threshold languages:
SELECT
  language,
  count(*)                                    AS movies,
  count(*) FILTER (tmdb_id IN (SELECT tmdb_id FROM movie_tags)) AS with_tags
FROM catalog
WHERE list_contains(getvariable('lower_threshold_languages'), language)
GROUP BY 1
ORDER BY movies DESC, language;

.print Movies per curated tag (any mapped genome tag at 0.5 or more):
SELECT
  curated.tag_group,
  curated.curated_tag,
  count(DISTINCT movie_tags.tmdb_id)          AS movies
FROM curated
LEFT JOIN movie_tags ON movie_tags.tag = curated.genome_tag
GROUP BY 1, 2
ORDER BY 1, movies DESC;

-- ---------------------------------------------------------------------------
.print
.print == 8. Spot checks ==
-- ---------------------------------------------------------------------------
SELECT tmdb_id, title, release_year, language, vote_count, runtime_minutes, genres
FROM catalog
WHERE tmdb_id IN (11324, 27205, 20453)        -- Shutter Island, Inception, 3 Idiots
ORDER BY title;

.print Their curated tags (best genome tag per curated tag):
SELECT
  catalog.title,
  string_agg(tags.curated_tag || ' ' || tags.relevance, ', ' ORDER BY tags.relevance DESC) AS curated_tags
FROM catalog
JOIN (
  SELECT movie_tags.tmdb_id, curated.curated_tag, round(max(movie_tags.relevance), 2) AS relevance
  FROM movie_tags
  JOIN curated ON curated.genome_tag = movie_tags.tag
  GROUP BY 1, 2
) AS tags USING (tmdb_id)
WHERE tmdb_id IN (11324, 27205, 20453)
GROUP BY 1
ORDER BY 1;

.print Top "twist ending" movies from 2005 on:
SELECT catalog.title, catalog.release_year, round(max(movie_tags.relevance), 2) AS relevance
FROM movie_tags
JOIN curated ON curated.genome_tag = movie_tags.tag
JOIN catalog USING (tmdb_id)
WHERE curated.curated_tag = 'twist ending' AND catalog.release_year >= 2005
GROUP BY catalog.tmdb_id, catalog.title, catalog.release_year
ORDER BY relevance DESC, catalog.title
LIMIT 10;

-- ---------------------------------------------------------------------------
.print
.print == Checks on the exported files ==
-- ---------------------------------------------------------------------------
-- Each one stops the script with an error if the files are not what PLAN.md 5.3 describes.
.output /dev/null
SELECT error('movies.parquet: duplicate tmdb_id')
FROM 'data/clean/movies.parquet' HAVING count(*) <> count(DISTINCT tmdb_id);

SELECT error('movies.parquet: empty title, overview or language')
FROM 'data/clean/movies.parquet'
WHERE title IS NULL OR title = '' OR overview IS NULL OR overview = '' OR language IS NULL
HAVING count(*) > 0;

SELECT error('movie_tags.parquet: tag for a movie outside the catalog')
FROM 'data/clean/movie_tags.parquet'
WHERE tmdb_id NOT IN (SELECT tmdb_id FROM 'data/clean/movies.parquet')
HAVING count(*) > 0;

SELECT error('movie_tags.parquet: relevance outside ' || getvariable('min_tag_relevance') || ' to 1')
FROM 'data/clean/movie_tags.parquet'
WHERE relevance < getvariable('min_tag_relevance') OR relevance > 1
HAVING count(*) > 0;

SELECT error('movie_tags.parquet: duplicate (tmdb_id, tag)')
FROM 'data/clean/movie_tags.parquet' HAVING count(*) <> count(DISTINCT (tmdb_id, tag));
.output

SELECT
  (SELECT count(*) FROM 'data/clean/movies.parquet')      AS movies_rows,
  (SELECT count(*) FROM 'data/clean/movie_tags.parquet')  AS movie_tags_rows,
  'all checks passed'                                     AS result;

.print Schema of data/clean/movies.parquet:
SELECT column_name, column_type FROM (DESCRIBE SELECT * FROM 'data/clean/movies.parquet');
.print Schema of data/clean/movie_tags.parquet:
SELECT column_name, column_type FROM (DESCRIBE SELECT * FROM 'data/clean/movie_tags.parquet');

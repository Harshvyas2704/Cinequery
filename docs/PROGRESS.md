# Progress

What has been built, what was measured and what was put off, phase by phase.
The plan is in `PLAN.md`; the reasons behind choices are in `DECISIONS.md`.

## Phases

- [x] Phase 0: Project setup
- [x] Phase 1: Data preparation (DuckDB)
- [x] Phase 2: Ingestion into Postgres
- [x] Phase 3: Baseline search without AI
- [x] Phase 4: LLM provider and embeddings pipeline (prototype scope: 980 of 28,725 movies embedded, D-041)
- [x] Phase 5: Semantic search
- [ ] Phase 6: Query understanding (parse)
- [ ] Phase 7: Pick, reasons and streaming
- [ ] Phase 8: Production concerns
- [ ] Phase 9: Evaluation
- [ ] Phase 10: LLM tag fallback (only if evaluation shows a need)
- [ ] Phase 11: Deploy V1

## Phase 0: Project setup

Status on 2026-10-10: done. The only thing not yet seen is the first GitHub
Actions run, which happens on the first push.

### Built

- Node 24 LTS (`.nvmrc`, `engines`), pnpm workspace with `apps/api`, `apps/web`
  and `packages/shared`. TypeScript strict, ESLint, Vitest.
- `apps/api/src/config/env.ts`: reads the root `.env`, validates it with Zod and
  lists every problem at once without printing any values.
- Migration runner (`pnpm db:migrate`) and `0001_enable_vector.sql` (D-028).
- `GET /api/health`: Postgres, pgvector version and Redis reported separately.
  200 when all are up, 503 otherwise. Each check has a timeout.
- Errors use the shape `{ error: { code, message } }`, including 404s.
- Web status page that calls `/api/health` through the Vite dev proxy.
- `packages/shared`: the Zod schema for the health response, used by both sides.
- ESLint rule that rejects a Gemini SDK import outside `apps/api/src/llm`.
- GitHub Actions workflow: lint, typecheck, unit tests.

### Commands

| Command          | What it does                                                    |
| ---------------- | --------------------------------------------------------------- |
| `pnpm dev`       | API on port 3000, web on 5173, shared package rebuilt on change |
| `pnpm test`      | All tests. Needs local Postgres (`movies_test`) and Redis       |
| `pnpm test:unit` | Tests that need no services. This is what CI runs               |
| `pnpm lint`      | ESLint                                                          |
| `pnpm typecheck` | TypeScript in every package                                     |
| `pnpm build`     | Builds every package                                            |
| `pnpm db:migrate`| Applies pending migrations to `DATABASE_URL`                    |
| `pnpm ingest`    | Loads `data/clean/*.parquet` into Postgres (Phase 2)            |
| `pnpm embed`     | Embeds movies that have no current vector (Phase 4)             |
| `pnpm embed:status` | Coverage, queue and failed batches                           |
| `pnpm embed:export` / `embed:import` | Moves embeddings between databases through a file |

Integration tests are the files named `*.int.test.ts`.

### Checked

| Check                                                    | Result                                            |
| -------------------------------------------------------- | ------------------------------------------------- |
| `pnpm lint`, `pnpm typecheck`, `pnpm build`              | Pass                                              |
| `pnpm test` (unit and integration)                       | 25 tests pass (3 shared, 22 API)                  |
| `pnpm db:migrate` on `movies`                            | 1 applied; a second run applies 0                 |
| Migration integration tests on `movies_test`             | Pass                                              |
| API started with `DATABASE_URL` empty                    | Exits with code 1 and "DATABASE_URL is required"  |
| `/api/health` through the Vite proxy, Redis stopped      | 503; Postgres ok, pgvector 0.8.7, Redis unreachable |
| `/api/health` through the Vite proxy, everything running | 200; Postgres ok, pgvector 0.8.7, Redis ok        |
| Status page looked at in a browser                       | Not yet: open http://localhost:5173 under `pnpm dev` |
| GitHub Actions workflow                                  | Not run yet: runs on the first push               |

Local versions: Node 24.21.0, pnpm 12.8.1, PostgreSQL 18.6, pgvector 0.8.7, Redis 8.10.2.

### Left to confirm

- Push the branch and confirm the CI run passes.

### Notes

- This machine has two Homebrews. The `brew` on the `PATH` is the Intel build
  under `/usr/local`; Postgres 18 and pgvector come from it. It has no prebuilt
  packages for current formulae, so `brew install redis` there compiles LLVM
  and Rust from source. Redis was installed with the native one instead:
  `/opt/homebrew/bin/brew install redis`, started with
  `/opt/homebrew/bin/brew services start redis`. Use that one for DuckDB in
  Phase 1 too.
- pnpm holds back packages published in the last day. Express resolved to 5.2.1
  and `@types/node` to 24.19.1 for that reason, instead of versions released on
  2026-10-09.
- `esbuild` is the only dependency allowed to run an install script
  (`allowBuilds` in `pnpm-workspace.yaml`). `tsx` needs it.
- The shared package is compiled to `dist`, and the root scripts build it first.

### Deferred

- Request IDs, rate limits, graceful shutdown and log redaction: Phase 8.
- Web tests: none yet. The page is one fetch; tests come with the search page in Phase 3.
- Integration tests in CI: Phase 11, with service containers.

## Phase 1: Data preparation (DuckDB)

Status on 2026-10-10: done.

### Built

- `scripts/download-data.sh`: downloads the two raw datasets into `data/raw`
  and skips what is already there.
- `scripts/prepare-data.sql`: inspects the raw data, filters the catalog, joins
  the Tag Genome and writes `data/clean/movies.parquet` and
  `data/clean/movie_tags.parquet`. Settings are at the top of the file. It ends
  with checks that stop the script if the output is wrong.
- `packages/shared/src/curated-tags.json`: the 47 curated tags and the genome
  tags behind each (D-034).

### How to run

```bash
bash scripts/download-data.sh          # about 790 MB, once
duckdb < scripts/prepare-data.sql      # about 2 seconds
```

### Decided

- 50 votes minimum (D-031); 20 for seven Indian languages (D-032).
- Tags stored: top 25 per movie plus every curated tag (D-033).
- Curated tag list approved (D-034).

### Measured

| What                                         | Number                          |
| -------------------------------------------- | ------------------------------- |
| Raw rows                                     | 1,142,342 (766 duplicate ids)   |
| Left after status, adult and overview filters| 803,324                         |
| Catalog                                      | 28,725 movies                   |
| Release years                                | 1874 to 2023 (newest 2023-09-29)|
| Movies with a poster                         | 28,708 (99.94%)                 |
| Movies with no keywords                      | 4,320 (15%)                     |
| Movies with no tagline                       | 10,553 (37%)                    |
| Movies with no runtime / year / genres       | 57 / 2 / 24                     |
| Movies with genome tags                      | 12,085 (42.1%)                  |
| `movie_tags` rows                            | 332,167 (27.5 per tagged movie) |
| `movies.parquet` / `movie_tags.parquet`      | 9.3 MB / 1.1 MB (Snappy, D-035) |

Catalog by language: en 18,262; fr 2,379; it 1,375; ja 1,063; es 981; hi 826;
de 527; ko 407; zh 329; ru 297; cn 252; pt 246; ta 230; ml 171; tr 164;
te 92; bn 31; kn 12; mr 4.

Share of movies with genome tags, by release decade:

| Decade | Movies | With tags |
| ------ | ------ | --------- |
| 1980s  | 2,030  | 66%       |
| 1990s  | 2,935  | 71%       |
| 2000s  | 5,673  | 58%       |
| 2010s  | 10,844 | 29%       |
| 2020s  | 3,107  | 0%        |

Running the script twice from scratch gave files with the same SHA-256.

Spot checks: Shutter Island, Inception and 3 Idiots are in the catalog. Shutter
Island has "twist ending" at 0.99 and Inception at 0.94. The top "twist ending"
films from 2005 on are The Invisible Guest, Gone Girl, The Prestige, Shutter
Island.

### Things to know for later phases

- **Recent films have no tags.** The genome stops in 2019, so no film from the
  2020s and only 29% from the 2010s has tags. A request like "twist ending,
  not too old" can only boost tagged films. Vector search (Phase 5) covers part
  of this; Phase 9 should measure it, and it is the case for Phase 10.
- **Indian films have almost no tags**: 85 of the 1,366 films in the seven
  languages.
- **The catalog stops in September 2023.** The TMDB file is a snapshot.
- DuckDB 1.5.6 was installed with `/opt/homebrew/bin/brew install duckdb`.

### Deferred

- Nothing from this phase.

## Phase 2: Ingestion into Postgres

Status on 2026-10-10: done.

### Built

- Migration `0002_movies.sql`: `movies`, `movie_tags`, `rating_stats` and their
  indexes.
- `pnpm ingest` (`apps/api/src/ingest`): reads the two Parquet files with
  `hyparquet`, checks every row with Zod, splits genres and keywords into
  arrays, upserts movies in batches of 500 with one transaction per batch,
  brings each movie's genome tags in line with the file, and computes
  `rating_stats`.
- Settings, all optional: `DATA_DIR`, `INGEST_BATCH_SIZE`,
  `RATING_MIN_VOTES_PERCENTILE`.

### How to run

```bash
pnpm db:migrate
pnpm ingest
```

### Measured

First run into an empty database, and a second run straight after:

| Run    | Movies                         | Tags written | Time   |
| ------ | ------------------------------ | ------------ | ------ |
| First  | 28,725 inserted                | 332,167      | 10.9 s |
| Second | 0 inserted, 28,725 unchanged   | 0            | 6.9 s  |

Weighted rating inputs: mean rating `C` = 6.411, minimum votes `m` = 146.
Weighted ratings: Inception 8.35, Shutter Island 8.19, 3 Idiots 7.88.

Sizes after the first load (`pg_total_relation_size`):

| Table        | Total  | Table | Indexes | Plan estimate |
| ------------ | ------ | ----- | ------- | ------------- |
| `movies`     | 52 MB  | 32 MB | 19 MB   | 70 to 80 MB   |
| `movie_tags` | 43 MB  | 19 MB | 25 MB   | 20 to 30 MB   |
| Database     | 103 MB |       |         |               |

Largest indexes: `movie_tags (tag, relevance)` 14 MB, `movie_tags` primary key
11 MB, `search_tsv` GIN 9.7 MB, `keywords` GIN 6.3 MB.

`movie_tags` is larger than estimated because it has 332,167 rows (D-033) and
two indexes; `movies` is smaller. Together they are 95 MB against an estimate
of 90 to 110 MB.

### Tests

47 API tests pass. The ingest integration tests (on `movies_test`) cover array
splitting, a second run changing nothing, a changed overview being updated,
tags being replaced and not duplicated, tags from another source being kept,
several batches, and `rating_stats` staying a single row.

### Notes

- Three small changes to the planned schema and steps are in D-037.
- API test files now run one at a time, because integration tests share the
  test database.

### Deferred

- Movies that are in the database but no longer in the file are left alone.
  If the vote thresholds are raised later, those rows need deleting by hand or
  a new ingest option.
- Checking with `EXPLAIN ANALYZE` that queries use the indexes: Phase 3.

## Phase 3: Baseline search without AI

Status on 2026-10-10: done.

### Built

- `GET /api/movies/search` with `q`, `genres`, `tags`, `yearFrom`, `yearTo`,
  `language`, `minRating`, `limit` and `offset`, validated with Zod.
- `GET /api/movies/:id` (with the movie's curated tags), `GET /api/genres`,
  `GET /api/tags`.
- Ranking from text relevance, tag relevance and weighted rating, with weights
  from config. The formula, examples and limits are in `docs/ARCHITECTURE.md`.
- Errors in one shape, with a message per field for bad input.
- `packages/shared`: genre and language lists, the curated tags as code, and
  the Zod schemas for requests and responses.
- Web: search page with a text box, language, year range, genre, plot and mood
  filters, a results grid with posters, "Show more" paging, loading, empty and
  error states, a shareable URL, and TMDB and MovieLens credits in the footer.
  The status page from Phase 0 is at `#status`.
- `docs/ATTRIBUTION.md` with the citations and dataset terms.

### Checked

| Check                                                | Result                                              |
| ---------------------------------------------------- | --------------------------------------------------- |
| `pnpm lint`, `pnpm typecheck`, `pnpm build`          | Pass                                                |
| `pnpm test`                                          | 91 tests pass (12 shared, 72 API, 7 web)            |
| "heist" returns heist movies                         | Yes: 281 matches, heist films first                 |
| Filtering by "twist ending" returns sensible films   | Yes: Fight Club, The Usual Suspects, The Prestige, Se7en, Shutter Island |
| Bad input returns 400 with field messages            | Yes                                                 |
| Filters and text search use their indexes            | Yes, table in `docs/ARCHITECTURE.md`                |
| Search page in a browser                             | Checked with headless Chrome screenshots: results, filters, empty result, status page |

Search times on the full catalog, measured in the API process: 2 to 60 ms.
The slowest are requests with no filters at all (every movie is scored) and
very broad text.

### Decided

- Words in a search are joined with OR (D-038).
- Equal ranking weights by default (D-039).
- D-019 corrected: MovieLens has its own terms, not a Creative Commons licence.

### Things to know for later phases

- The baseline is weak on sentences, as expected. "action movie with a twist at
  the end, not too old" returns Teen Titans Go! To the Movies and The Lego
  Movie. This is the number Phases 5 to 7 have to beat in Phase 9.
- MovieLens does not allow redistribution of its data without permission. Look
  at this before deploying publicly in Phase 11.

### Deferred

- `minRating` is in the API but not in the web filters.
- Clicking a movie does nothing yet; `GET /api/movies/:id` is ready for it.
- Browser tests of the page (clicking, typing). Only the filter and URL logic
  has tests.
- Rejecting unknown query parameters: Phase 8.

## Phase 4: LLM provider and embeddings pipeline

Status on 2026-10-10: done for the prototype. The code is built and tested.
980 of 28,725 movies are embedded, because the Gemini free tier allows 1,000
embedded texts a day. The user decided to build the prototype on those 980 and
not to pay for now (D-041), so the plan's "whole catalog embedded" is put off.

### Built

- `apps/api/src/llm`: the `LlmProvider` interface, a wrapper with timeouts,
  retries and the `llm_calls` log, the Gemini backend (the only file importing
  the SDK) and a fake backend for tests.
- Migration `0003_embeddings.sql`: `movie_embeddings` with an HNSW index, and
  `llm_calls`.
- `apps/api/src/embeddings` and `apps/api/src/jobs`: the embedding text and
  hash, the batch processor, the BullMQ queue and worker, export and import.
- Commands: `pnpm embed [--limit N]`, `pnpm embed:status`, `pnpm embed:export`,
  `pnpm embed:import`.
- How it works is in `docs/ARCHITECTURE.md`; the reasons are in D-040 and D-042.

### Decided

- `gemini-3.8-flash` (thinking `low`) and `gemini-embedding-2` at 768
  dimensions (D-040). O-003 is closed and D-021 confirmed.

### Checked

| Check                                              | Result                                           |
| -------------------------------------------------- | ------------------------------------------------ |
| `pnpm lint`, `pnpm typecheck`, `pnpm build`        | Pass                                             |
| `pnpm test`                                        | 128 tests pass (12 shared, 109 API, 7 web)       |
| Fake provider: retry on 429 and 5xx                | Pass                                             |
| Fake provider: no retry on 400, timeout, bad JSON  | Pass                                             |
| Every attempt logged in `llm_calls`                | Pass                                             |
| Second run embeds nothing and makes no API call    | Pass                                             |
| Resume after a simulated crash                     | Pass: the stored batch is not sent again         |
| Stop and restart                                   | Pass                                             |
| Export, then import into an empty table            | Pass: identical vectors                          |
| Real API: embed and store                          | 980 movies in 49 requests                        |
| Real API: whole catalog embedded                   | **No.** Stopped by the daily quota at 980        |

### Measured with the real API

| What                                   | Number                                             |
| -------------------------------------- | -------------------------------------------------- |
| Movies embedded                        | 980 of 28,725 (3.4%)                               |
| Input tokens                           | 166,550, about 170 a movie                         |
| Estimated tokens for the whole catalog | about 4.9 million                                  |
| Time for one batch of 20               | about 2 seconds                                    |
| Free tier, per minute                  | rate limited above roughly 28,000 tokens           |
| Free tier, per day                     | 1,000 texts (`embed_content_free_tier_requests`)   |
| `movie_embeddings` at 980 rows         | 8.2 MB in total, of which the HNSW index is 4.0 MB |
| Estimate at 28,725 rows                | about 240 MB (plan: 190 to 240 MB)                 |
| Export file at 980 rows                | 3.0 MB (about 90 MB for the whole catalog)         |

Search by meaning already works on the 980 embedded films. The nearest films to
each query, by cosine similarity:

| Query                             | Nearest                                                    |
| --------------------------------- | ---------------------------------------------------------- |
| space movie about loneliness      | Solaris, Silent Running, Dark Star, Lost in Translation    |
| a prison escape                   | Cool Hand Luke, Brubaker, Down by Law, Grand Illusion      |
| feel-good comedy about friendship | The Spanish Apartment, Ghost World, About a Boy            |
| koi achhi suspense movie batao    | Secret Window, Vertigo, Caché, Rear Window, The Sixth Sense|

The Hinglish query works without translation.

### Things to know for later phases

- **The daily quota is shared.** From Phase 5 every search that is not cached
  embeds its query, and that counts against the same 1,000 a day.
- **`gemini-3.8-flash` was slow and busy when tried:** 5.3 seconds for a small
  structured reply, and two of three attempts answered 503 first. Measure again
  in Phase 6 before settling on it for the parse step.
- **A bug found and fixed here:** the retry wrapper waited as long as the API
  asked, and the API asked for 11 hours. The first long run sat silent for five
  minutes before I noticed. It now refuses waits above `LLM_RETRY_MAX_MS`, the
  job stops with the API's message, and both cases have tests.
- The 980 embedded films are the lowest database ids, which are TMDB's oldest
  entries: many classics (The Dark Knight, Fight Club, Pulp Fiction, The
  Matrix), 334 films from 2000 or later, almost none after 2010. New runs embed
  best-known films first.

### Put off until after the prototype

1. Embed the rest of the catalog (options are listed in D-041).
2. Run `pnpm embed` until `pnpm embed:status` shows full coverage.
3. Record the total time, tokens and final table and index sizes here.

Until then, do not run `pnpm embed` casually: it spends the day's quota, which
search queries also need.

### Deferred

- A separate long-running worker process. `pnpm embed` runs the worker itself
  and exits when the queue is empty.
- Prompt files in `llm/prompts/`: they arrive with the parse and pick prompts
  in Phases 6 and 7.

## Phase 5: Semantic search

Status on 2026-10-10: done, on the 980 embedded movies (D-041).

### Built

- `POST /api/recommend`: normalize the request, embed it (cached in Redis),
  take the 30 nearest movies by vector, re-score with the weighted rating.
  Falls back to keyword search when the embedding fails. Described in
  `docs/ARCHITECTURE.md`.
- Shared request and response schemas, including `meta.stages` and
  `meta.cached`.
- The API now creates the Gemini provider at start, with quick retries. With no
  `GEMINI_API_KEY` it still starts and searches by keywords.
- Web: the home page is now one text box with example requests, results, and a
  "How this was found" panel listing each step, what happened and how long it
  took. The filter page from Phase 3 moved to "Browse" (`#browse`).
- README: how to set a Redis memory limit.

### Checked

| Check                                                 | Result                                         |
| ----------------------------------------------------- | ---------------------------------------------- |
| `pnpm lint`, `pnpm typecheck`, `pnpm build`           | Pass                                           |
| `pnpm test`                                           | 160 tests pass (17 shared, 129 API, 14 web)    |
| Cache hit on the second identical request             | Pass: one embedding call for two requests      |
| Fallback when embedding fails or times out            | Pass: keyword results, no error                |
| Response matches the shared schema                    | Pass                                           |
| Real API: "space movie about loneliness"              | Solaris, 2001: A Space Odyssey, Lost in Translation, Contact |
| Real API: same request again                          | `cached: true`, embed 0 ms                     |
| Recommend page in a browser                           | Checked with headless Chrome screenshots       |

Only one request was sent through the real API end to end, because today's
embedding quota was nearly used up by Phase 4. The other example requests were
checked directly against the vectors in Phase 4.

### Decided

- Scoring and fallbacks for search by meaning (D-043).
- Redis cache format and `volatile-lru` eviction instead of `allkeys-lru` (D-044).

### Things to know for later phases

- **Meaning search only sees 980 films**, and almost none after 2010. A request
  for something recent gets the nearest older films, not an empty list.
- **Each new request costs one of the day's 1,000 embedding calls.** Repeats are
  free for 7 days.
- The example chip "dark crime story with a twist" needs Phase 6 to work well:
  for now "twist" is only matched by meaning, not by the twist tag.
- Your local Redis has no memory limit set. The README has the two commands; I
  did not change your Redis settings.

### Deferred

- Tag boost in the score: needs the parse step (Phase 6).
- Caching the final result, not just the embedding: with the pick step (Phase 7).
- Request ids from an `x-request-id` header, rate limits and the token budget:
  Phase 8.
- Browser tests of the page. The panel's wording logic has unit tests.

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
- [x] Phase 6: Query understanding (parse)
- [x] Phase 7: Pick, reasons and streaming
- [x] Phase 8: Production concerns
- [ ] Phase 9: Evaluation (built; three of the four runs wait for the embedding quota)
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

## Phase 6: Query understanding (parse)

Status on 2026-10-10: done.

### Built

- Prompt `parse-v1` (`apps/api/src/llm/prompts/parse-v1.ts`) with a JSON Schema
  for the reply, and `sanitizeParse`, which drops anything unknown or out of
  range.
- The recommend pipeline is now parse, embed, search. Parsed genres, years,
  runtime, language and rating are filters; tags boost the score; excluded
  genres and tags are left out.
- "Like <film>": title lookup by trigram similarity (migration
  `0004_title_trigrams.sql`), and the query vector blended with that film's.
- Filters are loosened in a fixed order when too few movies match, reported in
  `meta.relaxed`.
- Parse results cached in Redis by prompt version, model, year and request.
- Keyword and vector search now share one set of filter conditions
  (`apps/api/src/search/filters.ts`).
- `meta.parsed` in the response, and on the web page the "How this was found"
  panel shows what was understood and which filters were ignored. It opens by
  itself when something was ignored or failed.
- `generateJson` accepts a model and thinking level per call.

### Decided

- Parse runs on `gemini-3.5-flash-lite` with minimal thinking (D-045). The user
  chose it from measurements.
- How a request is cleaned, filtered, loosened and filled (D-046).

### Checked

| Check                                                  | Result                                         |
| ------------------------------------------------------ | ---------------------------------------------- |
| `pnpm lint`, `pnpm typecheck`, `pnpm build`            | Pass                                           |
| `pnpm test`                                            | 200 tests pass (17 shared, 163 API, 20 web)    |
| Unknown genre dropped, bad years dropped               | Pass                                           |
| Invalid JSON triggers the fallback                     | Pass                                           |
| Hinglish request embeds the English search text        | Pass (scripted reply)                          |
| "action movie from the 90s" applies both filters       | Pass                                           |
| "like Inception" uses the film's embedding             | Pass, including a mistyped title               |
| Loosening works and is reported                        | Pass                                           |
| Real API: the headline request                         | Action, from 2011, twist ending; recent action films with the twist tag |
| Real API: Hinglish with a decade                       | Thriller, 1990 to 1999; The Silence of the Lambs, The Usual Suspects |
| Real API: "like The Matrix but funnier"                | Men in Black first                             |

Three requests went through the real API end to end (three parse calls, three
embedding calls). Times and tokens are in `docs/ARCHITECTURE.md`.

### Things to know for later phases

- **`gemini-3.8-flash` at thinking `low` did not answer the parse prompt within
  90 seconds, five times.** At `medium` it took 5.2 seconds. It is still the
  default text model for the pick step; measure it first in Phase 7.
- **Meaning matches come first in the list even when weak.** For the headline
  request the first result is Sin City: A Dame to Kill For, the only embedded
  action film from 2011 on, and it has no twist tag. This is a side effect of
  having 980 embeddings; the pick step (Phase 7) will reorder, and Phase 9 can
  measure whether the two rankings should be fused.
- **The model tends to list several genres.** They are all required at first
  and loosened to "any one" only when too few films match.
- A full request now takes about 2 seconds uncached (parse 1.4 s, embed 0.65 s).

### Deferred

- Streaming first results before the slow steps finish: Phase 7.
- A token budget and rate limits on the two LLM calls per request: Phase 8.
- Browser tests of the panel. Its wording has unit tests.

## Phase 7: Pick, reasons and streaming

Done on 2026-10-10.

### Built

- Prompt `pick-v1` (`apps/api/src/llm/prompts/pick-v1.ts`) and compact
  candidate lines: id, title, year, genres, top 5 tags, overview cut to about
  300 characters (`apps/api/src/recommend/candidates.ts`).
- The search fetches up to 30 movies when an LLM is configured, so the model
  has a choice; the first `limit` are the search-order answer.
- Validation and fill (`apps/api/src/recommend/pick.ts`): ids that are not
  candidates, repeats and malformed picks are dropped and counted in the log;
  missing slots are filled in search order without a reason.
- Fallback: on a timeout, an error or a reply with no usable pick, the search
  order is returned without reasons and the stage is `fallback`.
- Picks cached in Redis for one day, keyed by prompt version, model, request,
  limit and candidate ids.
- `POST /api/recommend/stream` with Server-Sent Events `results`, `picked`,
  `done` and `error`. `POST /api/recommend` is kept and returns the same final
  answer in one piece.
- Cancellation: when the client disconnects, the running LLM call is aborted
  and logged as `cancelled`. `generateJson` and `embed` take an abort signal.
- Web: results appear as soon as the search is done, then the cards move to
  the picked order (no animation with reduced motion) and show the reason. A
  failed pick shows nothing: no error, and the panel does not open by itself.
- The fake provider can fail a chosen call (`respondWithFailure`) and reports
  how many calls are running (`inFlight`).

### Decided

- The pick step runs on `gemini-3.5-flash-lite` with minimal thinking (D-047).
  The user chose it from measurements.
- How picks are made, checked, cached and streamed (D-048).

### Checked

| Check                                                   | Result                                       |
| ------------------------------------------------------- | -------------------------------------------- |
| `pnpm lint`, `pnpm typecheck`, `pnpm build`             | Pass                                         |
| `pnpm test`                                             | 236 tests pass (17 shared, 193 API, 26 web)  |
| Hallucinated, repeated and malformed ids dropped        | Pass                                         |
| Missing slots filled from search order, without reasons | Pass                                         |
| Fallback on timeout and on an unusable reply            | Pass; a failed pick is not cached            |
| SSE event order: results, picked, done                  | Pass                                         |
| Results are sent while the pick call is still running   | Pass                                         |
| Database failure gives an `error` event, safe message   | Pass                                         |
| Client disconnect stops the LLM call, nothing left open | Pass, on both routes                         |
| Real API: first results appear before the reasons       | 2.4 s and 4.5 s uncached; 0.1 s and 2.6 s with a cached parse |
| Real API: no spoilers in a sample of twist requests     | 55 reasons from 4 requests read by hand; none states an ending, a few hint at where the surprise lies |
| Real API: stream through the Vite dev proxy             | Events arrive one at a time                  |
| Page in headless Chrome                                 | Cards show reasons; filled slots show none   |

The real API was called 20 times for this phase: 12 pick calls, 4 parse calls
and 4 embedding calls.
Times and tokens are in `docs/ARCHITECTURE.md`.

### Things to know for later phases

- **`gemini-3.8-flash` is no longer used while a user waits.** At thinking
  `low` one of five pick calls gave no reply within 8 seconds. It is still
  `GEMINI_TEXT_MODEL`, for Phase 10.
- **The model comparison is small** (5 or 6 calls each). Phase 9 should compare
  pick models on the evaluation set, and count spoilers there.
- **A request now costs about 3,600 tokens**, about 3,000 of them in the pick.
  Phase 8's token budget should be sized from that; a skipped pick (soft
  budget) saves most of the cost.
- **Reasons are sometimes longer than 25 words.** They are cut only at 240
  characters. The cards get tall with a long reason.
- **Results at 0.1 s need a cached parse.** Uncached, the first results still
  wait about 2.4 s for parse and embedding.
- `llm_calls.status` can now be `cancelled`. Stats in Phase 8 should not count
  it as a failure.
- The reorder animation was not watched in a real browser; headless Chrome
  only showed the final state.

### Deferred

- Request ids in headers and logs, rate limits, the token budget and a limit on
  concurrent LLM calls: Phase 8.
- Sending each pick as the model writes it: not planned (D-048).
- Browser tests of the page. The stream parser and the wording have unit tests.

## Phase 8: Production concerns

Done on 2026-10-10.

### Built

- Request id on every request (`apps/api/src/http/requestId.ts`): in the
  `x-request-id` header, logs, `llm_calls`, `request_log`, recommend responses
  and error bodies.
- Rate limit per client IP, sliding window in Redis
  (`apps/api/src/limits/rateLimit.ts`): 429 with `Retry-After`.
- Daily token budget in Redis with soft and hard levels
  (`apps/api/src/limits/budget.ts`); the pipeline skips the pick at soft and
  every LLM call at hard, and reports it in `meta.budget`.
- Limit on concurrent LLM calls (`apps/api/src/limits/semaphore.ts`), built
  into the provider wrapper.
- Input limits: unknown fields and unknown search parameters refused, body
  limited to 10 KB.
- CORS for `WEB_ORIGIN` only and helmet's security headers were already in
  place; both now have tests.
- Graceful shutdown of the API and the worker (`apps/api/src/shutdown.ts`).
- Table `request_log` (migration `0005_request_log.sql`) and
  `GET /api/stats` behind `ADMIN_TOKEN`.
- Worker process `pnpm worker` with the daily retention job
  (`apps/api/src/jobs/retention.ts`, `apps/api/src/worker.ts`).
- Secret headers blanked in request logs (`apps/api/src/logger.ts`).
- Load test `pnpm loadtest` (`apps/api/scripts/loadtest.ts`).
- Web: shows the API's message on a 429, and says when a step was skipped
  because the budget is used up.

### How to run

```bash
pnpm db:migrate   # applies 0005_request_log.sql
pnpm worker       # the retention job; leave it running next to the API
pnpm loadtest     # optional: --seconds 20 --clients 20 --llm-ms 50 --new-share 0.3
```

### Decided

- Everything above, with defaults, is D-049. The user chose the Postgres table
  for the request log, and a budget of 1,000,000 tokens a day (soft 800,000)
  with the condition that it stays inside the free tier.

### Checked

| Check                                                | Result                                       |
| ---------------------------------------------------- | -------------------------------------------- |
| `pnpm lint`, `pnpm typecheck`, `pnpm build`          | Pass                                         |
| `pnpm test`                                          | 278 tests pass (17 shared, 234 API, 27 web)  |
| Rate limit: window slides, 429, `Retry-After`        | Pass                                         |
| Rate limit: per IP only behind a trusted proxy       | Pass                                         |
| Budget levels: ok, soft, hard; reset at midnight UTC | Pass                                         |
| Budget in the pipeline; caches still used            | Pass                                         |
| Rate limit and budget with Redis down                | Pass                                         |
| Concurrency limit                                    | Pass                                         |
| Request id in header, body, `llm_calls`, `request_log` | Pass                                       |
| Unknown field 400, large body 413                    | Pass                                         |
| Stats: 404 without a token, 401 with a wrong one     | Pass                                         |
| Stats numbers                                        | Pass                                         |
| Admin token not in the log                           | Pass                                         |
| Retention: only rows older than 30 days; as a job    | Pass                                         |
| Shutdown: open request finishes; timeout cuts off    | Pass                                         |
| Real server: SIGTERM                                 | Exit code 0, "shutdown complete"             |
| Real worker: start, schedule, SIGTERM                | Exit code 0                                  |
| Load test, 20 clients, 20 s                          | 1,603 requests, 0 errors, p50 14 ms, p95 767 ms, flat over the run |
| Load test, over the limit                            | 20 answered, 80 refused with 429, 0 other    |

No request to the real Gemini API was made in this phase.

### Things to know for later phases

- **The free-tier quota could not be checked.** Google shows a project's
  requests-per-minute and per-day limits only in AI Studio
  (https://aistudio.google.com/rate-limit). The token budget cannot exceed a
  free tier's cost (nothing is billed), but if the quota is lower than about
  830 LLM calls a day, requests will start falling back before the budget is
  reached. Compare the quota shown there with `TOKEN_BUDGET_HARD`.
- **Set `TRUST_PROXY_HOPS` when deploying** (Phase 11). At 0 behind a proxy,
  all users share one rate limit.
- **Set `ADMIN_TOKEN` to use the stats.** It is not set in `.env`.
- **New requests under load wait for LLM slots.** In the load test a new
  request took 770 ms with a 50 ms fake LLM. With the real one (about 2 s a
  call) and 4 slots, the API can start about 2 LLM calls a second.
- **The worker left a schedule in the local Redis** (`bull:maintenance:*`).
  It does nothing unless `pnpm worker` is running.
- The stats' LLM totals include embedding batches run the same day.
- The evaluation script (Phase 9) should send its own `x-request-id` values
  and will be subject to the rate limit unless it calls the pipeline directly.

### Deferred

- A dashboard for the stats: not planned for V1.
- Rate limits per user instead of per IP: needs accounts (V2).
- A load test from a second machine against a deployed API: Phase 11.

## Phase 9: Evaluation

**Not finished.** Built and tested on 2026-10-10; one of the four runs is done.

### Built

- `eval/queries.json`: 26 queries with computable checks and 133 expected
  movies, each verified to be in the catalog. Four are Hindi or Hinglish, two
  are vague, one is a prompt injection.
- The pipeline can leave steps out (`skip` in `apps/api/src/recommend/pipeline.ts`),
  which is what the four modes are.
- `apps/api/src/eval`: the file's schema, the checks, the runner and the
  command line.
- `pnpm eval --mode fulltext|semantic|parsed|full|all`, with `--delay-ms`,
  `--only`, `--check` (validate the file against the catalog, no calls) and
  `--report` (the comparison table as Markdown).
- Each run is saved to `eval/results/<date>-<mode>.json` with the prompt
  versions, the config, every answer and the summary.
- A run stops and saves nothing when three queries in a row have a failed LLM
  step.

### Decided

- How quality is measured: modes, checks, measures, no caches (D-050).
- The user chose to run with my draft of the queries and review it afterwards.

### Checked

| Check                                       | Result                                       |
| ------------------------------------------- | -------------------------------------------- |
| `pnpm lint`, `pnpm typecheck`, `pnpm build` | Pass                                         |
| `pnpm test`                                 | 296 tests pass (17 shared, 252 API, 27 web)  |
| `pnpm eval --check`                         | 26 queries, 133 expected movies, all in the catalog; 47 have an embedding |
| `pnpm eval --mode fulltext`                 | Done: constraints 46%, hits 30% (7 of 23), tags 41%, p50 19 ms |
| `pnpm eval --mode semantic`                 | **Not done.** 21 of 26 embeddings were refused: quota used up |
| `pnpm eval --mode parsed`, `--mode full`    | **Not run**, for the same reason             |

### What blocked the run

The free tier allows 1,000 embedded texts a day (D-041). Today's were used by
the 980 movies and about 20 requests. The API answered "Quota exceeded for
metric embed_content_free_tier_requests, limit: 1000" and asked to retry in
about 6 hours. I deleted the semantic result that this produced, because its
numbers were those of the keyword fallback.

### To finish this phase

1. Wait for the quota to reset, then run `pnpm eval --mode all` (about 10
   minutes; 78 embeddings, 52 parse calls, 26 pick calls).
2. Run `pnpm eval --report` and put the table in `docs/ARCHITECTURE.md` (it
   has the table with "not run" in three columns) and in the README.
3. Review `eval/queries.json`, above all the expected movies. Rerun after
   changes.
4. Decide from the numbers whether Phase 10 (LLM tags) is needed.

### Things to know

- **Do not embed more movies on a day the evaluation should run**, and the
  other way round: both use the same 1,000.
- Hit rate depends on which movies I listed as expected. 86 of the 133 have no
  embedding, so search by meaning cannot find them; the keyword fill can.
- The spoiler check only finds the listed phrases.
- Requests of the evaluation are in `llm_calls` with ids starting `eval-`, and
  count toward the API's token budget and the stats of the day.

## Outside the phases: embedding within the daily quota (2026-10-11)

Asked for by the user while Phase 9 waits for the quota.

### Built

- `pnpm embed --remaining [--reserve N]`: embeds as many movies as the
  provider's daily quota has left (`apps/api/src/embeddings/quota.ts`), and
  stops at the refill time.
- `pnpm embed:status` shows the quota: used (movies and requests), left, and
  the time to the refill.
- `llm_calls.items`: how many texts an embedding call embedded (migrations
  `0006_llm_call_items.sql`, `0007_backfill_llm_call_items.sql`).
- Config: `EMBED_DAILY_QUOTA`, `EMBED_QUOTA_TIMEZONE`.

### The daily routine (D-051)

```bash
pnpm embed:status      # any time: what is used and when the refill is
pnpm embed --remaining # about 20 minutes before the refill (12:30 pm IST in summer)
```

### Checked

| Check                                       | Result                                       |
| ------------------------------------------- | -------------------------------------------- |
| `pnpm lint`, `pnpm typecheck`, `pnpm build` | Pass                                         |
| `pnpm test`                                 | 304 tests pass (17 shared, 260 API, 27 web)  |
| Quota day: summer, winter, clock-change days | Pass                                        |
| Counts texts, not calls; only today; only ok | Pass                                        |
| `pnpm embed:status` on the real database    | "996 of 1000 used (980 movies, 16 requests)" |

### Things to know

- **The count can be a few too low.** It said 4 were left while the provider
  was already refusing. One batch of 4 movies was sent in that check and
  refused; nothing was embedded.
- **The refill time (midnight Pacific) is not yet observed.** A check at
  10:19 am IST on 2026-10-11 was still refused.
- Phase 9 is still waiting for the same refill.


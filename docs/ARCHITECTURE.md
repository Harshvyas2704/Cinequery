# Architecture

How the parts work and why they rank what they rank. The overall picture is in
`PLAN.md` section 3; decisions and their reasons are in `DECISIONS.md`. This
file grows with each phase.

## Search without AI (Phase 3)

`GET /api/movies/search` is one SQL query (`apps/api/src/search/movies.ts`).
It is the baseline that later phases are measured against, and the fallback
when the LLM or embeddings are unavailable.

### What a request can contain

| Parameter            | Meaning                                                        |
| -------------------- | -------------------------------------------------------------- |
| `q`                  | Free text, up to 200 characters                                |
| `genres`             | Comma-separated. A movie must have **every** genre listed      |
| `tags`               | Comma-separated curated tags. A movie must have **every** tag  |
| `yearFrom`, `yearTo` | Inclusive range on `release_year`                              |
| `language`           | Two-letter code of the original language, such as `hi`         |
| `minRating`          | Minimum TMDB average rating, 0 to 10                           |
| `limit`, `offset`    | Page size (1 to 50, default 20) and start                      |

Unknown genres or tags, and numbers out of range, get a 400 with one message
per field: `{ "error": { "code": "validation_error", "message": "...", "details": [{ "field", "message" }] } }`.

### The ranking formula

Filters decide **which** movies are returned. The score decides their
**order**:

```
score = w_text * text_score + w_tags * tag_score + w_rating * rating_score
```

Each part is between 0 and 1, so the weights are comparable. The weights come
from config (`SEARCH_WEIGHT_TEXT`, `SEARCH_WEIGHT_TAGS`, `SEARCH_WEIGHT_RATING`)
and all default to 1. Ties are broken by vote count, then id.

**`text_score`: how well the text matches.**

- The words of `q` are stemmed and joined with OR, so "space movie about
  loneliness" matches movies with any of *space*, *movi*, *loneli*. Stop words
  such as "about" are dropped. (D-038)
- `ts_rank_cd(search_tsv, query, 32)` scores the match. It rewards more
  matching words, words close together, and where they appear: title (weight
  A, 1.0), keywords (B, 0.4), tagline and overview (C, 0.2).
- Flag 32 turns the raw rank into `rank / (rank + 1)`, which is always below 1.
- With no `q` (or only stop words), `text_score` is 0 for every movie and no
  text filter is applied.

**`tag_score`: how strongly the movie has the requested tags.**

- Each curated tag stands for one to five Tag Genome tags (D-034). A movie's
  relevance for a curated tag is the highest relevance among those genome tags.
- `tag_score` is the average of that over the requested curated tags. It is
  between 0.5 and 1, because only relevance of 0.5 or more is stored.
- With no `tags`, `tag_score` is 0 for every movie.

**`rating_score`: how good the movie is, allowing for how many people voted.**

```
weighted     = (v / (v + m)) * R + (m / (v + m)) * C
rating_score = weighted / 10

R = the movie's vote_average      v = its vote_count
C = mean vote_average (6.41)      m = minimum votes (146, the median; D-036)
```

A film with few votes is pulled toward the average, so 9.5 from 60 votes
(weighted 7.31) ranks below 8.4 from 20,000 (weighted 8.39).

### What that looks like

With the default weights, on the full catalog:

| Request                                         | First results                                                    |
| ----------------------------------------------- | ---------------------------------------------------------------- |
| `q=heist`                                       | The Heist of the Century, Money Heist: The Phenomenon, Reservoir Dogs, Dog Day Afternoon |
| `tags=twist ending`                             | Fight Club, The Usual Suspects, The Prestige, Se7en, Shutter Island |
| `tags=heist`                                    | Reservoir Dogs, The Sting, Catch Me If You Can, The Usual Suspects |
| `q=bank robbery&tags=heist`                     | Inside Man, Dog Day Afternoon, The Town, Heat, Baby Driver       |
| `tags=twist ending&genres=Action&yearFrom=2005` | Inception, Headhunters, The Dark Knight Rises, Confession of Murder |
| no parameters                                   | The Godfather, The Shawshank Redemption, The Godfather Part II   |

### Known limits of this baseline

- **It matches words, not meaning.** "action movie with a twist at the end,
  not too old" returns films with "movie", "action" or "end" in the title
  (Teen Titans Go! To the Movies, The Lego Movie, Last Action Hero). Turning
  that sentence into filters and tags is Phase 6; searching by meaning is
  Phase 5.
- **A word in the title beats quality.** For `q=heist`, The Hurricane Heist
  (rated 5.7) is sixth, above Heat and Ocean's Eleven, which only have "heist"
  as a keyword.
- **Tags only cover 42% of the catalog** and no film after 2019, so a tag
  filter never returns recent films.

### Indexes

Checked with `EXPLAIN ANALYZE` on the full catalog (28,725 movies), through the
API's own parameterised query:

| Request                                  | Plan                                                          | Rows  | Time    |
| ---------------------------------------- | ------------------------------------------------------------- | ----- | ------- |
| `q=heist`                                | Bitmap scan on `movies_search_tsv_idx` (GIN)                  | 281   | 4.2 ms  |
| `genres=Western`                         | Bitmap scan on `movies_genres_idx` (GIN)                      | 479   | 3.7 ms  |
| `language=hi`                            | Bitmap scan on `movies_language_idx`                          | 826   | 3.0 ms  |
| `yearFrom=2022`                          | Index scan on `movies_release_year_idx`                       | 1,230 | 3.6 ms  |
| `q=heist&genres=Thriller&yearFrom=2000`  | Both GIN indexes combined                                     | 103   | 1.4 ms  |
| `tags=twist ending`                      | Bitmap scan on `movie_tags_tag_relevance_idx`, then `movies_pkey` | 2,275 | 25.6 ms |
| no parameters                            | Sequential scan (every movie is scored)                       | 28,725| 45.7 ms |

Optional filters are written as `$n IS NULL OR column ...`. Because the
parameter values are known when Postgres plans the query, the unused filters
are removed and the remaining ones can use their indexes.

## The LLM provider (Phase 4)

Everything that talks to an LLM goes through one interface, `LlmProvider`
(`apps/api/src/llm/types.ts`), with two methods: `generateJson` and `embed`.

```
caller ──> createLlmProvider (provider.ts) ──> a backend
           timeout, retries, llm_calls         gemini.ts (the real API)
                                               fake.ts   (tests)
```

- **A backend makes one attempt.** `gemini.ts` is the only file that imports
  the Gemini SDK; an ESLint rule rejects that import anywhere else. `fake.ts`
  returns scripted replies and can be told to time out, answer 429 or 5xx, or
  return invalid JSON.
- **The wrapper adds what every call needs:**
  - A timeout, enforced with an `AbortController` and a race, so a backend that
    ignores the abort still times out.
  - Retries with exponential backoff and jitter, on 429 and 5xx only. A 400, a
    timeout or invalid output is not retried. If the API asks for a wait longer
    than `LLM_RETRY_MAX_MS`, the error goes back to the caller instead.
  - One row in `llm_calls` per attempt: stage, model, prompt version, tokens,
    latency and status.
- **Replies are untrusted.** `generateJson` returns parsed JSON as `unknown`;
  the caller validates it with Zod.

## Embeddings (Phase 4)

```
pnpm embed
  1. load every movie's text and hash; keep those with no vector or an old hash
  2. queue them in batches of 20, best-known first          (BullMQ, Redis)
  3. worker, one batch at a time, at most 7 a minute:
       load the batch, skip movies whose hash is already stored
       one API request for the rest                          (Gemini)
       store the vectors in one statement                    (Postgres)
```

- **What is embedded** (`embeddings/text.ts`): the title and year as the title,
  then genres, the ten most relevant tags, keywords, tagline and overview. About
  177 tokens a movie.
- **Skipping finished work:** `content_hash` covers the text, the model and the
  dimensions. If the stored hash matches, the movie is skipped without an API
  call. This check runs inside the worker, so a batch that is retried, queued
  twice or interrupted by a crash never costs a second request.
- **Rate limits:** a rate-limited batch returns to the queue without using an
  attempt, and the queue pauses for as long as the API asks. Three in a row, or
  a requested wait above five minutes, ends the run with the API's message;
  the next run picks up from the database.
- **Search:** vectors are 768-dimension unit vectors in `movie_embeddings`,
  with an HNSW index on cosine distance (`embedding <=> query`). Queries and
  documents are embedded with different prefixes so that a question lands near
  the films that answer it.
- **Moving them:** `pnpm embed:export` writes
  `exports/embeddings-<model>-<dimensions>.jsonl.gz`, keyed by `tmdb_id`;
  `pnpm embed:import` loads it into another database without calling the API.

## Search by meaning (Phase 5)

`POST /api/recommend` takes `{ "query": "...", "limit": 8 }` and answers with
movies, a score each, and a record of how the answer was found
(`apps/api/src/recommend/pipeline.ts`).

```
request
  │  normalize: trim, lower case, single spaces
  ▼
embed ── in Redis? ── yes ──────────────────────────┐  (meta.cached = true)
  │ no                                              │
  │ Gemini, 4 s timeout, one retry                  │
  │   ok: store in Redis for 7 days ────────────────┤
  │   fails ──> keyword search (Phase 3)            │
  ▼                                                 ▼
search: the 30 nearest vectors (HNSW, cosine), re-scored, best `limit` returned
        none found ──> keyword search (Phase 3)
```

### Scoring

```
score = w_similarity * similarity + w_rating * rating_score
```

- `similarity` is the cosine similarity between the request and the movie, 0 to
  1. In practice the nearest 30 are within about 0.05 of each other.
- `rating_score` is the weighted rating divided by 10, as in the keyword search.
- The defaults are 1 and 0.2 (`RECOMMEND_WEIGHT_SIMILARITY`,
  `RECOMMEND_WEIGHT_RATING`), so meaning decides and the rating breaks near
  ties. The reasoning is in D-043.

### The response's `meta`

Every step adds an entry to `meta.stages` with its name, time and status:

| Situation                          | `embed`    | `search`   | Results come from |
| ---------------------------------- | ---------- | ---------- | ----------------- |
| Normal                             | `ok`       | `ok`       | meaning           |
| Same request asked before          | `ok`, 0 ms | `ok`       | meaning, `cached: true` |
| Embedding fails or times out       | `fallback` | `ok`       | keywords          |
| No API key configured              | `skipped`  | `ok`       | keywords          |
| No movie has a vector              | `ok`       | `fallback` | keywords          |

The client never gets an error because of the LLM.

### Measured

For "space movie about loneliness" on the 980 embedded films: Solaris, 2001: A
Space Odyssey, Lost in Translation, Contact, Silent Running, Stalker.

| Request                 | Embed  | Search |
| ----------------------- | ------ | ------ |
| First time              | 879 ms | 34 ms  |
| Again, from the cache   | 0 ms   | 9 ms   |

The keyword baseline for the same words (over the whole catalog) returns 2001: A
Space Odyssey, Alien, Interstellar, Space Sweepers, Aliens, Teen Titans Go! To
the Movies, The Empire Strikes Back and Cinema Paradiso: it matches the words
"space" and "movie", and nothing about loneliness.

## Understanding the request (Phase 6)

From Phase 6, `POST /api/recommend` has three steps. The diagram in the Phase 5
section still describes the embed step; this is the whole path:

```
"action movie with a twist at the end, not too old"
  │
  ▼
parse    Gemini Flash-Lite reads the request and returns JSON     (cached 7 days)
         { genres: [Action], yearFrom: 2011, tags: [twist ending],
           searchText: "action movie with a twist ending" }
         the reply is cleaned: anything unknown or out of range is dropped
         fails ──> no filters, search the words as typed
  │
  ▼
embed    searchText becomes a vector                              (cached 7 days)
         "like Inception": the vector moves halfway toward that film's vector
         fails ──> keyword search, still with the parsed filters
  │
  ▼
search   among movies that pass the filters:
           1. the 30 nearest by meaning, re-scored
           2. keyword matches on searchText, if the list is not full
           3. the best movies passing the filters, if it is still not full
         fewer than `limit`? loosen one filter and search again
```

### What each part of the reply becomes

| From the parse step               | Used as                                              |
| --------------------------------- | ---------------------------------------------------- |
| `genres`                          | Filter: the movie has every genre                    |
| `yearFrom`, `yearTo`              | Filter on `release_year`                             |
| `maxRuntime`, `language`, `minRating` | Filters                                          |
| `excludeGenres`, `excludeTags`    | Exclusions: the movie has none of them               |
| `tags`                            | A boost to the score, not a filter                   |
| `referenceTitles`                 | Moves the query vector; the named film is left out   |
| `searchText`                      | What is embedded, and the words for the keyword fill |

Tags are a boost because 58% of the catalog has no tags at all; as a filter
they would hide every film released after 2019.

### Scoring

```
score = w_similarity * similarity + w_tags * tag_score + w_rating * rating_score
        (1)                         (0.1)                (0.2)
```

`tag_score` is the best relevance per wanted tag, averaged over all wanted tags,
so a movie that has one of two wanted tags gets half. A strongly tagged film
gains up to 0.1, which is more than the usual spread in similarity among the
nearest 30 and so is enough to reorder them.

### Loosening filters

If fewer than `limit` movies are found, filters are dropped one at a time, in
this order, and the search runs again. Each one dropped is listed in
`meta.relaxed`:

1. excluded tags
2. minimum rating
3. maximum runtime
4. years
5. genres, and only from "every genre" to "at least one genre"

Excluded genres and language are never loosened.

### What the model gets, and what it costs

The system prompt lists the 19 genres, the 47 curated tags, the current year
and a few rules; the request goes between `<request>` tags with any angle
brackets removed. The reply must match a JSON Schema in which genres and tags
are enums. The prompt is `apps/api/src/llm/prompts/parse-v1.ts`.

| Per uncached request  | Tokens in | Tokens out | Time          |
| --------------------- | --------- | ---------- | ------------- |
| Parse (Flash-Lite)    | about 505 | 60 to 110  | 1.3 to 1.6 s  |
| Embed the search text | 10 to 20  | 0          | 0.6 to 0.7 s  |
| Search                |           |            | 10 to 100 ms  |

A repeated request costs no tokens: parse 1 ms, embed 0 ms, search 25 ms.

### Measured on real requests

| Request                                           | Understood as                                   | First results |
| ------------------------------------------------- | ----------------------------------------------- | ------------- |
| action movie with a twist at the end, not too old | Action, from 2011, twist ending                 | Sin City: A Dame to Kill For, The World's End, The Dark Knight Rises, Now You See Me 2, The Guest, Looper |
| koi achhi suspense movie batao, 90s ki            | Thriller, 1990 to 1999, "suspenseful thriller"  | The Silence of the Lambs, The Usual Suspects, Arlington Road, The Sixth Sense, Primal Fear, Se7en |
| something like The Matrix but funnier             | Science Fiction, Action, Comedy; funny, mind-bending; like The Matrix | Men in Black, Men in Black II, Teenage Mutant Ninja Turtles |

In the first row only Sin City: A Dame to Kill For came from the meaning
search: it is the one embedded action film from 2011 or later. The rest are
keyword and tag matches from the whole catalog (D-041, D-046).

## Picks, reasons and streaming (Phase 7)

`POST /api/recommend` now has a fourth step, and a second route sends the same
answer in pieces.

```
request
  1. parse    request -> filters, tags, search text          (LLM, cached 7 days)
  2. embed    search text -> vector                          (LLM, cached 7 days)
  3. search   up to 30 movies from Postgres                  (no LLM)
        -> the first `limit` of them can be shown now
  4. pick     the model chooses `limit` of the 30, best first,
              with one sentence each on why it fits           (LLM, cached 1 day)
```

The code is `apps/api/src/recommend/pipeline.ts`; the pick step's parts are
`candidates.ts` (what the model sees), `pick.ts` (checking its reply) and
`apps/api/src/llm/prompts/pick-v1.ts` (the prompt).

### What the model sees

The request between `<request>` tags, and one line per candidate:

```
id | title | year | genres | top 5 tags | overview cut to about 300 characters
14517 | Looper | 2012 | Action, Thriller, Science Fiction | future, dystopic future, time loop, scifi, science fiction | In the futuristic action thriller Looper, time travel will be invented but…
```

Angle brackets are removed from the request and from every line, and `|` and
line breaks from every field, so neither can break the layout. The prompt asks
for at most `limit` picks, forbids spoilers, and asks for variety.

### What happens to the reply

The model returns `{"picks":[{"id":number,"why":string}]}`. Nothing in it is
trusted (D-004, D-048):

| In the reply                                | What happens                                  |
| ------------------------------------------- | --------------------------------------------- |
| An id that is a candidate                   | Kept, in the model's order, with its reason   |
| An id that is not a candidate, or repeated  | Dropped, and counted in a log line            |
| A pick without a whole-number id            | Dropped, and counted                          |
| A reason over 240 characters, or on two lines | Put on one line and cut                     |
| Fewer picks than `limit`                    | Filled up in search order, without a reason   |
| No usable pick, a wrong shape, a timeout    | Search order, no reasons; stage `fallback`    |

Title, year, poster and everything else shown for a movie come from the
database row, never from the model.

### The stream

`POST /api/recommend/stream` takes the same body and answers with Server-Sent
Events. The shapes are in `packages/shared/src/recommend.ts`.

| Event     | When                                   | Data                                      |
| --------- | -------------------------------------- | ----------------------------------------- |
| `results` | As soon as the search is done          | `requestId`, `results` in search order, `picking` (whether picks will follow) |
| `picked`  | When the pick succeeded                | `results` in the final order, with `why`  |
| `done`    | Last, when the request worked          | `meta`, as in the non-streaming response  |
| `error`   | Instead of `done`, if something broke  | A fixed message; details stay in the log  |

A failed pick sends no `picked` and no `error`: `results` is then the final
answer, and `done` reports the pick stage as `fallback`. An invalid request is
answered with a normal 400 in the usual error shape, before any event.

The web page (`apps/web/src/RecommendPage.tsx`) shows the cards from `results`
with the line "Choosing the best matches for you…", then moves the cards to
their new places when `picked` arrives. The move is animated with the browser's
View Transitions, and not animated when the user has asked for reduced motion
or the browser cannot do it. The browser's `EventSource` only sends GET
requests, so the page reads the stream from `fetch` with a small parser
(`apps/web/src/sse.ts`).

### When the client goes away

Both routes watch for the connection closing before the response is complete.
An abort signal then runs through the pipeline: the LLM call in flight is
aborted, the pipeline stops before its next step, nothing is cached, and the
call is written to `llm_calls` with status `cancelled`. A database query that
is already running is allowed to finish; the longest takes about 100 ms.

### What a request costs now

| Per uncached request  | Tokens in      | Tokens out | Time          |
| --------------------- | -------------- | ---------- | ------------- |
| Parse (Flash-Lite)    | about 505      | 60 to 110  | 1.3 to 1.8 s  |
| Embed the search text | 10 to 20       | 0          | 0.6 to 0.9 s  |
| Search (30 movies)    |                |            | 30 to 80 ms   |
| Pick (Flash-Lite)     | 2,570 to 2,800 | 240 to 285 | 2.2 to 2.7 s  |

About 3,600 tokens in total. A repeated request costs none and takes about
65 ms.

### Measured on real requests

| Request                                           | First results on screen | Picks and reasons |
| ------------------------------------------------- | ----------------------- | ----------------- |
| heist movie with a clever plan (nothing cached)   | 2.4 s                   | 4.5 s             |
| action movie with a twist at the end, not too old (parse and embedding cached) | 0.1 s | 2.6 s |
| the same request again                            | 0.06 s                  | 0.07 s            |

For the headline request the search order began with Sin City: A Dame to Kill
For and ended with Pokémon Detective Pikachu. The picks dropped both and put
The Guest and Looper first. For "heist movie with a clever plan" the model
returned six picks; The Usual Suspects and Reservoir Dogs filled the last two
places without a reason.

Spoilers: the reasons for four requests about twists were read by hand (31
from Flash-Lite, 24 from 3.8 Flash). They say that a film has a twist, which
is what was asked for, and none states an ending. A few hint at where the
surprise lies, for example "a completely unexpected mastermind" or "a major
late-game betrayal". This is a small sample, not a guarantee; Phase 9 should
count spoilers on the evaluation set.

## Production concerns (Phase 8)

What a request passes on its way in, in order:

```
request
  1. request id      kept from x-request-id if safe, otherwise a new UUID
  2. security        helmet headers; CORS for WEB_ORIGIN only
  3. body            JSON up to 10 KB (413 above)
  4. rate limit      per client IP, sliding window in Redis (429 above)
  5. validation      unknown fields refused (400)
  6. token budget    decides which AI steps may run
  7. the pipeline    each LLM call waits for one of 4 slots
  8. request log     one row in request_log, whatever the outcome
```

The code is in `apps/api/src/app.ts`, `limits/`, `stats/` and `shutdown.ts`.
All numbers below are defaults from config (`.env.example`).

### Request id

Every response carries `x-request-id`. The same id is in every log line of the
request, in its `llm_calls` rows, in its `request_log` row, in the `requestId`
of a recommend response and in the body of an error. An id sent by the caller
is kept only if it is 8 to 64 characters of letters, digits, `.`, `_` and `-`;
anything else is replaced, because the id is written to logs and the database.

### Rate limit

| Routes                              | Limit per client IP |
| ----------------------------------- | ------------------- |
| `/api/recommend`, `/api/recommend/stream` | 20 per 60 seconds |
| Every other `/api` route            | 120 per 60 seconds  |
| `/api/health`                       | none                |

The window slides: Redis keeps the time of each of a client's requests in a
sorted set, and one Lua script drops the old ones, counts the rest and adds
the new one in a single step. A refused request is not counted. The answer
over the limit is 429 with `Retry-After` (seconds until the oldest request
leaves the window) and the usual error body with code `rate_limited`.

The client's IP is the connection's address. Behind a proxy that is the
proxy, so set `TRUST_PROXY_HOPS` to the number of proxies; the IP is then read
from `X-Forwarded-For`. It is 0 by default because a client can write anything
into that header.

### Token budget

Tokens (input plus output) of every LLM call the API makes are added to a
counter in Redis that is named after the UTC day, so it starts again at
midnight UTC.

| Tokens used today     | Level  | What a request does                                       |
| --------------------- | ------ | --------------------------------------------------------- |
| Below 800,000         | `ok`   | Everything                                                |
| 800,000 to 999,999    | `soft` | Parse and embed as usual; the pick step is `skipped`      |
| 1,000,000 or more     | `hard` | No LLM call; parse, embed and pick are `skipped`          |

At any level, stored parse results, embeddings and picks are still used, so a
request that was asked before is answered in full. The response carries
`meta.budget` (`soft` or `hard`) and the web page says "Paused: today's AI
budget is used up" for the skipped steps.

The level is read once at the start of a request, so the budget can be passed
by the cost of the requests then in flight (about 3,600 tokens each).

### Concurrency limit

At most 4 LLM calls run at the same time in one API process
(`LLM_MAX_CONCURRENT`). Further calls wait in order of arrival. Waiting counts
toward the call's timeout: a parse call that has not got a slot within 4
seconds times out, and the request falls back.

### When Redis is down

| Part            | What happens                                              |
| --------------- | --------------------------------------------------------- |
| Caches          | Every read is a miss, every write is skipped (D-044)      |
| Rate limit      | Requests are let through                                  |
| Token budget    | Counted in the process's memory until Redis is back       |
| Health check    | Reports Redis as down                                     |

Rate-limit and budget keys have an expiry, so under memory pressure Redis may
evict them like cache entries (`volatile-lru`); the count then starts again.

### Shutdown

On `SIGTERM` or `SIGINT`:

1. The API stops accepting connections and closes idle ones.
2. Open requests, including streams, get up to 10 seconds to finish
   (`SHUTDOWN_TIMEOUT_MS`). What is still open then is cut off.
3. Postgres and Redis are closed. The process exits 0, or 1 if step 2 had to
   cut something off.

The worker does the same, with "the job in progress" in place of "open
requests". A second signal does not start a second shutdown.

### The request log and `GET /api/stats`

Each recommend request writes one row to `request_log`: its id, route,
outcome (`ok`, `error`, `cancelled`), whether it was answered from caches,
how many movies it returned, the total time, and the status and time of each
step. **The request text is not stored.**

`GET /api/stats` needs `Authorization: Bearer <ADMIN_TOKEN>`. Without a
configured token the route answers 404; with a wrong one, 401. It reports,
since midnight UTC:

| Field                          | From          | Meaning                                         |
| ------------------------------ | ------------- | ----------------------------------------------- |
| `requests.total`, `cached`, `cacheHitRate` | `request_log` | Requests, and the share answered without an LLM call |
| `requests.errors`, `cancelled` | `request_log` | Failed requests, and ones the client abandoned  |
| `requests.latencyMs`           | `request_log` | p50 and p95 of the total time                   |
| `stages[]`                     | `request_log` | Per step: runs, fallbacks, skipped, p50 and p95 |
| `llm.byStage[]`, totals        | `llm_calls`   | Calls, failed calls and tokens, also of batch jobs |
| `llm.averageTokensPerRequest`  | both          | Parse, embedding and pick tokens per request    |
| `budget`                       | Redis         | Tokens used, both limits, the level             |

The admin token never reaches the log: the `Authorization`, `Cookie` and
`x-goog-api-key` headers are blanked in request logs
(`apps/api/src/logger.ts`).

### Retention

`pnpm worker` starts a process that runs one scheduled BullMQ job: every day
at 03:15 UTC it deletes rows of `llm_calls` and `request_log` older than 30
days. The schedule is stored in Redis under a fixed id, so starting the worker
again, or twice, does not schedule the job twice.

### Load test

`pnpm loadtest` starts the real app in one process with the real database and
Redis and a fake LLM that answers every call after 50 ms, then sends requests
over HTTP. Measured on the development laptop, with 28,725 movies and 980
embeddings:

**20 clients for 20 seconds, 30% of requests never asked before**

| Measure            | Value                                   |
| ------------------ | --------------------------------------- |
| Requests           | 1,603 (78 a second), 496 of them new    |
| Errors             | 0                                       |
| Latency, all       | p50 14 ms, p95 767 ms, p99 773 ms       |
| First 5 seconds    | p50 15 ms, p95 770 ms                   |
| Last 5 seconds     | p50 14 ms, p95 761 ms                   |

| Step   | New request, p50 | Repeated request, p50 |
| ------ | ---------------- | --------------------- |
| parse  | 236 ms           | 0 ms                  |
| embed  | 255 ms           | 0 ms                  |
| search | 9 ms             | 7 ms                  |
| pick   | 245 ms           | 0 ms                  |

A repeated request takes about 14 ms. A new one takes about 770 ms although
its three LLM calls take 50 ms each: with 20 clients and 4 slots, each call
waits about 200 ms for its turn. That is the concurrency limit working, and it
means latency under load is set by `LLM_MAX_CONCURRENT` and the provider's
speed, not by Postgres. Latency did not grow over the run.

**One client sends 100 requests at once, limit 20**

20 were answered with 200 and 80 with 429, none with anything else; p95 53 ms.

The load generator runs in the same process as the server, so the numbers
include its own work. They show stability, not the capacity of a deployment.

## Evaluation (Phase 9)

`pnpm eval` runs a fixed set of requests through the pipeline and checks every
answer by program, so that a change can be judged by numbers.

```
eval/queries.json     26 requests, each with checks
        │
        ▼
pnpm eval --mode <mode>      apps/api/src/eval
        │   for each request: run the pipeline with the mode's steps,
        │   look up the returned movies in Postgres, apply the checks
        ▼
eval/results/<date>-<mode>.json     the run: config, prompt versions,
                                    every answer, and the summary
```

### The four modes

Each mode adds one step to the one before, so the difference between two
columns of the table is what that step adds.

| Mode       | Parse | Embed | Pick | What it is                                     |
| ---------- | ----- | ----- | ---- | ---------------------------------------------- |
| `fulltext` | no    | no    | no   | Keyword search on the words as typed (Phase 3) |
| `semantic` | no    | yes   | no   | Plus search by meaning (Phase 5)               |
| `parsed`   | yes   | yes   | no   | Plus filters, tags and an English search text (Phase 6) |
| `full`     | yes   | yes   | yes  | Plus the model's choice and reasons (Phase 7)  |

Nothing is cached during a run, and the pipeline is called directly, not over
HTTP.

### The queries and their checks

The 26 queries cover genres, decades, runtime, rating, language, moods, plot
devices, "like <film>", exclusions, four Hindi or Hinglish requests, two vague
ones and one prompt injection. A check is one of:

| Check                                   | A returned movie passes if                        |
| --------------------------------------- | ------------------------------------------------- |
| `genresInclude`, `genresAny`, `genresExclude` | it has all, at least one, or none of the genres |
| `minYear`, `maxYear`, `maxRuntime`, `minRating`, `language` | the database value is within the limit |
| `noneOfMovies`                          | it is not one of the listed movies                |
| `tagsAny`                               | it has at least one of the curated tags           |
| `anyOfMovies`                           | (per query) at least one listed movie was returned |
| `noSpoilerWords`                        | (per reason) none of the phrases occurs in it     |

### The measures

| Measure                | Meaning                                                              |
| ---------------------- | -------------------------------------------------------------------- |
| Constraint pass rate   | Share of the returned movies that meet every constraint, averaged over the queries that have any |
| Hit rate               | Share of the queries with expected movies that returned at least one |
| Tag match rate         | Share of the returned movies with one of the wanted tags             |
| Spoiler check failures | Reasons that contain a listed phrase                                 |
| Fallbacks              | LLM steps that failed and were replaced                              |
| Latency p50, p95       | Time for the whole request, nothing cached                           |
| Tokens per query       | Input plus output tokens of the request's LLM calls                  |

### Results

**Only the baseline has been measured so far.** The other three modes need
embeddings of the requests, and the free tier's 1,000 embeddings for the day
were used up (980 movies and about 20 requests). Running them without
embeddings would only measure the keyword fallback, so those runs were stopped
and not saved.

| Measure                | fulltext | semantic | parsed | full |
| ---------------------- | -------- | -------- | ------ | ---- |
| Constraint pass rate   | 46%      | not run  | not run | not run |
| Hit rate               | 30% (7 of 23) | not run | not run | not run |
| Tag match rate         | 41%      | not run  | not run | not run |
| Movies with a reason   | 0%       | not run  | not run | not run |
| Spoiler check failures | 0        | not run  | not run | not run |
| Fallbacks              | 0        | not run  | not run | not run |
| Latency p50            | 19 ms    | not run  | not run | not run |
| Latency p95            | 64 ms    | not run  | not run | not run |
| Tokens per query       | 0        | not run  | not run | not run |

What the baseline shows: keyword search cannot apply a constraint it is not
told about. It scored 0% on constraints for "koi achhi suspense movie batao,
90s ki", "a classic from the 1940s" and "a tense thriller, but no horror
please", and returned nothing at all for the request in Hindi script.

To fill in the table when the quota is back:

```bash
pnpm eval --mode all     # about 10 minutes, about 156 calls
pnpm eval --report       # prints this table as Markdown from the saved runs
```


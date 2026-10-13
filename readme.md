# FIRST COMMIT
Natural language movie recommendations.

How it works is in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md), what has been
built so far in [docs/PROGRESS.md](docs/PROGRESS.md), and why in
[DECISIONS.md](DECISIONS.md).

## Redis memory limit

Redis holds two kinds of data: a cache (the embedding of each search request,
with an expiry time) and the job queue for `pnpm embed` (no expiry). Give Redis
a memory limit and tell it to drop the least recently used **cache** entries
when it is full:

```bash
redis-cli config set maxmemory 256mb
redis-cli config set maxmemory-policy volatile-lru
```

To keep the setting across restarts, put the same two lines in `redis.conf`
(Homebrew: `/opt/homebrew/etc/redis.conf`) without `config set`, then
`brew services restart redis`:

```
maxmemory 256mb
maxmemory-policy volatile-lru
```

- `volatile-lru` only removes keys that have an expiry time, so the cache
  shrinks but queued jobs are never thrown away. (`allkeys-lru` could delete
  jobs.)
- A cached embedding is about 3 KB, so 256 MB holds tens of thousands of
  requests.
- If the cache is full or Redis is down, search still works: the request is
  simply embedded again.

## Processes and operations

| Command         | What it is                                                              |
| --------------- | ----------------------------------------------------------------------- |
| `pnpm dev`      | The API and the web app, for development                                |
| `pnpm worker`   | The background worker: deletes log rows older than 30 days, once a day  |
| `pnpm loadtest` | A load test of the API against a fake LLM; no request reaches Gemini    |

Both processes stop cleanly on `SIGTERM` or Ctrl-C: they finish what is in
flight, then close the database and Redis.

To see today's usage, set `ADMIN_TOKEN` in `.env` (at least 16 characters) and
ask for the stats:

```bash
curl -H "Authorization: Bearer $ADMIN_TOKEN" http://localhost:3000/api/stats
```

The limits (requests per minute, tokens per day, concurrent LLM calls) are
listed in `.env.example` and explained in
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Evaluation

`pnpm eval` runs the 26 requests of `eval/queries.json` through the pipeline in
four modes and checks every answer by program. How it works and the results
are in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md#evaluation-phase-9).

```bash
pnpm eval --check          # validate the queries against the catalog; no API calls
pnpm eval --mode fulltext  # the baseline without AI; no API calls
pnpm eval --mode all       # all four modes; about 156 real Gemini calls
pnpm eval --report         # the comparison table from the saved runs
```

So far only the baseline is measured (constraints 46%, hit rate 30%); the
other modes are waiting for the free tier's daily embedding quota.

## Adding movies on the free tier

The free tier allows 1,000 embeddings a day, shared between movies and search
requests. Google's day starts at midnight Pacific time (12:30 pm in India in
summer, 1:30 pm in winter). To add movies without taking quota away from
requests, run this once a day, about 20 minutes before that time (900 movies
take about 12 minutes):

```bash
pnpm embed --remaining   # embeds what the day has left, then stops
pnpm embed:status        # shows what is used and when the refill is
```


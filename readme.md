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

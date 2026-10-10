// A load test of the recommend API against the fake LLM provider (`pnpm loadtest`).
//
// It starts the real app in this process, on a free port, with the real
// database and Redis, and sends it requests over HTTP. Only the LLM is fake:
// it answers every call after a fixed delay. No request reaches Gemini.
//
//   Scenario 1  a mix of repeated and new requests, as fast as the clients can
//   Scenario 2  one client sending more than the rate limit allows
//
// Rows written to llm_calls and request_log, and keys written to Redis, are
// removed at the end.
import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import { parseArgs } from "node:util";
import { parsedRequestSchema } from "@cinequery/shared";
import { pino } from "pino";
import { createApp } from "../src/app.js";
import { createJsonCache } from "../src/cache/jsonCache.js";
import { createQueryEmbeddingCache } from "../src/cache/queryEmbeddings.js";
import { createRedis } from "../src/cache/redis.js";
import { loadConfigOrExit } from "../src/config/env.js";
import { createPool } from "../src/db/pool.js";
import { unlimitedBudget } from "../src/limits/budget.js";
import { createRateLimiter } from "../src/limits/rateLimit.js";
import { llmCallRecorder } from "../src/llm/calls.js";
import { createFakeBackend } from "../src/llm/fake.js";
import { createLlmProvider } from "../src/llm/provider.js";
import { picksSchema } from "../src/recommend/pick.js";
import { requestRecorder } from "../src/stats/requestLog.js";

const { values } = parseArgs({
  options: {
    seconds: { type: "string", default: "20" },
    clients: { type: "string", default: "20" },
    // How long the fake LLM takes per call.
    "llm-ms": { type: "string", default: "50" },
    // The share of requests that were never asked before, so nothing is cached.
    "new-share": { type: "string", default: "0.3" },
  },
});
const SECONDS = Number(values.seconds);
const CLIENTS = Number(values.clients);
const LLM_MS = Number(values["llm-ms"]);
const NEW_SHARE = Number(values["new-share"]);

const config = loadConfigOrExit();
const logger = pino({ level: "silent" });
const run = `loadtest-${randomUUID().slice(0, 8)}`;

const pool = createPool(config.databaseUrl, logger);
const redis = createRedis(config.redisUrl, logger);
await new Promise((resolve) => redis.once("ready", resolve));

// The fake answers a parse call with a plain reply, and a pick call with the
// first candidates it was shown.
const backend = createFakeBackend({
  embeddingDimensions: config.llm.embeddingDimensions,
  latencyMs: LLM_MS,
  respond: (input) => {
    if (input.stage === "pick") {
      const ids = [...input.prompt.matchAll(/^(\d+) \|/gm)].map((match) => Number(match[1]));
      return { picks: ids.slice(0, 8).map((id) => ({ id, why: "A good match for the request." })) };
    }
    const request = /<request>(.*)<\/request>/.exec(input.prompt)?.[1] ?? "";
    return {
      genres: [],
      excludeGenres: [],
      tags: [],
      excludeTags: [],
      referenceTitles: [],
      searchText: request,
    };
  },
});
const llm = createLlmProvider(backend, {
  retry: config.llm.onlineRetry,
  maxConcurrent: config.llm.maxConcurrent,
  recordCall: llmCallRecorder(pool, logger),
});

function startApp(recommendMax: number) {
  const cache = { ttlSeconds: 600, prefix: run, logger };
  const app = createApp({
    config: { ...config, rateLimit: { ...config.rateLimit, recommendMax, apiMax: 1_000_000 } },
    pool,
    redis,
    llm,
    queryEmbeddingCache: createQueryEmbeddingCache(redis, {
      model: config.llm.embeddingModel,
      dimensions: config.llm.embeddingDimensions,
      ...cache,
    }),
    parseCache: createJsonCache(redis, { name: "parse", schema: parsedRequestSchema, ...cache }),
    pickCache: createJsonCache(redis, { name: "pick", schema: picksSchema, ...cache }),
    rateLimiter: createRateLimiter(redis, {
      windowMs: config.rateLimit.windowSeconds * 1000,
      prefix: `${run}-${recommendMax}`,
      logger,
    }),
    budget: unlimitedBudget,
    recordRequest: requestRecorder(pool, logger),
    logger,
  });
  const server = app.listen(0);
  const url = () => `http://localhost:${(server.address() as AddressInfo).port}`;
  return { url, close: () => new Promise((resolve) => server.close(resolve)) };
}

const WORDS = ["space", "prison", "heist", "love", "war", "detective", "robot", "ghost", "road trip", "revenge"];
const MOODS = ["dark", "funny", "tense", "sad", "feel-good", "slow", "violent", "clever", "strange", "romantic"];
const HOT = WORDS.flatMap((word) => MOODS.slice(0, 2).map((mood) => `${mood} ${word} movie`));

let sent = 0;
async function request(url: string, query: string): Promise<{ status: number; ms: number }> {
  const started = performance.now();
  const response = await fetch(`${url}/api/recommend`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-request-id": `${run}-${sent++}` },
    body: JSON.stringify({ query }),
  });
  await response.arrayBuffer();
  return { status: response.status, ms: performance.now() - started };
}

const percentile = (sorted: number[], p: number) =>
  sorted.length === 0 ? 0 : Math.round(sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))]!);

function summary(times: number[]) {
  const sorted = [...times].sort((a, b) => a - b);
  return `p50 ${percentile(sorted, 0.5)} ms, p95 ${percentile(sorted, 0.95)} ms, p99 ${percentile(sorted, 0.99)} ms, max ${Math.round(sorted.at(-1) ?? 0)} ms`;
}

async function mixedLoad() {
  const app = startApp(1_000_000);
  const started = performance.now();
  const elapsed = () => (performance.now() - started) / 1000;
  const results: { at: number; status: number; ms: number }[] = [];
  let fresh = 0;

  await Promise.all(
    Array.from({ length: CLIENTS }, async () => {
      while (elapsed() < SECONDS) {
        const query =
          Math.random() < NEW_SHARE
            ? `${MOODS[fresh % MOODS.length]} ${WORDS[fresh % WORDS.length]} story number ${fresh++}`
            : HOT[Math.floor(Math.random() * HOT.length)]!;
        const at = elapsed();
        results.push({ at, ...(await request(app.url(), query)) });
      }
    }),
  );
  const seconds = elapsed();
  await app.close();

  const failed = results.filter((result) => result.status !== 200);
  console.log(`\nScenario 1: ${CLIENTS} clients for ${SECONDS} s, ${NEW_SHARE * 100}% new requests, fake LLM ${LLM_MS} ms a call`);
  console.log(`  requests   ${results.length} (${Math.round(results.length / seconds)} a second), ${fresh} of them new`);
  console.log(`  errors     ${failed.length}${failed.length ? ` (statuses ${[...new Set(failed.map((result) => result.status))].join(", ")})` : ""}`);
  console.log(`  latency    ${summary(results.map((result) => result.ms))}`);
  // Stable means the last quarter looks like the first.
  const quarter = SECONDS / 4;
  for (let part = 0; part < 4; part++) {
    const slice = results.filter((result) => result.at >= part * quarter && result.at < (part + 1) * quarter);
    console.log(`    ${String(Math.round(part * quarter)).padStart(3)} to ${String(Math.round((part + 1) * quarter)).padStart(3)} s  ${String(slice.length).padStart(6)} requests  ${summary(slice.map((result) => result.ms))}`);
  }
  return failed.length;
}

async function overTheLimit() {
  const max = config.rateLimit.recommendMax;
  const app = startApp(max);
  const results = await Promise.all(Array.from({ length: max * 5 }, () => request(app.url(), HOT[0]!)));
  await app.close();
  const count = (status: number) => results.filter((result) => result.status === status).length;
  const other = results.length - count(200) - count(429);
  console.log(`\nScenario 2: one client sends ${results.length} requests at once, limit ${max} a window`);
  console.log(`  answered   ${count(200)} with 200, ${count(429)} with 429, ${other} with anything else`);
  console.log(`  latency    ${summary(results.map((result) => result.ms))}`);
  return other + Math.abs(count(200) - max);
}

let problems = 0;
try {
  const embedded = await pool.query<{ count: number }>(
    "SELECT count(*)::integer AS count FROM movie_embeddings WHERE model = $1",
    [config.llm.embeddingModel],
  );
  const movies = await pool.query<{ count: number }>("SELECT count(*)::integer AS count FROM movies");
  console.log(`Catalog: ${movies.rows[0]!.count} movies, ${embedded.rows[0]!.count} with an embedding. Up to ${config.llm.maxConcurrent} LLM calls at once.`);
  problems += await mixedLoad();
  problems += await overTheLimit();

  // Where the time went, from the rows the requests logged about themselves.
  const stages = await pool.query<{ name: string; cached: boolean; runs: number; p50: number; p95: number }>(
    `SELECT stage.item->>'name' AS name, r.cached, count(*)::integer AS runs,
            percentile_cont(0.5)  WITHIN GROUP (ORDER BY (stage.item->>'ms')::integer) AS p50,
            percentile_cont(0.95) WITHIN GROUP (ORDER BY (stage.item->>'ms')::integer) AS p95
     FROM request_log r
     CROSS JOIN LATERAL jsonb_array_elements(r.stages) WITH ORDINALITY AS stage(item, position)
     WHERE r.request_id LIKE $1
     GROUP BY 1, 2 ORDER BY r.cached, min(stage.position)`,
    [`${run}-%`],
  );
  console.log("\nTime per step (new requests, then repeated ones):");
  for (const row of stages.rows) {
    console.log(`  ${row.cached ? "repeated" : "new     "}  ${row.name.padEnd(7)} p50 ${String(Math.round(row.p50)).padStart(4)} ms, p95 ${String(Math.round(row.p95)).padStart(4)} ms  (${row.runs} runs)`);
  }
} finally {
  // Remove what the test wrote.
  const calls = await pool.query("DELETE FROM llm_calls WHERE request_id LIKE $1", [`${run}-%`]);
  const requests = await pool.query("DELETE FROM request_log WHERE request_id LIKE $1", [`${run}-%`]);
  let keys = 0;
  for await (const batch of redis.scanStream({ match: `${run}*`, count: 500 }) as AsyncIterable<string[]>) {
    if (batch.length > 0) keys += await redis.del(...batch);
  }
  console.log(`\nCleaned up: ${calls.rowCount} llm_calls rows, ${requests.rowCount} request_log rows, ${keys} Redis keys.`);
  redis.disconnect();
  await pool.end();
}
if (problems > 0) {
  console.log(`FAILED: ${problems} unexpected responses.`);
  process.exitCode = 1;
}

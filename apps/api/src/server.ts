import { parsedRequestSchema } from "@cinequery/shared";
import { createApp } from "./app.js";
import { createJsonCache } from "./cache/jsonCache.js";
import { createQueryEmbeddingCache } from "./cache/queryEmbeddings.js";
import { createRedis } from "./cache/redis.js";
import { loadConfigOrExit } from "./config/env.js";
import { createPool } from "./db/pool.js";
import { createTokenBudget } from "./limits/budget.js";
import { createRateLimiter } from "./limits/rateLimit.js";
import { createGeminiProvider } from "./llm/index.js";
import { createLogger } from "./logger.js";
import { picksSchema } from "./recommend/pick.js";
import { createShutdown } from "./shutdown.js";
import { requestRecorder } from "./stats/requestLog.js";

const config = loadConfigOrExit();
const logger = createLogger(config.logLevel);

const pool = createPool(config.databaseUrl, logger);
const redis = createRedis(config.redisUrl, logger);

const budget = createTokenBudget(redis, { ...config.budget, logger });
const rateLimiter = createRateLimiter(redis, {
  windowMs: config.rateLimit.windowSeconds * 1000,
  logger,
});

// Without a key the API still runs: search works by keywords only (D-011).
const llm = config.llm.apiKey
  ? createGeminiProvider(config, pool, logger, {
      retry: config.llm.onlineRetry,
      maxConcurrent: config.llm.maxConcurrent,
      onTokens: (tokens) => budget.add(tokens),
    })
  : null;
if (!llm) logger.warn("GEMINI_API_KEY is not set: search by meaning is off");
if (!config.adminToken) logger.info("ADMIN_TOKEN is not set: GET /api/stats is off");

const queryEmbeddingCache = createQueryEmbeddingCache(redis, {
  model: config.llm.embeddingModel,
  dimensions: config.llm.embeddingDimensions,
  ttlSeconds: config.recommend.embeddingCacheTtlSeconds,
  logger,
});

const parseCache = createJsonCache(redis, {
  name: "parse",
  schema: parsedRequestSchema,
  ttlSeconds: config.recommend.parse.cacheTtlSeconds,
  logger,
});

const pickCache = createJsonCache(redis, {
  name: "pick",
  schema: picksSchema,
  ttlSeconds: config.recommend.pick.cacheTtlSeconds,
  logger,
});

const app = createApp({
  config,
  pool,
  redis,
  llm,
  queryEmbeddingCache,
  parseCache,
  pickCache,
  rateLimiter,
  budget,
  recordRequest: requestRecorder(pool, logger),
  logger,
});

const server = app.listen(config.port, () => {
  logger.info(`API listening on http://localhost:${config.port}`);
});

server.on("error", (err) => {
  logger.fatal({ err }, `could not listen on port ${config.port}`);
  process.exit(1);
});

// On SIGTERM (a deploy, a container stop) or Ctrl-C: stop accepting
// connections, let open requests finish, then close the database and Redis.
const shutdown = createShutdown({
  drain: () =>
    new Promise<void>((resolve) => {
      server.close(() => resolve());
      // Connections that are open but idle (keep-alive) would hold close() up.
      server.closeIdleConnections();
    }),
  force: () => server.closeAllConnections(),
  close: [() => pool.end(), () => redis.quit()],
  timeoutMs: config.http.shutdownTimeoutMs,
  logger,
});
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.once(signal, () => {
    void shutdown(signal).then((clean) => process.exit(clean ? 0 : 1));
  });
}

import { pino } from "pino";
import { createApp } from "./app.js";
import { parsedRequestSchema } from "@cinequery/shared";
import { createJsonCache } from "./cache/jsonCache.js";
import { createQueryEmbeddingCache } from "./cache/queryEmbeddings.js";
import { createRedis } from "./cache/redis.js";
import { loadConfigOrExit } from "./config/env.js";
import { createPool } from "./db/pool.js";
import { createGeminiProvider } from "./llm/index.js";
import { picksSchema } from "./recommend/pick.js";

const config = loadConfigOrExit();
const logger = pino({ level: config.logLevel });

const pool = createPool(config.databaseUrl, logger);
const redis = createRedis(config.redisUrl, logger);

// Without a key the API still runs: search works by keywords only (D-011).
const llm = config.llm.apiKey
  ? createGeminiProvider(config, pool, logger, config.llm.onlineRetry)
  : null;
if (!llm) logger.warn("GEMINI_API_KEY is not set: search by meaning is off");

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
  logger,
});

const server = app.listen(config.port, () => {
  logger.info(`API listening on http://localhost:${config.port}`);
});

server.on("error", (err) => {
  logger.fatal({ err }, `could not listen on port ${config.port}`);
  process.exit(1);
});

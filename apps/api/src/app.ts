import cors from "cors";
import express, { type Express } from "express";
import helmet from "helmet";
import type { Logger } from "pino";
import { pinoHttp } from "pino-http";
import type { Config } from "./config/env.js";
import { errorHandler, notFound } from "./routes/errors.js";
import { type HealthDeps, healthRouter } from "./routes/health.js";
import { type MoviesDeps, moviesRouter } from "./routes/movies.js";
import { recommendRouter } from "./routes/recommend.js";
import type { QueryEmbeddingCache } from "./cache/queryEmbeddings.js";
import type { LlmProvider } from "./llm/types.js";

export type AppDeps = {
  config: Pick<Config, "webOrigin" | "healthCheckTimeoutMs" | "search" | "recommend"> & {
    llm: Pick<Config["llm"], "embeddingModel">;
  };
  pool: HealthDeps["pool"] & MoviesDeps["pool"];
  redis: HealthDeps["redis"];
  /** Null when no API key is configured; search then works by keywords only. */
  llm: LlmProvider | null;
  queryEmbeddingCache: QueryEmbeddingCache;
  logger: Logger;
};

export function createApp(deps: AppDeps): Express {
  const { config, pool, redis, logger } = deps;
  const app = express();
  app.disable("x-powered-by");

  app.use(pinoHttp({ logger }));
  app.use(helmet());
  app.use(cors({ origin: config.webOrigin }));
  app.use(express.json());

  app.use(
    "/api/health",
    healthRouter({ pool, redis, logger, timeoutMs: config.healthCheckTimeoutMs }),
  );

  app.use("/api", moviesRouter({ pool, search: config.search }));
  app.use(
    "/api",
    recommendRouter({
      pool,
      llm: deps.llm,
      cache: deps.queryEmbeddingCache,
      vector: {
        model: config.llm.embeddingModel,
        candidates: config.recommend.candidates,
        weights: config.recommend.weights,
        posterBaseUrl: config.search.posterBaseUrl,
      },
      search: config.search,
      embedTimeoutMs: config.recommend.embedTimeoutMs,
      logger,
    }),
  );

  app.use(notFound);
  app.use(errorHandler);
  return app;
}

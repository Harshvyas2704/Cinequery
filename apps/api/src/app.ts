import type { ParsedRequest } from "@cinequery/shared";
import cors from "cors";
import express, { type Express } from "express";
import helmet from "helmet";
import type pg from "pg";
import type { Logger } from "pino";
import { pinoHttp } from "pino-http";
import type { JsonCache } from "./cache/jsonCache.js";
import type { QueryEmbeddingCache } from "./cache/queryEmbeddings.js";
import type { Config } from "./config/env.js";
import { REQUEST_ID_HEADER, requestIdFrom } from "./http/requestId.js";
import type { TokenBudget } from "./limits/budget.js";
import { rateLimit, type RateLimiter } from "./limits/rateLimit.js";
import type { LlmProvider } from "./llm/types.js";
import type { Pick as MoviePick } from "./recommend/pick.js";
import { errorHandler, notFound } from "./routes/errors.js";
import { type HealthDeps, healthRouter } from "./routes/health.js";
import { moviesRouter } from "./routes/movies.js";
import { recommendRouter } from "./routes/recommend.js";
import { statsRouter } from "./routes/stats.js";
import type { RequestRecorder } from "./stats/requestLog.js";

export type AppDeps = {
  config: Pick<
    Config,
    "webOrigin" | "healthCheckTimeoutMs" | "search" | "recommend" | "adminToken"
  > & {
    llm: Pick<Config["llm"], "embeddingModel">;
    http: Pick<Config["http"], "trustProxyHops" | "bodyLimitBytes">;
    rateLimit: Pick<Config["rateLimit"], "recommendMax" | "apiMax">;
  };
  pool: pg.Pool;
  redis: HealthDeps["redis"];
  /** Null when no API key is configured; search then works by keywords only. */
  llm: LlmProvider | null;
  queryEmbeddingCache: QueryEmbeddingCache;
  parseCache: JsonCache<ParsedRequest>;
  pickCache: JsonCache<MoviePick[]>;
  rateLimiter: RateLimiter;
  budget: TokenBudget;
  recordRequest: RequestRecorder;
  /** The clock; tests fix it. */
  now?: () => Date;
  logger: Logger;
};

export function createApp(deps: AppDeps): Express {
  const { config, pool, redis, logger } = deps;
  const app = express();
  app.disable("x-powered-by");
  // Behind a proxy, the client's address is in X-Forwarded-For. It is only
  // believed for as many proxies as we run ourselves; a client can write
  // anything it likes into that header.
  app.set("trust proxy", config.http.trustProxyHops);

  app.use(
    pinoHttp({
      logger,
      // Every request gets an id: in each of its log lines, in its llm_calls
      // and request_log rows, and in the response for the user to quote.
      genReqId: (req, res) => {
        const id = requestIdFrom(req.headers[REQUEST_ID_HEADER]);
        res.setHeader(REQUEST_ID_HEADER, id);
        return id;
      },
    }),
  );
  app.use(helmet());
  // Only the web app's origin may read responses from a browser.
  app.use(
    cors({ origin: config.webOrigin, exposedHeaders: [REQUEST_ID_HEADER, "retry-after"] }),
  );
  app.use(express.json({ limit: config.http.bodyLimitBytes }));

  // Not rate limited: load balancers poll it.
  app.use(
    "/api/health",
    healthRouter({ pool, redis, logger, timeoutMs: config.healthCheckTimeoutMs }),
  );

  // Recommend requests can cost tokens, so they have their own, lower limit.
  app.use(
    "/api/recommend",
    rateLimit(deps.rateLimiter, "recommend", config.rateLimit.recommendMax),
  );
  app.use("/api", rateLimit(deps.rateLimiter, "api", config.rateLimit.apiMax));

  if (config.adminToken) {
    app.use(
      "/api",
      statsRouter({ pool, budget: deps.budget, adminToken: config.adminToken, now: deps.now }),
    );
  }
  app.use("/api", moviesRouter({ pool, search: config.search }));
  app.use(
    "/api",
    recommendRouter({
      pool,
      llm: deps.llm,
      embeddingCache: deps.queryEmbeddingCache,
      parseCache: deps.parseCache,
      pickCache: deps.pickCache,
      budget: deps.budget,
      recordRequest: deps.recordRequest,
      parse: config.recommend.parse,
      pick: config.recommend.pick,
      reference: config.recommend.reference,
      now: deps.now,
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

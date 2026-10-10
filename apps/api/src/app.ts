import cors from "cors";
import express, { type Express } from "express";
import helmet from "helmet";
import type { Logger } from "pino";
import { pinoHttp } from "pino-http";
import type { Config } from "./config/env.js";
import { errorHandler, notFound } from "./routes/errors.js";
import { type HealthDeps, healthRouter } from "./routes/health.js";

export type AppDeps = {
  config: Pick<Config, "webOrigin" | "healthCheckTimeoutMs">;
  pool: HealthDeps["pool"];
  redis: HealthDeps["redis"];
  logger: Logger;
};

export function createApp({ config, pool, redis, logger }: AppDeps): Express {
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

  app.use(notFound);
  app.use(errorHandler);
  return app;
}

import { pino } from "pino";
import { createApp } from "./app.js";
import { createRedis } from "./cache/redis.js";
import { loadConfigOrExit } from "./config/env.js";
import { createPool } from "./db/pool.js";

const config = loadConfigOrExit();
const logger = pino({ level: config.logLevel });

const pool = createPool(config.databaseUrl, logger);
const redis = createRedis(config.redisUrl, logger);
const app = createApp({ config, pool, redis, logger });

const server = app.listen(config.port, () => {
  logger.info(`API listening on http://localhost:${config.port}`);
});

server.on("error", (err) => {
  logger.fatal({ err }, `could not listen on port ${config.port}`);
  process.exit(1);
});

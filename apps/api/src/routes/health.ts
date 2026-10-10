import type { HealthResponse, PgvectorHealth, ServiceHealth } from "@cinequery/shared";
import { Router } from "express";
import type { Logger } from "pino";

// The small parts of pg.Pool and ioredis this route needs, so tests can pass fakes.
export type HealthDeps = {
  pool: { query(sql: string): Promise<{ rows: unknown[] }> };
  redis: { ping(): Promise<string> };
  timeoutMs: number;
  logger: Logger;
};

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out after ${ms} ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// The real error goes to the log. The response only says "unreachable", because
// driver messages can include hosts and user names.
async function checkService(
  name: string,
  run: () => Promise<unknown>,
  deps: HealthDeps,
): Promise<ServiceHealth> {
  const start = performance.now();
  try {
    await withTimeout(run(), deps.timeoutMs);
    return { status: "ok", latencyMs: Math.round(performance.now() - start) };
  } catch (error) {
    deps.logger.warn({ err: error }, `health check failed: ${name}`);
    return { status: "error", message: "unreachable" };
  }
}

async function checkPgvector(deps: HealthDeps): Promise<PgvectorHealth> {
  try {
    const { rows } = await withTimeout(
      deps.pool.query("SELECT extversion FROM pg_extension WHERE extname = 'vector'"),
      deps.timeoutMs,
    );
    const version = (rows[0] as { extversion?: unknown } | undefined)?.extversion;
    if (typeof version !== "string") {
      return { status: "error", message: "extension not installed; run pnpm db:migrate" };
    }
    return { status: "ok", version };
  } catch (error) {
    deps.logger.warn({ err: error }, "health check failed: pgvector");
    return { status: "error", message: "unreachable" };
  }
}

export function healthRouter(deps: HealthDeps): Router {
  const router = Router();

  router.get("/", async (_req, res) => {
    const [postgres, pgvector, redis] = await Promise.all([
      checkService("postgres", () => deps.pool.query("SELECT 1"), deps),
      checkPgvector(deps),
      checkService("redis", () => deps.redis.ping(), deps),
    ]);
    const healthy = [postgres, pgvector, redis].every((service) => service.status === "ok");
    const body: HealthResponse = {
      status: healthy ? "ok" : "degraded",
      services: { postgres, pgvector, redis },
    };
    res
      .status(healthy ? 200 : 503)
      .set("Cache-Control", "no-store")
      .json(body);
  });

  return router;
}

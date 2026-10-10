import { healthResponseSchema } from "@cinequery/shared";
import { afterEach, describe, expect, it } from "vitest";
import type { HealthDeps } from "../src/routes/health.js";
import { startApp } from "./helpers.js";

const okPool: HealthDeps["pool"] = {
  query: async (sql) => ({ rows: sql.includes("pg_extension") ? [{ extversion: "0.8.7" }] : [{}] }),
};
const okRedis: HealthDeps["redis"] = { ping: async () => "PONG" };
const never = () => new Promise<never>(() => {});

let close: (() => Promise<void>) | undefined;
afterEach(async () => {
  await close?.();
  close = undefined;
});

async function getHealth(deps: { pool: HealthDeps["pool"]; redis: HealthDeps["redis"] }) {
  const app = await startApp(deps);
  close = app.close;
  const response = await fetch(`${app.url}/api/health`);
  return { response, body: healthResponseSchema.parse(await response.json()) };
}

describe("GET /api/health", () => {
  it("returns 200 with the pgvector version when everything is up", async () => {
    const { response, body } = await getHealth({ pool: okPool, redis: okRedis });
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(body.status).toBe("ok");
    expect(body.services.postgres.status).toBe("ok");
    expect(body.services.pgvector).toEqual({ status: "ok", version: "0.8.7" });
    expect(body.services.redis.status).toBe("ok");
  });

  it("reports Redis down without affecting Postgres", async () => {
    const redis = { ping: async () => Promise.reject(new Error("ECONNREFUSED 127.0.0.1:6379")) };
    const { response, body } = await getHealth({ pool: okPool, redis });
    expect(response.status).toBe(503);
    expect(body.status).toBe("degraded");
    expect(body.services.postgres.status).toBe("ok");
    expect(body.services.pgvector.status).toBe("ok");
    expect(body.services.redis).toEqual({ status: "error", message: "unreachable" });
  });

  it("reports Postgres down without affecting Redis, and hides driver details", async () => {
    const pool = {
      query: async () => Promise.reject(new Error('role "harsh" does not exist at db.internal')),
    };
    const { response, body } = await getHealth({ pool, redis: okRedis });
    expect(response.status).toBe(503);
    expect(body.services.postgres).toEqual({ status: "error", message: "unreachable" });
    expect(body.services.pgvector).toEqual({ status: "error", message: "unreachable" });
    expect(body.services.redis.status).toBe("ok");
    expect(JSON.stringify(body)).not.toContain("db.internal");
  });

  it("reports pgvector missing when the extension is not installed", async () => {
    const pool = { query: async () => ({ rows: [] }) };
    const { response, body } = await getHealth({ pool, redis: okRedis });
    expect(response.status).toBe(503);
    expect(body.services.postgres.status).toBe("ok");
    expect(body.services.pgvector).toEqual({
      status: "error",
      message: "extension not installed; run pnpm db:migrate",
    });
  });

  it("gives up on a service that does not answer", async () => {
    const { response, body } = await getHealth({ pool: okPool, redis: { ping: never } });
    expect(response.status).toBe(503);
    expect(body.services.redis).toEqual({ status: "error", message: "unreachable" });
  });
});

describe("unknown routes", () => {
  it("returns the standard error shape", async () => {
    const app = await startApp({ pool: okPool, redis: okRedis });
    close = app.close;
    const response = await fetch(`${app.url}/api/nope`);
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({
      error: { code: "not_found", message: "No route for GET /api/nope" },
    });
  });
});

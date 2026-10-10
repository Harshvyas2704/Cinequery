import { describe, expect, it } from "vitest";
import { healthResponseSchema } from "./health.js";

describe("healthResponseSchema", () => {
  it("accepts a healthy response", () => {
    const parsed = healthResponseSchema.parse({
      status: "ok",
      services: {
        postgres: { status: "ok", latencyMs: 2 },
        pgvector: { status: "ok", version: "0.8.7" },
        redis: { status: "ok", latencyMs: 1 },
      },
    });
    expect(parsed.services.pgvector).toEqual({ status: "ok", version: "0.8.7" });
  });

  it("accepts a degraded response with a failed service", () => {
    const result = healthResponseSchema.safeParse({
      status: "degraded",
      services: {
        postgres: { status: "ok", latencyMs: 2 },
        pgvector: { status: "ok", version: "0.8.7" },
        redis: { status: "error", message: "unreachable" },
      },
    });
    expect(result.success).toBe(true);
  });

  it("rejects an ok service without its details", () => {
    const result = healthResponseSchema.safeParse({
      status: "ok",
      services: {
        postgres: { status: "ok" },
        pgvector: { status: "ok" },
        redis: { status: "ok", latencyMs: 1 },
      },
    });
    expect(result.success).toBe(false);
  });
});

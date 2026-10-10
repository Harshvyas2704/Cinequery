import { z } from "zod";

const serviceError = z.object({
  status: z.literal("error"),
  message: z.string(),
});

const serviceOk = z.object({
  status: z.literal("ok"),
  latencyMs: z.number().nonnegative(),
});

export const serviceHealthSchema = z.discriminatedUnion("status", [serviceOk, serviceError]);

export const pgvectorHealthSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("ok"), version: z.string() }),
  serviceError,
]);

export const healthResponseSchema = z.object({
  status: z.enum(["ok", "degraded"]),
  services: z.object({
    postgres: serviceHealthSchema,
    pgvector: pgvectorHealthSchema,
    redis: serviceHealthSchema,
  }),
});

export type ServiceHealth = z.infer<typeof serviceHealthSchema>;
export type PgvectorHealth = z.infer<typeof pgvectorHealthSchema>;
export type HealthResponse = z.infer<typeof healthResponseSchema>;

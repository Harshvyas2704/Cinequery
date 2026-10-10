import { describe, expect, it } from "vitest";
import { ConfigError, loadConfig } from "../src/config/env.js";

const valid = {
  DATABASE_URL: "postgresql://user@localhost:5432/movies",
  TEST_DATABASE_URL: "postgresql://user@localhost:5432/movies_test",
  REDIS_URL: "redis://localhost:6379",
  PORT: "4000",
  WEB_ORIGIN: "http://localhost:5173",
};

function problemsOf(env: NodeJS.ProcessEnv): string[] {
  try {
    loadConfig(env);
  } catch (error) {
    if (error instanceof ConfigError) return error.problems;
    throw error;
  }
  throw new Error("expected loadConfig to throw");
}

describe("loadConfig", () => {
  it("parses a valid environment", () => {
    expect(loadConfig(valid)).toEqual({
      nodeEnv: "development",
      port: 4000,
      webOrigin: "http://localhost:5173",
      databaseUrl: valid.DATABASE_URL,
      testDatabaseUrl: valid.TEST_DATABASE_URL,
      redisUrl: valid.REDIS_URL,
      logLevel: "info",
      healthCheckTimeoutMs: 2000,
      dataDir: expect.stringMatching(/data[/\\]clean$/),
      ingestBatchSize: 500,
      ratingMinVotesPercentile: 0.5,
      search: {
        weights: { text: 1, tags: 1, rating: 1 },
        posterBaseUrl: "https://image.tmdb.org/t/p/w342",
      },
      llm: {
        apiKey: undefined,
        textModel: "gemini-3.8-flash",
        thinkingLevel: "low",
        embeddingModel: "gemini-embedding-2",
        embeddingDimensions: 768,
        retry: { maxRetries: 3, baseDelayMs: 1000, maxDelayMs: 30000 },
        onlineRetry: { maxRetries: 1, baseDelayMs: 200, maxDelayMs: 1000 },
      },
      recommend: {
        candidates: 30,
        weights: { similarity: 1, rating: 0.2 },
        embedTimeoutMs: 4000,
        embeddingCacheTtlSeconds: 604800,
      },
      embed: {
        batchSize: 20,
        requestsPerMinute: 7,
        timeoutMs: 60000,
        jobAttempts: 3,
        exportDir: expect.stringMatching(/exports$/),
      },
    });
  });

  it("applies defaults for optional variables", () => {
    const config = loadConfig({ ...valid, PORT: undefined, TEST_DATABASE_URL: undefined });
    expect(config.port).toBe(3000);
    expect(config.testDatabaseUrl).toBeUndefined();
  });

  it("names a missing variable", () => {
    expect(problemsOf({ ...valid, DATABASE_URL: undefined })).toEqual(["DATABASE_URL is required"]);
  });

  it("treats an empty value as missing", () => {
    expect(problemsOf({ ...valid, REDIS_URL: "" })).toEqual(["REDIS_URL is required"]);
    expect(loadConfig({ ...valid, PORT: "" }).port).toBe(3000);
  });

  it("reports every problem at once", () => {
    const problems = problemsOf({ PORT: "abc" });
    expect(problems).toEqual([
      "DATABASE_URL is required",
      "REDIS_URL is required",
      "PORT must be a port number between 1 and 65535",
      "WEB_ORIGIN is required",
    ]);
  });

  it("rejects the wrong kind of URL", () => {
    expect(problemsOf({ ...valid, DATABASE_URL: "mysql://localhost/movies" })).toEqual([
      "DATABASE_URL must be a postgres:// or postgresql:// URL",
    ]);
    expect(problemsOf({ ...valid, REDIS_URL: "localhost:6379" })).toEqual([
      "REDIS_URL must be a redis:// or rediss:// URL",
    ]);
  });

  it("rejects out-of-range ports", () => {
    for (const PORT of ["0", "70000", "80.5"]) {
      expect(problemsOf({ ...valid, PORT })).toEqual([
        "PORT must be a port number between 1 and 65535",
      ]);
    }
  });

  it("rejects ingest settings that are out of range", () => {
    expect(problemsOf({ ...valid, INGEST_BATCH_SIZE: "0" })).toEqual([
      "INGEST_BATCH_SIZE must be a whole number between 1 and 5000",
    ]);
    expect(problemsOf({ ...valid, RATING_MIN_VOTES_PERCENTILE: "50" })).toEqual([
      "RATING_MIN_VOTES_PERCENTILE must be a number between 0 and 1",
    ]);
  });

  it("reduces WEB_ORIGIN to an origin", () => {
    expect(loadConfig({ ...valid, WEB_ORIGIN: "https://example.com/app/" }).webOrigin).toBe(
      "https://example.com",
    );
  });

  it("reads the Gemini key without requiring it", () => {
    expect(loadConfig(valid).llm.apiKey).toBeUndefined();
    expect(loadConfig({ ...valid, GEMINI_API_KEY: "secret-key" }).llm.apiKey).toBe("secret-key");
    expect(problemsOf({ ...valid, GEMINI_THINKING_LEVEL: "none" })).toEqual([
      "GEMINI_THINKING_LEVEL must be minimal, low, medium or high",
    ]);
  });

  it("never puts values in the error message", () => {
    const secret = "mysql://admin:hunter2@db.internal/movies";
    try {
      loadConfig({ ...valid, DATABASE_URL: secret });
      throw new Error("expected loadConfig to throw");
    } catch (error) {
      expect((error as Error).message).not.toContain("hunter2");
      expect((error as Error).message).toContain(".env.example");
    }
  });
});

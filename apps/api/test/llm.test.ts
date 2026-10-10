import { describe, expect, it } from "vitest";
import { createFakeBackend, fakeEmbedding } from "../src/llm/fake.js";
import { createLlmProvider, type LlmCallRecord, retryDelayMs } from "../src/llm/provider.js";
import { LlmError } from "../src/llm/types.js";

const retry = { maxRetries: 3, baseDelayMs: 100, maxDelayMs: 1000 };

function setup(overrides: Partial<typeof retry> = {}) {
  const backend = createFakeBackend({ embeddingDimensions: 8 });
  const records: LlmCallRecord[] = [];
  const sleeps: number[] = [];
  const llm = createLlmProvider(backend, {
    retry: { ...retry, ...overrides },
    recordCall: (call) => void records.push(call),
    sleep: async (ms) => void sleeps.push(ms),
    random: () => 1, // no jitter: always the full backoff
  });
  return { backend, llm, records, sleeps };
}

const generate = {
  stage: "parse",
  promptVersion: "parse-v1",
  system: "system",
  prompt: "prompt",
  schema: { type: "object" },
  maxOutputTokens: 100,
  timeoutMs: 1000,
  requestId: "req-1",
};
const embed = { texts: ["a", "b"], kind: "document" as const, stage: "embed_batch", timeoutMs: 1000 };

async function errorOf(promise: Promise<unknown>): Promise<LlmError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof LlmError) return error;
    throw error;
  }
  throw new Error("expected the call to fail");
}

describe("retries", () => {
  it("retries a 429 with growing waits, then succeeds", async () => {
    const { backend, llm, records, sleeps } = setup();
    backend.failNext({ type: "status", status: 429 }, { type: "status", status: 429 });

    const result = await llm.embed(embed);
    expect(result.vectors).toHaveLength(2);
    expect(backend.calls).toHaveLength(3);
    expect(sleeps).toEqual([100, 200]);
    expect(records.map((record) => record.status)).toEqual(["rate_limited", "rate_limited", "ok"]);
  });

  it("retries a 5xx", async () => {
    const { backend, llm, records } = setup();
    backend.failNext({ type: "status", status: 503 });
    backend.respondWith({ ok: true });

    expect((await llm.generateJson(generate)).data).toEqual({ ok: true });
    expect(backend.calls).toHaveLength(2);
    expect(records.map((record) => record.status)).toEqual(["error", "ok"]);
  });

  it("does not retry a 400", async () => {
    const { backend, llm, records, sleeps } = setup();
    backend.failNext({ type: "status", status: 400 });

    const error = await errorOf(llm.embed(embed));
    expect(error).toMatchObject({ kind: "error", status: 400, retryable: false });
    expect(backend.calls).toHaveLength(1);
    expect(sleeps).toEqual([]);
    expect(records.map((record) => record.status)).toEqual(["error"]);
  });

  it("gives up after the configured number of retries", async () => {
    const { backend, llm, records } = setup({ maxRetries: 2 });
    backend.failNext(
      { type: "status", status: 429 },
      { type: "status", status: 429 },
      { type: "status", status: 429 },
    );

    expect(await errorOf(llm.embed(embed))).toMatchObject({ kind: "rate_limited", status: 429 });
    expect(backend.calls).toHaveLength(3);
    expect(records).toHaveLength(3);
  });

  it("waits at least as long as the provider asks", async () => {
    const { backend, llm, sleeps } = setup();
    backend.failNext({ type: "status", status: 429, retryAfterMs: 700 });
    await llm.embed(embed);
    expect(sleeps).toEqual([700]);
  });

  it("does not sit through a wait longer than the maximum delay", async () => {
    const { backend, llm, sleeps } = setup();
    backend.failNext({ type: "status", status: 429, retryAfterMs: 3_600_000 });

    const error = await errorOf(llm.embed(embed));
    expect(error).toMatchObject({ kind: "rate_limited", retryAfterMs: 3_600_000 });
    expect(backend.calls).toHaveLength(1);
    expect(sleeps).toEqual([]);
  });

  it("caps the backoff and applies jitter", () => {
    expect(retryDelayMs(0, retry, () => 1)).toBe(100);
    expect(retryDelayMs(2, retry, () => 1)).toBe(400);
    expect(retryDelayMs(10, retry, () => 1)).toBe(1000);
    expect(retryDelayMs(2, retry, () => 0.5)).toBe(200);
    expect(retryDelayMs(2, retry, () => 0)).toBe(0);
  });
});

describe("timeouts and bad output", () => {
  it("times out a call that never answers, without retrying", async () => {
    const { backend, llm, records, sleeps } = setup();
    backend.failNext({ type: "timeout" });

    const started = performance.now();
    const error = await errorOf(llm.embed({ ...embed, timeoutMs: 30 }));
    expect(error.kind).toBe("timeout");
    expect(performance.now() - started).toBeLessThan(500);
    expect(backend.calls).toHaveLength(1);
    expect(sleeps).toEqual([]);
    expect(records.map((record) => record.status)).toEqual(["timeout"]);
  });

  it("reports invalid JSON as invalid_output, without retrying", async () => {
    const { backend, llm, records } = setup();
    backend.failNext({ type: "invalid_json" });

    expect((await errorOf(llm.generateJson(generate))).kind).toBe("invalid_output");
    expect(backend.calls).toHaveLength(1);
    expect(records.map((record) => record.status)).toEqual(["invalid_output"]);
  });

  it("wraps an unexpected error from the backend", async () => {
    const { llm } = setup();
    // No scripted reply: the fake throws.
    expect((await errorOf(llm.generateJson(generate))).kind).toBe("error");
  });
});

describe("call log", () => {
  it("records stage, model, prompt version, tokens and latency", async () => {
    const { backend, llm, records } = setup();
    backend.respondWith({ genres: ["Action"] });

    const result = await llm.generateJson(generate);
    expect(result.usage).toEqual({ inputTokens: 100, outputTokens: 20 });
    expect(records).toEqual([
      {
        requestId: "req-1",
        stage: "parse",
        model: "fake-text",
        promptVersion: "parse-v1",
        inputTokens: 100,
        outputTokens: 20,
        latencyMs: expect.any(Number),
        status: "ok",
      },
    ]);
  });

  it("records an embedding call under the embedding model", async () => {
    const { llm, records } = setup();
    await llm.embed({ ...embed, stage: "embed_query" });
    expect(records[0]).toMatchObject({
      stage: "embed_query",
      model: "fake-embedding",
      promptVersion: null,
      requestId: null,
      status: "ok",
    });
  });

  it("makes no call for an empty list of texts", async () => {
    const { backend, llm, records } = setup();
    expect((await llm.embed({ ...embed, texts: [] })).vectors).toEqual([]);
    expect(backend.calls).toHaveLength(0);
    expect(records).toHaveLength(0);
  });
});

describe("fake embeddings", () => {
  it("are deterministic unit vectors of the requested size", () => {
    const a = fakeEmbedding("Inception", 768);
    expect(a).toHaveLength(768);
    expect(a).toEqual(fakeEmbedding("Inception", 768));
    expect(a).not.toEqual(fakeEmbedding("Inception 2", 768));
    expect(Math.hypot(...a)).toBeCloseTo(1, 6);
  });

  it("come back one per text, in order", async () => {
    const { llm } = setup();
    const { vectors } = await llm.embed(embed);
    expect(vectors).toEqual([fakeEmbedding("a", 8), fakeEmbedding("b", 8)]);
  });
});

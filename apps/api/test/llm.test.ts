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

describe("cancelling", () => {
  it("stops a running call when the caller's signal fires, without retrying", async () => {
    const { backend, llm, records, sleeps } = setup();
    backend.failNext({ type: "timeout" }); // never answers by itself
    const controller = new AbortController();

    const pending = errorOf(llm.generateJson({ ...generate, signal: controller.signal }));
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(backend.inFlight).toBe(1);
    controller.abort();

    expect((await pending).kind).toBe("cancelled");
    expect(backend.inFlight).toBe(0);
    expect(backend.calls).toHaveLength(1);
    expect(sleeps).toEqual([]);
    expect(records.map((record) => record.status)).toEqual(["cancelled"]);
  });

  it("makes no call at all when the signal has already fired", async () => {
    const { backend, llm, records } = setup();

    const error = await errorOf(llm.embed({ ...embed, signal: AbortSignal.abort() }));
    expect(error.kind).toBe("cancelled");
    expect(backend.calls).toHaveLength(0);
    expect(records).toEqual([]);
  });
});

describe("concurrency limit", () => {
  function limited(maxConcurrent: number) {
    const backend = createFakeBackend({ embeddingDimensions: 8 });
    const records: LlmCallRecord[] = [];
    const llm = createLlmProvider(backend, {
      retry: { ...retry, maxRetries: 0 },
      maxConcurrent,
      recordCall: (call) => void records.push(call),
    });
    return { backend, llm, records };
  }
  const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

  it("runs at most the configured number of calls at once", async () => {
    const { backend, llm } = limited(2);
    // Three calls that never answer by themselves; each ends by its timeout.
    backend.failNext({ type: "timeout" }, { type: "timeout" }, { type: "timeout" });
    const calls = [60, 60, 500].map((timeoutMs) => errorOf(llm.embed({ ...embed, timeoutMs })));

    await settle();
    expect(backend.inFlight).toBe(2);
    expect(backend.calls).toHaveLength(2);

    // When the first two time out, the third gets its turn.
    await Promise.all(calls.slice(0, 2));
    await settle();
    expect(backend.calls).toHaveLength(3);
    await calls[2];
    expect(backend.inFlight).toBe(0);
  });

  it("times out a call that waits too long for its turn, without sending it", async () => {
    const { backend, llm, records } = limited(1);
    backend.failNext({ type: "timeout" });
    const running = errorOf(llm.embed({ ...embed, timeoutMs: 300 }));
    await settle();

    const waiting = await errorOf(llm.embed({ ...embed, timeoutMs: 50 }));
    expect(waiting.kind).toBe("timeout");
    expect(backend.calls).toHaveLength(1);

    // The place it was waiting for is not lost.
    await running;
    backend.respondWith({ ok: true });
    expect((await llm.generateJson(generate)).data).toEqual({ ok: true });
    expect(records.map((record) => record.status)).toEqual(["timeout", "timeout", "ok"]);
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

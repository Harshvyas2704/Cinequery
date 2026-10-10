// The only file that talks to Gemini (D-005). Everything else uses LlmProvider.
import { ApiError, GoogleGenAI, type ThinkingLevel } from "@google/genai";
import {
  type EmbedInput,
  errorFromStatus,
  type GenerateJsonInput,
  type LlmBackend,
  LlmError,
} from "./types.js";

export type GeminiSettings = {
  apiKey: string;
  textModel: string;
  /** low, medium or high. The lowest the model allows keeps cost and latency down (D-009). */
  thinkingLevel: string;
  embeddingModel: string;
  embeddingDimensions: number;
};

const API_BASE = "https://generativelanguage.googleapis.com/v1beta";

// How gemini-embedding-2 is told what a text is. Documents and queries get
// different prefixes; the model has no separate task parameter.
function embeddingText(input: EmbedInput, index: number): string {
  const text = input.texts[index] ?? "";
  if (input.kind === "query") return `task: search result | query: ${text}`;
  return `title: ${input.titles?.[index] || "none"} | text: ${text}`;
}

// A 429 body may carry google.rpc.RetryInfo: { retryDelay: "17s" }.
function retryAfterMs(body: unknown): number | undefined {
  const details = (body as { error?: { details?: { retryDelay?: unknown }[] } })?.error?.details;
  for (const detail of details ?? []) {
    const match = typeof detail.retryDelay === "string" && /^([\d.]+)s$/.exec(detail.retryDelay);
    if (match) return Math.ceil(Number(match[1]) * 1000);
  }
  return undefined;
}

function messageOf(body: unknown, fallback: string): string {
  const message = (body as { error?: { message?: unknown } })?.error?.message;
  return typeof message === "string" ? message : fallback;
}

export function createGeminiBackend(settings: GeminiSettings): LlmBackend {
  // Our provider wrapper does the retrying, so the SDK must not retry as well.
  const ai = new GoogleGenAI({
    apiKey: settings.apiKey,
    httpOptions: { retryOptions: { attempts: 1 } },
  });

  return {
    textModel: settings.textModel,
    embeddingModel: settings.embeddingModel,

    async generateJson(input: GenerateJsonInput, signal: AbortSignal) {
      let response;
      try {
        response = await ai.models.generateContent({
          model: settings.textModel,
          contents: input.prompt,
          config: {
            systemInstruction: input.system,
            responseMimeType: "application/json",
            responseJsonSchema: input.schema,
            maxOutputTokens: input.maxOutputTokens,
            thinkingConfig: { thinkingLevel: settings.thinkingLevel.toUpperCase() as ThinkingLevel },
            abortSignal: signal,
          },
        });
      } catch (error) {
        if (error instanceof ApiError) {
          // The SDK puts the response body, as JSON text, in the message.
          let body: unknown;
          try {
            body = JSON.parse(error.message);
          } catch {
            body = undefined;
          }
          throw errorFromStatus(error.status, messageOf(body, error.message), {
            retryAfterMs: retryAfterMs(body),
            cause: error,
          });
        }
        throw error;
      }

      const usage = {
        inputTokens: response.usageMetadata?.promptTokenCount ?? null,
        outputTokens:
          (response.usageMetadata?.candidatesTokenCount ?? 0) +
          (response.usageMetadata?.thoughtsTokenCount ?? 0),
      };
      const text = response.text;
      if (!text) {
        const reason = response.candidates?.[0]?.finishReason ?? "no candidates";
        throw new LlmError("invalid_output", `The model returned no text (${reason})`);
      }
      try {
        return { data: JSON.parse(text) as unknown, usage };
      } catch (error) {
        throw new LlmError("invalid_output", "The model's reply was not valid JSON", {
          cause: error,
        });
      }
    },

    // The SDK's embedContent returns one combined vector for several texts with
    // this model, so the batch endpoint is called directly. It returns one
    // vector per text and the token count.
    async embed(input: EmbedInput, signal: AbortSignal) {
      const model = `models/${settings.embeddingModel}`;
      const response = await fetch(`${API_BASE}/${model}:batchEmbedContents`, {
        method: "POST",
        // The key goes in a header, never in the URL, so it cannot end up in logs.
        headers: { "x-goog-api-key": settings.apiKey, "content-type": "application/json" },
        body: JSON.stringify({
          requests: input.texts.map((_, index) => ({
            model,
            content: { parts: [{ text: embeddingText(input, index) }] },
            outputDimensionality: settings.embeddingDimensions,
          })),
        }),
        signal,
      });

      const body: unknown = await response.json().catch(() => undefined);
      if (!response.ok) {
        throw errorFromStatus(
          response.status,
          messageOf(body, `Embedding request failed with status ${response.status}`),
          { retryAfterMs: retryAfterMs(body) },
        );
      }

      const { embeddings, usageMetadata } = body as {
        embeddings?: { values?: number[] }[];
        usageMetadata?: { promptTokenCount?: number };
      };
      const vectors = (embeddings ?? []).map((embedding) => embedding.values ?? []);
      if (vectors.some((vector) => vector.length !== settings.embeddingDimensions)) {
        throw new LlmError(
          "invalid_output",
          `Expected embeddings of ${settings.embeddingDimensions} dimensions`,
        );
      }
      return {
        vectors,
        usage: { inputTokens: usageMetadata?.promptTokenCount ?? null, outputTokens: 0 },
      };
    },
  };
}

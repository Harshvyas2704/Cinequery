import { Queue, Worker } from "bullmq";
import { Redis } from "ioredis";
import type { Logger } from "pino";
import type { EmbedBatchResult } from "../embeddings/batch.js";
import { LlmError } from "../llm/types.js";

export const EMBED_QUEUE = "embeddings";

export type EmbedJobData = { movieIds: number[] };

/** BullMQ blocks on Redis while waiting for jobs, so it needs its own connection settings. */
export function createQueueConnection(redisUrl: string): Redis {
  return new Redis(redisUrl, { maxRetriesPerRequest: null });
}

export function createEmbedQueue(connection: Redis, name = EMBED_QUEUE): Queue<EmbedJobData> {
  return new Queue<EmbedJobData>(name, { connection });
}

/** Splits the movies into batches and adds one job per batch. Returns the number of jobs. */
export async function enqueueEmbedBatches(
  queue: Queue<EmbedJobData>,
  movieIds: number[],
  options: { batchSize: number; attempts: number },
): Promise<number> {
  const jobs = [];
  for (let start = 0; start < movieIds.length; start += options.batchSize) {
    jobs.push({
      name: "embed-batch",
      data: { movieIds: movieIds.slice(start, start + options.batchSize) },
      opts: {
        attempts: options.attempts,
        backoff: { type: "exponential", delay: 5000 },
        // Finished batches are forgotten; failed ones stay so embed:status can list them.
        removeOnComplete: true,
      },
    });
  }
  // addBulk in chunks keeps each Redis command a reasonable size.
  for (let start = 0; start < jobs.length; start += 500) {
    await queue.addBulk(jobs.slice(start, start + 500));
  }
  return jobs.length;
}

/** Jobs that are still to be worked on (not failed, not completed). */
export async function remainingJobs(queue: Queue<EmbedJobData>): Promise<number> {
  const counts = await queue.getJobCounts("waiting", "active", "delayed", "prioritized");
  return Object.values(counts).reduce((sum, count) => sum + count, 0);
}

export type EmbedRunTotals = {
  batches: number;
  embedded: number;
  skipped: number;
  inputTokens: number;
  failedBatches: number;
  /** Set when the run stopped because the provider kept answering "rate limited". */
  stoppedByRateLimit: boolean;
  /** What the provider said the last time it rate limited us. */
  lastRateLimitMessage: string | null;
};

export type EmbedWorkerOptions = {
  connection: Redis;
  queueName?: string;
  processBatch: (movieIds: number[]) => Promise<EmbedBatchResult>;
  requestsPerMinute: number;
  /**
   * After this many rate-limited batches in a row the run stops, leaving the
   * remaining batches queued. This is what a used-up daily quota looks like.
   */
  rateLimitPatience: number;
  /** Pause after a rate-limited batch when the provider does not say how long to wait. */
  rateLimitPauseMs: number;
  /** If the provider asks for a longer wait than this, the run stops instead of waiting. */
  rateLimitMaxWaitMs: number;
  logger: Logger;
  onProgress?: (totals: EmbedRunTotals) => void;
};

/**
 * Starts a worker on the embeddings queue: one batch at a time, no more than
 * `requestsPerMinute` batches a minute. Each batch is one request to the API.
 */
export function startEmbedWorker(options: EmbedWorkerOptions) {
  const totals: EmbedRunTotals = {
    batches: 0,
    embedded: 0,
    skipped: 0,
    inputTokens: 0,
    failedBatches: 0,
    stoppedByRateLimit: false,
    lastRateLimitMessage: null,
  };
  let rateLimitedInARow = 0;

  const worker: Worker<EmbedJobData, EmbedBatchResult> = new Worker<EmbedJobData, EmbedBatchResult>(
    options.queueName ?? EMBED_QUEUE,
    async (job) => {
      try {
        const result = await options.processBatch(job.data.movieIds);
        rateLimitedInARow = 0;
        return result;
      } catch (error) {
        if (error instanceof LlmError && error.kind === "rate_limited") {
          rateLimitedInARow++;
          const waitMs = error.retryAfterMs ?? options.rateLimitPauseMs;
          totals.lastRateLimitMessage = error.message;
          options.logger.warn({ waitMs, reason: error.message }, "embedding batch rate limited");
          if (rateLimitedInARow >= options.rateLimitPatience || waitMs > options.rateLimitMaxWaitMs) {
            totals.stoppedByRateLimit = true;
          }
          // Put the batch back without using up one of its attempts, and hold
          // the whole queue for a while. When the run is stopping anyway, hold
          // it only briefly, so the next run is not kept waiting.
          await worker.rateLimit(totals.stoppedByRateLimit ? 1000 : waitMs);
          throw Worker.RateLimitError();
        }
        throw error;
      }
    },
    {
      connection: options.connection,
      concurrency: 1,
      limiter: { max: options.requestsPerMinute, duration: 60_000 },
    },
  );

  worker.on("completed", (_job, result) => {
    totals.batches++;
    totals.embedded += result.embedded;
    totals.skipped += result.skipped;
    totals.inputTokens += result.inputTokens;
    options.onProgress?.(totals);
  });
  worker.on("failed", (job, error) => {
    // "failed" also fires for attempts that will be retried; count only the last one.
    if (job && job.attemptsMade >= (job.opts.attempts ?? 1)) totals.failedBatches++;
    options.logger.warn({ jobId: job?.id, err: error.message }, "embedding batch failed");
  });
  worker.on("error", (error) => options.logger.warn({ err: error.message }, "embed worker error"));

  return {
    totals,
    /** Stops taking new batches and waits for the one in progress. */
    close: () => worker.close(),
    ready: () => worker.waitUntilReady(),
  };
}

/**
 * Waits until the queue has nothing left to work on, the provider's rate limit
 * stopped the run, or `shouldStop` says so. Then closes the worker, which lets
 * the batch in progress finish.
 */
export async function runUntilDone(
  queue: Queue<EmbedJobData>,
  worker: ReturnType<typeof startEmbedWorker>,
  options: { shouldStop?: () => boolean; pollMs?: number } = {},
): Promise<EmbedRunTotals> {
  await worker.ready();
  while (
    !options.shouldStop?.() &&
    !worker.totals.stoppedByRateLimit &&
    (await remainingJobs(queue)) > 0
  ) {
    await new Promise((resolve) => setTimeout(resolve, options.pollMs ?? 1000));
  }
  await worker.close();
  return worker.totals;
}

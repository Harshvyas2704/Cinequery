// Entry point for the embedding commands:
//   pnpm embed [--limit N]   embed movies that are missing or out of date
//   pnpm embed:status        queue, failed batches and coverage
//   pnpm embed:export        write the embeddings to a file
//   pnpm embed:import        load them from that file
import { join } from "node:path";
import { parseArgs } from "node:util";
import { pino } from "pino";
import { type Config, loadConfigOrExit } from "../config/env.js";
import { createPool } from "../db/pool.js";
import {
  createEmbedQueue,
  createQueueConnection,
  enqueueEmbedBatches,
  remainingJobs,
  runUntilDone,
  startEmbedWorker,
} from "../jobs/embedQueue.js";
import { createGeminiProvider } from "../llm/index.js";
import { embedBatch } from "./batch.js";
import { assertDimensionsMatch, embeddingCoverage, loadMoviesToEmbed } from "./store.js";
import { exportEmbeddings, exportFileName, importEmbeddings } from "./transfer.js";

// A used-up quota answers every request with "rate limited". After this many
// in a row the run stops; the batches stay queued for the next run.
const RATE_LIMIT_PATIENCE = 3;
const RATE_LIMIT_PAUSE_MS = 60_000;
// If the API asks for a longer wait than this, stop instead of sitting idle.
const RATE_LIMIT_MAX_WAIT_MS = 5 * 60_000;

const seconds = (since: number) => ((performance.now() - since) / 1000).toFixed(0);

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: { limit: { type: "string" } },
});
const command = positionals[0] ?? "run";

const config = loadConfigOrExit();
const logger = pino({ level: config.logLevel });
const pool = createPool(config.databaseUrl, logger);
const target = { model: config.llm.embeddingModel, dimensions: config.llm.embeddingDimensions };
const exportPath = join(config.embed.exportDir, exportFileName(target));

async function run(config: Config) {
  await assertDimensionsMatch(pool, target.dimensions);
  const llm = createGeminiProvider(config, pool, logger);
  const connection = createQueueConnection(config.redisUrl);
  const queue = createEmbedQueue(connection);
  const started = performance.now();

  try {
    // The database knows which movies still need a vector, so every run starts
    // from it: whatever an earlier run left in the queue (waiting or failed
    // batches) is dropped and the missing movies are queued again. This is why
    // only one `pnpm embed` should run at a time.
    await queue.obliterate({ force: true });

    const movies = await loadMoviesToEmbed(pool, target);
    let pending = movies
      .filter((movie) => movie.needsEmbedding)
      // Best-known movies first, so a run that a quota cuts short has still
      // embedded the films people are most likely to search for.
      .sort((a, b) => b.voteCount - a.voteCount || a.movieId - b.movieId)
      .map((movie) => movie.movieId);
    console.log(`${movies.length - pending.length} of ${movies.length} movies are up to date.`);
    const limit = values.limit ? Number(values.limit) : undefined;
    if (limit !== undefined) {
      if (!Number.isInteger(limit) || limit < 1) {
        throw new Error("--limit must be a positive whole number");
      }
      pending = pending.slice(0, limit);
    }
    if (pending.length === 0) {
      console.log("Nothing to embed.");
      return;
    }
    const jobs = await enqueueEmbedBatches(queue, pending, {
      batchSize: config.embed.batchSize,
      attempts: config.embed.jobAttempts,
    });
    console.log(
      `Queued ${pending.length} movies in ${jobs} batches ` +
        `(${config.embed.requestsPerMinute} batches a minute at most).`,
    );

    let lastReport = performance.now();
    const worker = startEmbedWorker({
      connection,
      processBatch: (movieIds) =>
        embedBatch({ pool, llm, target, timeoutMs: config.embed.timeoutMs }, movieIds),
      requestsPerMinute: config.embed.requestsPerMinute,
      rateLimitPatience: RATE_LIMIT_PATIENCE,
      rateLimitPauseMs: RATE_LIMIT_PAUSE_MS,
      rateLimitMaxWaitMs: RATE_LIMIT_MAX_WAIT_MS,
      logger,
      onProgress: (totals) => {
        if (performance.now() - lastReport < 30_000) return;
        lastReport = performance.now();
        console.log(
          `  ${totals.embedded} embedded, ${totals.inputTokens} tokens, ${seconds(started)} s`,
        );
      },
    });

    // Ctrl-C finishes the batch in progress and leaves the rest queued.
    let interrupted = false;
    process.once("SIGINT", () => {
      interrupted = true;
      console.log("\nStopping after the current batch. Run `pnpm embed` again to continue.");
    });

    const totals = await runUntilDone(queue, worker, { shouldStop: () => interrupted });
    const coverage = await embeddingCoverage(pool, target.model);
    const left = await remainingJobs(queue);
    console.log(
      [
        `Embedded ${totals.embedded} movies in ${totals.batches} batches (${totals.skipped} skipped as up to date)`,
        `Tokens   ${totals.inputTokens} input`,
        `Failed   ${totals.failedBatches} batches${totals.failedBatches > 0 ? " (see pnpm embed:status)" : ""}`,
        `Coverage ${coverage.embedded} of ${coverage.movies} movies have a ${target.model} embedding`,
        `Time     ${seconds(started)} s`,
      ].join("\n"),
    );
    if (totals.stoppedByRateLimit) {
      console.log(
        `Stopped: the API kept answering "rate limited", which usually means a quota is used up. ` +
          `${left} batches are still queued. Run \`pnpm embed\` again later to continue.`,
      );
      if (totals.lastRateLimitMessage) console.log(`The API said: ${totals.lastRateLimitMessage}`);
      process.exitCode = 2;
    }
  } finally {
    await queue.close();
    connection.disconnect();
  }
}

async function status(config: Config) {
  const connection = createQueueConnection(config.redisUrl);
  const queue = createEmbedQueue(connection);
  try {
    const counts = await queue.getJobCounts("waiting", "active", "delayed", "failed");
    const coverage = await embeddingCoverage(pool, target.model);
    const usage = await pool.query<{ status: string; calls: number; tokens: number }>(
      `SELECT status, count(*)::integer AS calls, coalesce(sum(input_tokens), 0)::integer AS tokens
       FROM llm_calls WHERE stage = 'embed_batch' GROUP BY status ORDER BY status`,
    );
    console.log(`Model     ${target.model}, ${target.dimensions} dimensions`);
    console.log(`Coverage  ${coverage.embedded} of ${coverage.movies} movies embedded`);
    console.log(
      `Queue     ${counts.waiting} waiting, ${counts.active} active, ${counts.delayed} delayed, ${counts.failed} failed`,
    );
    for (const row of usage.rows) {
      console.log(`API calls ${row.status}: ${row.calls} calls, ${row.tokens} input tokens`);
    }
    const failed = await queue.getFailed(0, 49);
    if (failed.length > 0) {
      console.log("Failed batches from the last run (up to 50). `pnpm embed` queues their movies again:");
      for (const job of failed) {
        console.log(
          `  job ${job.id}: ${job.data.movieIds.length} movies, ${job.attemptsMade} attempts, ${job.failedReason}`,
        );
      }
    }
  } finally {
    await queue.close();
    connection.disconnect();
  }
}

try {
  if (command === "run") {
    await run(config);
  } else if (command === "status") {
    await status(config);
  } else if (command === "export") {
    const count = await exportEmbeddings(pool, target, exportPath);
    console.log(`Wrote ${count} embeddings to ${exportPath}`);
  } else if (command === "import") {
    await assertDimensionsMatch(pool, target.dimensions);
    const summary = await importEmbeddings(pool, target, exportPath);
    console.log(
      `Read ${summary.inFile} embeddings from ${exportPath}: ${summary.imported} imported, ` +
        `${summary.unchanged} already up to date, ${summary.unknownMovies} for movies not in this database`,
    );
  } else {
    throw new Error(`Unknown command "${command}". Use run, status, export or import.`);
  }
} catch (error) {
  // Only the message: a stack trace is noise here, and nothing above includes the API key.
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
} finally {
  await pool.end();
}

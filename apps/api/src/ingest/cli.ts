// Entry point for `pnpm ingest`: data/clean/*.parquet -> Postgres.
import { join } from "node:path";
import { pino } from "pino";
import { loadConfigOrExit } from "../config/env.js";
import { createPool } from "../db/pool.js";
import { ingest } from "./load.js";
import { readMovies, readTags } from "./parquet.js";
import { groupTags } from "./transform.js";

const config = loadConfigOrExit();
const pool = createPool(config.databaseUrl, pino({ level: config.logLevel }));
const started = performance.now();

try {
  const [movies, tagRows] = await Promise.all([
    readMovies(join(config.dataDir, "movies.parquet")),
    readTags(join(config.dataDir, "movie_tags.parquet")),
  ]);
  console.log(`Read ${movies.length} movies and ${tagRows.length} tags from ${config.dataDir}`);

  const summary = await ingest(pool, {
    movies,
    tagsByTmdbId: groupTags(tagRows),
    batchSize: config.ingestBatchSize,
    minVotesPercentile: config.ratingMinVotesPercentile,
  });

  const seconds = ((performance.now() - started) / 1000).toFixed(1);
  console.log(
    [
      `Movies   inserted ${summary.inserted}, updated ${summary.updated}, unchanged ${summary.unchanged}`,
      `Tags     loaded ${summary.tags} (written ${summary.tagsWritten}, removed ${summary.tagsRemoved}, skipped ${summary.tagsSkipped})`,
      summary.ratingStats
        ? `Rating   mean ${summary.ratingStats.meanVoteAverage.toFixed(3)}, min votes ${summary.ratingStats.minVotes}`
        : "Rating   not computed (no movies)",
      `Time     ${seconds} s`,
    ].join("\n"),
  );
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  await pool.end();
}

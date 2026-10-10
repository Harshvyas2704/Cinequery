// The evaluation (`pnpm eval --mode fulltext|semantic|parsed|full|all`).
//
// Runs every query of eval/queries.json through the recommend pipeline with
// the steps of the mode, checks each answer against the query's checks, and
// writes the run to eval/results/<date>-<mode>.json.
//
// It calls the real Gemini API (except in mode fulltext), with nothing
// cached, so that tokens and latency are those of a first-time request.
//   --delay-ms N   pause between queries (default 4000 for modes that call the LLM)
//   --only a,b     run only the queries with these ids
//   --check        only validate the file against the catalog; no query is run
//   --report       print the comparison table of the latest saved run of each mode
//
// A run stops, and saves nothing, when several queries in a row fall back:
// that is what a used-up quota looks like, and its numbers would mean nothing.
// A run with --only is printed but not saved, so it cannot replace a full run.
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { createRedis } from "../cache/redis.js";
import { type Config, loadConfigOrExit } from "../config/env.js";
import { createPool } from "../db/pool.js";
import { createTokenBudget, unlimitedBudget } from "../limits/budget.js";
import { createGeminiProvider } from "../llm/index.js";
import { PARSE_PROMPT_VERSION } from "../llm/prompts/parse-v1.js";
import { PICK_PROMPT_VERSION } from "../llm/prompts/pick-v1.js";
import { createLogger } from "../logger.js";
import { recommend, type RecommendDeps } from "../recommend/pipeline.js";
import { loadFacts, loadTokens } from "./facts.js";
import { type EvalSummary, type QueryResult, runEval, SKIPPED_STEPS } from "./run.js";
import { EVAL_MODES, type EvalFile, evalFileSchema, type EvalMode } from "./schema.js";

const QUERIES_FILE = fileURLToPath(new URL("../../../../eval/queries.json", import.meta.url));
const RESULTS_DIR = fileURLToPath(new URL("../../../../eval/results/", import.meta.url));

const { values } = parseArgs({
  options: {
    mode: { type: "string", default: "all" },
    "delay-ms": { type: "string" },
    only: { type: "string" },
    check: { type: "boolean", default: false },
    report: { type: "boolean", default: false },
  },
});

const config = loadConfigOrExit();
const logger = createLogger("warn");
const pool = createPool(config.databaseUrl, logger);

function loadQueries(): EvalFile {
  const parsed = evalFileSchema.safeParse(JSON.parse(readFileSync(QUERIES_FILE, "utf8")));
  if (!parsed.success) {
    const problems = parsed.error.issues.map((issue) => `  ${issue.path.join(".")}: ${issue.message}`);
    throw new Error(`eval/queries.json is not valid:\n${problems.join("\n")}`);
  }
  const only = values.only?.split(",").map((id) => id.trim());
  if (!only) return parsed.data;
  const queries = parsed.data.queries.filter((query) => only.includes(query.id));
  if (queries.length !== only.length) throw new Error(`--only names a query id that does not exist`);
  return { ...parsed.data, queries };
}

/** Every movie the file names must be in the catalog, under the title the file gives. */
async function checkAgainstCatalog(file: EvalFile): Promise<number> {
  const named = file.queries.flatMap((query) =>
    [...(query.checks.anyOfMovies ?? []), ...(query.checks.noneOfMovies ?? [])].map((movie) => ({
      ...movie,
      query: query.id,
    })),
  );
  const { rows } = await pool.query<{ tmdb_id: number; title: string; embedded: boolean }>(
    `SELECT m.tmdb_id, m.title, e.movie_id IS NOT NULL AS embedded
     FROM movies m
     LEFT JOIN movie_embeddings e ON e.movie_id = m.id AND e.model = $2
     WHERE m.tmdb_id = ANY($1::integer[])`,
    [named.map((movie) => movie.tmdbId), config.llm.embeddingModel],
  );
  const inCatalog = new Map(rows.map((row) => [row.tmdb_id, row]));

  let problems = 0;
  for (const movie of named) {
    const found = inCatalog.get(movie.tmdbId);
    if (!found) {
      console.log(`  ${movie.query}: tmdbId ${movie.tmdbId} ("${movie.title}") is not in the catalog`);
      problems++;
    } else if (found.title.toLowerCase() !== movie.title.toLowerCase()) {
      console.log(`  ${movie.query}: tmdbId ${movie.tmdbId} is "${found.title}", not "${movie.title}"`);
      problems++;
    }
  }
  const expected = file.queries.flatMap((query) => query.checks.anyOfMovies ?? []);
  const embedded = expected.filter((movie) => inCatalog.get(movie.tmdbId)?.embedded).length;
  console.log(
    `${file.queries.length} queries, ${expected.length} expected movies, ` +
      `${embedded} of them have an embedding (only those can be found by meaning).`,
  );
  return problems;
}

const percent = (value: number | null) => (value === null ? "   -" : `${Math.round(value * 100)}%`.padStart(4));

function printQuery(result: QueryResult, index: number, total: number) {
  const marks = [
    `pass ${percent(result.constraintPass)}`,
    `tags ${percent(result.tagMatch)}`,
    `hit ${result.hit === null ? " - " : result.hit ? "yes" : "no "}`,
    `${String(result.ms).padStart(5)} ms`,
    `${result.tokens.input + result.tokens.output} tok`,
    result.fallbacks > 0 ? `${result.fallbacks} fallback` : "",
    result.spoilers.length > 0 ? `${result.spoilers.length} SPOILER` : "",
  ].filter(Boolean);
  console.log(`  ${String(index + 1).padStart(2)}/${total} ${result.id.padEnd(24)} ${marks.join("  ")}`);
}

// After this many queries in a row with a failed LLM step, the run is abandoned.
const FALLBACKS_BEFORE_STOP = 3;

function configOf(config: Config, file: EvalFile) {
  return {
    limit: file.limit,
    embeddingModel: config.llm.embeddingModel,
    embeddingDimensions: config.llm.embeddingDimensions,
    parse: { model: config.recommend.parse.model, thinkingLevel: config.recommend.parse.thinkingLevel },
    pick: {
      model: config.recommend.pick.model,
      thinkingLevel: config.recommend.pick.thinkingLevel,
      candidates: config.recommend.pick.candidates,
    },
    candidates: config.recommend.candidates,
    weights: config.recommend.weights,
    searchWeights: config.search.weights,
    reference: config.recommend.reference,
  };
}

async function runMode(mode: EvalMode, file: EvalFile, deps: RecommendDeps): Promise<EvalSummary> {
  const callsLlm = SKIPPED_STEPS[mode].length < 3;
  const delayMs = values["delay-ms"] !== undefined ? Number(values["delay-ms"]) : callsLlm ? 4000 : 0;
  const startedAt = new Date();
  // Distinct per run, so the tokens of each request can be found in llm_calls.
  const runId = `eval-${mode}-${startedAt.getTime().toString(36)}`;
  console.log(`\nMode ${mode} (${file.queries.length} queries${delayMs ? `, ${delayMs} ms apart` : ""})`);
  let failedInARow = 0;

  const { results, summary } = await runEval(file, runId, {
    ask: (query, requestId) =>
      recommend(deps, { query: query.query, limit: file.limit }, { requestId, skip: SKIPPED_STEPS[mode] }),
    facts: (ids) => loadFacts(pool, ids),
    tokens: (requestId) => loadTokens(pool, requestId),
    delayMs,
    onQuery: (result, index, total) => {
      printQuery(result, index, total);
      failedInARow = result.fallbacks > 0 ? failedInARow + 1 : 0;
      if (failedInARow >= FALLBACKS_BEFORE_STOP) {
        throw new Error(
          `Stopped mode ${mode}: ${FALLBACKS_BEFORE_STOP} queries in a row had a failed LLM step ` +
            `(${result.stages.filter((stage) => stage.status === "fallback").map((stage) => stage.name).join(", ")}). ` +
            "This is usually a used-up quota; the provider's message is in the warning above. " +
            "Nothing was saved. Run it again later.",
        );
      }
    },
  });

  const catalog = await pool.query<{ movies: number; embedded: number }>(
    `SELECT (SELECT count(*) FROM movies)::integer AS movies,
            (SELECT count(*) FROM movie_embeddings WHERE model = $1)::integer AS embedded`,
    [config.llm.embeddingModel],
  );
  if (values.only) {
    console.log("  not saved: a run with --only is not a full run");
    return summary;
  }
  mkdirSync(RESULTS_DIR, { recursive: true });
  const path = `${RESULTS_DIR}${startedAt.toISOString().slice(0, 10)}-${mode}.json`;
  writeFileSync(
    path,
    `${JSON.stringify(
      {
        runId,
        mode,
        startedAt: startedAt.toISOString(),
        skippedSteps: SKIPPED_STEPS[mode],
        promptVersions: { parse: PARSE_PROMPT_VERSION, pick: PICK_PROMPT_VERSION },
        config: configOf(config, file),
        catalog: catalog.rows[0],
        summary,
        results,
      },
      null,
      2,
    )}\n`,
  );
  console.log(`  saved to eval/results/${path.slice(RESULTS_DIR.length)}`);
  return summary;
}

function printComparison(summaries: [EvalMode, EvalSummary][]) {
  const rows: [string, (summary: EvalSummary) => string][] = [
    ["Constraint pass rate", (s) => percent(s.constraintPassRate)],
    ["Hit rate", (s) => percent(s.hitRate)],
    ["Tag match rate", (s) => percent(s.tagMatchRate)],
    ["Movies with a reason", (s) => percent(s.reasonRate)],
    ["Spoiler check failures", (s) => String(s.spoilerFailures)],
    ["Fallbacks", (s) => String(s.fallbacks)],
    ["Empty answers", (s) => String(s.emptyAnswers)],
    ["Latency p50 (ms)", (s) => String(s.latencyMs.p50 ?? "-")],
    ["Latency p95 (ms)", (s) => String(s.latencyMs.p95 ?? "-")],
    ["Tokens per query", (s) => String(s.tokensPerQuery ?? "-")],
  ];
  console.log(`\n${"".padEnd(24)}${summaries.map(([mode]) => mode.padStart(10)).join("")}`);
  for (const [label, value] of rows) {
    console.log(`${label.padEnd(24)}${summaries.map(([, summary]) => value(summary).padStart(10)).join("")}`);
  }
}

/** The comparison table as Markdown, from the latest saved run of each mode. */
function printReport() {
  const files = existsSync(RESULTS_DIR) ? readdirSync(RESULTS_DIR).sort() : [];
  const latest = EVAL_MODES.flatMap((mode) => {
    const name = files.filter((file) => file.endsWith(`-${mode}.json`)).at(-1);
    if (!name) return [];
    const run = JSON.parse(readFileSync(`${RESULTS_DIR}${name}`, "utf8")) as { summary: EvalSummary };
    return [{ mode, name, summary: run.summary }];
  });
  if (latest.length === 0) {
    console.log("No saved runs in eval/results yet.");
    return;
  }
  const ms = (value: number | null) => (value === null ? "-" : `${value} ms`);
  const rows: [string, (summary: EvalSummary) => string][] = [
    ["Constraint pass rate", (s) => percent(s.constraintPassRate).trim()],
    ["Hit rate", (s) => percent(s.hitRate).trim()],
    ["Tag match rate", (s) => percent(s.tagMatchRate).trim()],
    ["Movies with a reason", (s) => percent(s.reasonRate).trim()],
    ["Spoiler check failures", (s) => String(s.spoilerFailures)],
    ["Fallbacks", (s) => String(s.fallbacks)],
    ["Latency p50", (s) => ms(s.latencyMs.p50)],
    ["Latency p95", (s) => ms(s.latencyMs.p95)],
    ["Tokens per query", (s) => String(s.tokensPerQuery ?? "-")],
  ];
  console.log(`| Measure | ${latest.map((run) => run.mode).join(" | ")} |`);
  console.log(`| --- | ${latest.map(() => "---").join(" | ")} |`);
  for (const [label, value] of rows) {
    console.log(`| ${label} | ${latest.map((run) => value(run.summary)).join(" | ")} |`);
  }
  console.log(`\nFrom: ${latest.map((run) => `eval/results/${run.name}`).join(", ")}`);
  const missing = EVAL_MODES.filter((mode) => !latest.some((run) => run.mode === mode));
  if (missing.length > 0) console.log(`No saved run yet for: ${missing.join(", ")}`);
}

const redis = createRedis(config.redisUrl, logger);

async function main() {
  const file = loadQueries();
  const problems = await checkAgainstCatalog(file);
  if (problems > 0) throw new Error(`${problems} movies named in eval/queries.json do not match the catalog`);

  if (!values.check) {
    const modes = values.mode === "all" ? [...EVAL_MODES] : [values.mode as EvalMode];
    if (!modes.every((mode) => EVAL_MODES.includes(mode))) {
      throw new Error(`Unknown mode "${values.mode}". Use ${EVAL_MODES.join(", ")} or all.`);
    }
    // What the evaluation uses counts toward the API's daily token budget.
    const budget = createTokenBudget(redis, { ...config.budget, logger });
    const needsLlm = modes.some((mode) => SKIPPED_STEPS[mode].length < 3);
    const llm = needsLlm
      ? createGeminiProvider(config, pool, logger, {
          retry: config.llm.onlineRetry,
          maxConcurrent: config.llm.maxConcurrent,
          onTokens: (tokens) => budget.add(tokens),
        })
      : null;
    // Nothing is cached, so every query is measured as a first-time request,
    // and the evaluation itself is never held back by the budget.
    const noCache = { get: async () => null, set: async () => {} };
    const deps: RecommendDeps = {
      pool,
      llm,
      embeddingCache: noCache,
      parseCache: noCache,
      pickCache: noCache,
      budget: unlimitedBudget,
      vector: {
        model: config.llm.embeddingModel,
        candidates: config.recommend.candidates,
        weights: config.recommend.weights,
        posterBaseUrl: config.search.posterBaseUrl,
      },
      search: config.search,
      parse: config.recommend.parse,
      pick: config.recommend.pick,
      embedTimeoutMs: config.recommend.embedTimeoutMs,
      reference: config.recommend.reference,
      logger,
    };

    const summaries: [EvalMode, EvalSummary][] = [];
    for (const mode of modes) summaries.push([mode, await runMode(mode, file, deps)]);
    printComparison(summaries);
  }
}

try {
  if (values.report) printReport();
  else await main();
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
} finally {
  redis.disconnect();
  await pool.end();
}

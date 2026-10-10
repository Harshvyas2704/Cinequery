import {
  RECOMMEND_QUERY_MAX_LENGTH,
  RECOMMEND_QUERY_MIN_LENGTH,
  type RecommendResponse,
} from "@cinequery/shared";
import { type FormEvent, useEffect, useState } from "react";
import { ApiError, recommendMovies } from "./api.ts";
import { MovieCard } from "./MovieCard.tsx";
import {
  describeParsed,
  describeRelaxed,
  describeStages,
  searchedByMeaning,
  totalMs,
} from "./stages.ts";

const EXAMPLES = [
  "space movie about loneliness",
  "a prison escape",
  "feel-good comedy about friendship",
  "dark crime story with a twist",
  "koi achhi suspense movie batao",
];

// The answer to the latest request. `query` says which request it answers, so
// "is a request running" is "the answer is not for the current query".
type Outcome = { query: string; response: RecommendResponse | null; error: string | null };

const queryFromUrl = () => new URLSearchParams(window.location.search).get("q")?.trim() ?? "";

function HowThisWasFound({ meta }: { meta: RecommendResponse["meta"] }) {
  const rows = describeStages(meta);
  const understood = meta.parsed ? describeParsed(meta.parsed) : [];
  const relaxed = describeRelaxed(meta.relaxed);
  return (
    <details className="how" open={relaxed !== null || rows.some((row) => row.problem) || undefined}>
      <summary>
        How this was found
        <span className="how-summary">
          {searchedByMeaning(meta) ? "by meaning" : "by keywords"} · {totalMs(meta)} ms
        </span>
      </summary>
      {meta.parsed && (
        <p className="understood">
          <span className="label">Understood as</span>
          {understood.map((label) => (
            <span key={label} className="tag">
              {label}
            </span>
          ))}
          <span className="search-text">“{meta.parsed.searchText}”</span>
        </p>
      )}
      {relaxed && <p className="relaxed">{relaxed}</p>}
      <table>
        <thead>
          <tr>
            <th scope="col">Step</th>
            <th scope="col">What happened</th>
            <th scope="col" className="number">
              Time
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.step} className={row.problem ? "problem" : undefined}>
              <th scope="row">{row.step}</th>
              <td>{row.result}</td>
              <td className="number">{row.ms} ms</td>
            </tr>
          ))}
        </tbody>
      </table>
    </details>
  );
}

export function RecommendPage() {
  const [query, setQuery] = useState(queryFromUrl);
  const [text, setText] = useState(query);
  const [outcome, setOutcome] = useState<Outcome | null>(null);

  const loading = query !== "" && outcome?.query !== query;

  useEffect(() => {
    window.history.replaceState(
      null,
      "",
      query ? `?${new URLSearchParams({ q: query })}` : window.location.pathname,
    );
    if (!query) return;

    const controller = new AbortController();
    recommendMovies(query, controller.signal)
      .then((response) => setOutcome({ query, response, error: null }))
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        const message =
          error instanceof ApiError ? error.message : "Recommendations are not available right now.";
        setOutcome({ query, response: null, error: message });
      });
    return () => controller.abort();
  }, [query]);

  const ask = (next: string) => {
    setText(next);
    setQuery(next.trim());
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    ask(text);
  };

  const shown = outcome && query !== "" ? outcome : null;
  const results = shown?.response?.results ?? [];

  return (
    <>
      <form className="search" role="search" onSubmit={submit}>
        <label className="visually-hidden" htmlFor="request">
          What do you feel like watching?
        </label>
        <input
          id="request"
          type="search"
          value={text}
          minLength={RECOMMEND_QUERY_MIN_LENGTH}
          maxLength={RECOMMEND_QUERY_MAX_LENGTH}
          required
          placeholder="What do you feel like watching?"
          onChange={(event) => setText(event.target.value)}
        />
        <button type="submit" className="primary">
          Recommend
        </button>
      </form>

      <div className="examples">
        <span>Try:</span>
        {EXAMPLES.map((example) => (
          <button key={example} type="button" className="chip" onClick={() => ask(example)}>
            {example}
          </button>
        ))}
      </div>

      <section aria-live="polite" aria-busy={loading}>
        {loading && <p className="result-count">Finding movies…</p>}

        {!loading && shown?.error && (
          <p className="note error" role="alert">
            {shown.error}
          </p>
        )}

        {!loading && shown?.response && results.length === 0 && (
          <p className="result-count">Nothing matched. Try describing it another way.</p>
        )}

        {shown?.response && results.length > 0 && (
          <>
            {!loading && <HowThisWasFound meta={shown.response.meta} />}
            <ul className={`grid${loading ? " stale" : ""}`}>
              {results.map(({ movie }) => (
                <MovieCard key={movie.id} movie={movie} />
              ))}
            </ul>
          </>
        )}
      </section>
    </>
  );
}

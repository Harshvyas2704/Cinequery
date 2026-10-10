import { CURATED_TAGS, GENRES, LANGUAGES, type SearchResult } from "@cinequery/shared";
import { type FormEvent, useEffect, useRef, useState } from "react";
import { ApiError, searchMovies } from "./api.ts";
import {
  countActive,
  EMPTY_FILTERS,
  type Filters,
  fromQueryString,
  toggle,
  toQueryString,
} from "./filters.ts";
import { MovieCard } from "./MovieCard.tsx";

// The outcome of the latest search. `key` is the query string it answers, so
// "is a search running" is simply "the outcome is not for the current filters".
type Outcome = {
  key: string | null;
  results: SearchResult[];
  total: number;
  error: string | null;
};

const PLOT_TAGS = CURATED_TAGS.filter((tag) => tag.group === "plot");
const MOOD_TAGS = CURATED_TAGS.filter((tag) => tag.group === "mood");

function Chips(props: {
  label: string;
  options: readonly string[];
  selected: string[];
  onToggle: (option: string) => void;
}) {
  return (
    <fieldset className="chips">
      <legend>{props.label}</legend>
      {props.options.map((option) => (
        <button
          key={option}
          type="button"
          className="chip"
          aria-pressed={props.selected.includes(option)}
          onClick={() => props.onToggle(option)}
        >
          {option}
        </button>
      ))}
    </fieldset>
  );
}

export function SearchPage() {
  const [filters, setFilters] = useState<Filters>(() => fromQueryString(window.location.search));
  const [text, setText] = useState(filters.q);
  const [outcome, setOutcome] = useState<Outcome>({ key: null, results: [], total: 0, error: null });
  const [loadingMore, setLoadingMore] = useState(false);
  const moreRequest = useRef<AbortController | null>(null);

  const key = toQueryString(filters);
  const searching = outcome.key !== key;
  const active = countActive(filters);

  // Search whenever the filters change, and keep the page URL shareable.
  useEffect(() => {
    const controller = new AbortController();
    moreRequest.current?.abort();
    // Keep the #browse part, or a reload would open the home page.
    window.history.replaceState(
      null,
      "",
      (key ? `?${key}` : window.location.pathname) + window.location.hash,
    );

    searchMovies(filters, 0, controller.signal)
      .then((page) => setOutcome({ key, results: page.results, total: page.total, error: null }))
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        const message =
          error instanceof ApiError ? error.message : "Search is not available right now.";
        setOutcome({ key, results: [], total: 0, error: message });
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoadingMore(false);
      });
    return () => controller.abort();
    // `key` is the filters as a string, so it changes exactly when they do.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    setFilters({ ...filters, q: text.trim() });
  };

  const clear = () => {
    setText("");
    setFilters(EMPTY_FILTERS);
  };

  const loadMore = () => {
    const controller = new AbortController();
    moreRequest.current = controller;
    setLoadingMore(true);
    searchMovies(filters, outcome.results.length, controller.signal)
      .then((page) =>
        setOutcome((current) =>
          current.key === key
            ? { ...current, results: [...current.results, ...page.results], total: page.total }
            : current,
        ),
      )
      .catch(() => {
        if (controller.signal.aborted) return;
        setOutcome((current) => ({ ...current, error: "Could not load more movies." }));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoadingMore(false);
      });
  };

  const hasMore = outcome.results.length < outcome.total;

  return (
    <>
      <form className="search" role="search" onSubmit={submit}>
        <label className="visually-hidden" htmlFor="q">
          Search movies
        </label>
        <input
          id="q"
          type="search"
          value={text}
          maxLength={200}
          placeholder="Search by title, keyword or plot, e.g. heist"
          onChange={(event) => setText(event.target.value)}
        />
        <button type="submit" className="primary">
          Search
        </button>
      </form>

      <details className="filters" open={active > 0 ? true : undefined}>
        <summary>
          Filters{active > 0 && <span className="count">{active}</span>}
        </summary>

        <div className="filter-row">
          <label>
            Language
            <select
              value={filters.language}
              onChange={(event) => setFilters({ ...filters, language: event.target.value })}
            >
              <option value="">Any</option>
              {LANGUAGES.map((language) => (
                <option key={language.code} value={language.code}>
                  {language.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            From year
            <input
              type="number"
              inputMode="numeric"
              min={1870}
              max={2100}
              placeholder="Any"
              value={filters.yearFrom}
              onChange={(event) => setFilters({ ...filters, yearFrom: event.target.value })}
            />
          </label>
          <label>
            To year
            <input
              type="number"
              inputMode="numeric"
              min={1870}
              max={2100}
              placeholder="Any"
              value={filters.yearTo}
              onChange={(event) => setFilters({ ...filters, yearTo: event.target.value })}
            />
          </label>
          {(active > 0 || filters.q) && (
            <button type="button" className="link" onClick={clear}>
              Clear all
            </button>
          )}
        </div>

        <Chips
          label="Genres"
          options={GENRES}
          selected={filters.genres}
          onToggle={(genre) => setFilters({ ...filters, genres: toggle(filters.genres, genre) })}
        />
        <Chips
          label="Plot"
          options={PLOT_TAGS.map((tag) => tag.tag)}
          selected={filters.tags}
          onToggle={(tag) => setFilters({ ...filters, tags: toggle(filters.tags, tag) })}
        />
        <Chips
          label="Mood"
          options={MOOD_TAGS.map((tag) => tag.tag)}
          selected={filters.tags}
          onToggle={(tag) => setFilters({ ...filters, tags: toggle(filters.tags, tag) })}
        />
      </details>

      <section aria-live="polite" aria-busy={searching}>
        {outcome.error && (
          <p className="note error" role="alert">
            {outcome.error}
          </p>
        )}

        {!outcome.error && outcome.key !== null && (
          <p className="result-count">
            {searching
              ? "Searching…"
              : outcome.total === 0
                ? "No movies match. Try fewer filters or a different word."
                : `${outcome.total.toLocaleString()} ${outcome.total === 1 ? "movie" : "movies"}`}
          </p>
        )}

        {outcome.key === null && <p className="result-count">Searching…</p>}

        <ul className={`grid${searching ? " stale" : ""}`}>
          {outcome.results.map(({ movie }) => (
            <MovieCard key={movie.id} movie={movie} />
          ))}
        </ul>

        {hasMore && !searching && (
          <div className="more">
            <button type="button" onClick={loadMore} disabled={loadingMore}>
              {loadingMore ? "Loading…" : "Show more"}
            </button>
          </div>
        )}
      </section>
    </>
  );
}

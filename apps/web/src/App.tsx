import { useEffect, useState } from "react";
import { RecommendPage } from "./RecommendPage.tsx";
import { SearchPage } from "./SearchPage.tsx";
import { StatusPage } from "./StatusPage.tsx";

type View = "recommend" | "browse" | "status";

function currentView(): View {
  if (window.location.hash === "#browse") return "browse";
  if (window.location.hash === "#status") return "status";
  return "recommend";
}

export function App() {
  const [view, setView] = useState<View>(currentView);

  useEffect(() => {
    const onHashChange = () => setView(currentView());
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);

  // Each view keeps its own state in the query string, so leave it behind when switching.
  const link = (target: View, label: string) => (
    <a
      href={`${window.location.pathname}${target === "recommend" ? "" : `#${target}`}`}
      aria-current={view === target ? "page" : undefined}
    >
      {label}
    </a>
  );

  return (
    <>
      <main>
        <header className="top">
          <h1>Movie Recommendation Engine</h1>
          <nav aria-label="Pages">
            {link("recommend", "Recommend")}
            {link("browse", "Browse")}
          </nav>
        </header>
        {view === "recommend" && <RecommendPage />}
        {view === "browse" && <SearchPage />}
        {view === "status" && <StatusPage />}
      </main>
      <footer>
        <p>
          This product uses the TMDB API but is not endorsed or certified by TMDB. Movie data and
          posters come from <a href="https://www.themoviedb.org/">TMDB</a>.
        </p>
        <p>
          Mood and plot tags come from the MovieLens Tag Genome by{" "}
          <a href="https://grouplens.org/datasets/movielens/">GroupLens</a>. Non-commercial demo.
        </p>
        <p>{link("status", "System status")}</p>
      </footer>
    </>
  );
}

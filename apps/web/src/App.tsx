import { useEffect, useState } from "react";
import { SearchPage } from "./SearchPage.tsx";
import { StatusPage } from "./StatusPage.tsx";

const isStatus = () => window.location.hash === "#status";

export function App() {
  const [showStatus, setShowStatus] = useState(isStatus);

  useEffect(() => {
    const onHashChange = () => setShowStatus(isStatus());
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);

  return (
    <>
      <main>
        <h1>
          <a href="#">Movie Recommendation Engine</a>
        </h1>
        {showStatus ? <StatusPage /> : <SearchPage />}
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
        <p>{showStatus ? <a href="#">Back to search</a> : <a href="#status">System status</a>}</p>
      </footer>
    </>
  );
}

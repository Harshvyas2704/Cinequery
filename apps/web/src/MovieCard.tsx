import type { MovieSummary } from "@cinequery/shared";

export function MovieCard({ movie }: { movie: MovieSummary }) {
  const facts = [
    movie.releaseYear,
    movie.runtimeMinutes ? `${movie.runtimeMinutes} min` : null,
    movie.language?.toUpperCase(),
  ].filter(Boolean);

  return (
    <li className="movie">
      {movie.posterUrl ? (
        <img
          className="poster"
          src={movie.posterUrl}
          alt=""
          loading="lazy"
          width={342}
          height={513}
        />
      ) : (
        <div className="poster placeholder" aria-hidden="true">
          No poster
        </div>
      )}
      <div className="movie-body">
        <h3>{movie.title}</h3>
        <p className="facts">
          {movie.voteAverage !== null && (
            <span className="rating" title={`${movie.voteCount.toLocaleString()} votes on TMDB`}>
              <span aria-hidden="true">★</span>
              <span className="visually-hidden">Rated</span> {movie.voteAverage.toFixed(1)}
            </span>
          )}
          {facts.join(" · ")}
        </p>
        <p className="genres">{movie.genres.join(", ")}</p>
        <p className="overview">{movie.overview}</p>
      </div>
    </li>
  );
}

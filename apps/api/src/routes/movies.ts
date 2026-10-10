import { CURATED_TAGS, GENRES, searchQuerySchema } from "@cinequery/shared";
import { Router } from "express";
import type pg from "pg";
import { z } from "zod";
import { getMovie, type SearchSettings, searchMovies } from "../search/movies.js";
import { HttpError, parseRequest } from "./errors.js";

export type MoviesDeps = {
  pool: Pick<pg.Pool, "query">;
  search: SearchSettings;
};

const idParams = z.object({
  id: z.coerce
    .number({ error: "id must be a positive whole number" })
    .int({ error: "id must be a positive whole number" })
    .positive({ error: "id must be a positive whole number" })
    .max(2_147_483_647, { error: "id must be a positive whole number" }),
});

/** Routes under /api: movie search, one movie, and the lists the filters are built from. */
export function moviesRouter({ pool, search }: MoviesDeps): Router {
  const router = Router();

  router.get("/movies/search", async (req, res) => {
    const query = parseRequest(searchQuerySchema, req.query);
    res.json(await searchMovies(pool, query, search));
  });

  router.get("/movies/:id", async (req, res) => {
    const { id } = parseRequest(idParams, req.params);
    const movie = await getMovie(pool, id, search);
    if (!movie) throw new HttpError(404, "not_found", `No movie with id ${id}`);
    res.json(movie);
  });

  router.get("/genres", (_req, res) => {
    res.json({ genres: GENRES });
  });

  router.get("/tags", (_req, res) => {
    res.json({ tags: CURATED_TAGS.map(({ tag, group }) => ({ tag, group })) });
  });

  return router;
}

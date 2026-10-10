import { recommendRequestSchema } from "@cinequery/shared";
import { Router } from "express";
import { recommend, type RecommendDeps } from "../recommend/pipeline.js";
import { parseRequest } from "./errors.js";

export function recommendRouter(deps: RecommendDeps): Router {
  const router = Router();

  router.post("/recommend", async (req, res) => {
    const request = parseRequest(recommendRequestSchema, req.body ?? {});
    res.json(await recommend(deps, request));
  });

  return router;
}

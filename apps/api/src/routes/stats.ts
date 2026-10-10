import { createHash, timingSafeEqual } from "node:crypto";
import { Router } from "express";
import type pg from "pg";
import type { TokenBudget } from "../limits/budget.js";
import { loadStats } from "../stats/stats.js";
import { HttpError } from "./errors.js";

export type StatsDeps = {
  pool: Pick<pg.Pool, "query">;
  budget: TokenBudget;
  adminToken: string;
  now?: () => Date;
};

// Hashing first gives both sides the same length, which timingSafeEqual needs,
// and the comparison then takes the same time whatever was sent.
const digest = (text: string) => createHash("sha256").update(text).digest();

/** GET /api/stats, for whoever holds the admin token. */
export function statsRouter(deps: StatsDeps): Router {
  const router = Router();
  const expected = digest(deps.adminToken);

  router.get("/stats", async (req, res) => {
    const sent = /^Bearer (.+)$/.exec(req.get("authorization") ?? "")?.[1];
    if (sent === undefined || !timingSafeEqual(digest(sent), expected)) {
      res.set("www-authenticate", "Bearer");
      throw new HttpError(401, "unauthorized", "A valid admin token is required");
    }
    // Numbers about usage are nobody else's business, including caches'.
    res.set("cache-control", "no-store");
    res.json(await loadStats(deps.pool, deps.budget, deps.now?.() ?? new Date()));
  });

  return router;
}

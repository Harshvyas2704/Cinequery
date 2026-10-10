import { RECOMMEND_WHY_MAX_LENGTH, type Recommendation } from "@cinequery/shared";
import { z } from "zod";

/** What the pick step keeps of the model's reply: an id and a reason. */
export const pickSchema = z.object({ id: z.number().int(), why: z.string() });
export const picksSchema = z.array(pickSchema);
export type Pick = z.infer<typeof pickSchema>;

// The reply as the model sent it. Each pick is checked on its own, so one bad
// pick does not lose the others.
const rawPickReplySchema = z.object({ picks: z.array(z.unknown()) });
const rawPickSchema = z.object({ id: z.number().int(), why: z.string().catch("") });

/** One line, no stray whitespace, never longer than the response schema allows. */
function cleanReason(why: string): string {
  const text = why.replace(/\s+/g, " ").trim();
  if (text.length <= RECOMMEND_WHY_MAX_LENGTH) return text;
  return `${text.slice(0, RECOMMEND_WHY_MAX_LENGTH - 1).trimEnd()}…`;
}

/**
 * Checks the model's picks against the candidates (PLAN.md 7.4). The database
 * decides which movies exist: an id that is not a candidate is dropped, and so
 * is a second mention of the same movie. Returns null when the reply does not
 * have the expected shape at all.
 */
export function validatePicks(
  reply: unknown,
  candidateIds: ReadonlySet<number>,
): { picks: Pick[]; dropped: number } | null {
  const parsed = rawPickReplySchema.safeParse(reply);
  if (!parsed.success) return null;

  const picks: Pick[] = [];
  const seen = new Set<number>();
  let dropped = 0;
  for (const item of parsed.data.picks) {
    const pick = rawPickSchema.safeParse(item);
    if (!pick.success || !candidateIds.has(pick.data.id) || seen.has(pick.data.id)) {
      dropped++;
      continue;
    }
    seen.add(pick.data.id);
    picks.push({ id: pick.data.id, why: cleanReason(pick.data.why) });
  }
  return { picks, dropped };
}

/**
 * The final list: the picked movies in the model's order with their reasons,
 * then, if there are fewer than `limit`, the next movies in search order
 * without a reason.
 */
export function applyPicks(
  candidates: Recommendation[],
  picks: Pick[],
  limit: number,
): Recommendation[] {
  const byId = new Map(candidates.map((candidate) => [candidate.movie.id, candidate]));
  const results: Recommendation[] = [];
  const used = new Set<number>();

  for (const pick of picks) {
    const candidate = byId.get(pick.id);
    if (!candidate || used.has(pick.id) || results.length >= limit) continue;
    used.add(pick.id);
    results.push(pick.why ? { ...candidate, why: pick.why } : candidate);
  }
  for (const candidate of candidates) {
    if (results.length >= limit) break;
    if (!used.has(candidate.movie.id)) results.push(candidate);
  }
  return results;
}

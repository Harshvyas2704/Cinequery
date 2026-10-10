import {
  type RecommendResponse,
  type RecommendStreamEvent,
  recommendRequestSchema,
} from "@cinequery/shared";
import { type Request, type Response, Router } from "express";
import { recommend, type RecommendDeps } from "../recommend/pipeline.js";
import type { RequestRecord, RequestRecorder } from "../stats/requestLog.js";
import { parseRequest } from "./errors.js";

export type RecommendRouteDeps = RecommendDeps & {
  /** Writes one row per request, for GET /api/stats. */
  recordRequest: RequestRecorder;
};

/**
 * A signal that fires if the client goes away before the response is complete.
 * The pipeline then stops instead of paying for an answer nobody will read.
 */
function untilDisconnect(res: Response): AbortSignal {
  const controller = new AbortController();
  res.on("close", () => {
    if (!res.writableFinished) controller.abort();
  });
  return controller.signal;
}

export function recommendRouter(deps: RecommendRouteDeps): Router {
  const router = Router();

  // Runs the pipeline and logs how the request went, whichever way it ends.
  async function answer(
    req: Request,
    route: RequestRecord["route"],
    signal: AbortSignal,
    run: (requestId: string) => Promise<RecommendResponse>,
  ): Promise<RecommendResponse> {
    const requestId = String(req.id);
    const started = performance.now();
    const log = (outcome: RequestRecord["outcome"], response?: RecommendResponse) =>
      deps.recordRequest({
        requestId,
        route,
        outcome,
        cached: response?.meta.cached ?? false,
        results: response?.results.length ?? 0,
        totalMs: Math.round(performance.now() - started),
        stages: response?.meta.stages ?? [],
      });
    try {
      const response = await run(requestId);
      await log("ok", response);
      return response;
    } catch (error) {
      await log(signal.aborted ? "cancelled" : "error");
      throw error;
    }
  }

  router.post("/recommend", async (req, res) => {
    const request = parseRequest(recommendRequestSchema, req.body ?? {});
    const signal = untilDisconnect(res);
    try {
      res.json(
        await answer(req, "recommend", signal, (requestId) =>
          recommend(deps, request, { requestId, signal }),
        ),
      );
    } catch (error) {
      // Nobody is listening any more, so there is nothing to answer.
      if (signal.aborted) return;
      throw error;
    }
  });

  // The same answer as Server-Sent Events, so the search results can be shown
  // while the pick step is still running (events: see packages/shared).
  router.post("/recommend/stream", async (req, res) => {
    // An invalid request is answered with a normal 400 before the stream starts.
    const request = parseRequest(recommendRequestSchema, req.body ?? {});
    const signal = untilDisconnect(res);

    res.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      // Tells nginx-style proxies not to hold events back.
      "x-accel-buffering": "no",
    });
    res.flushHeaders();

    const send = (event: RecommendStreamEvent, data: unknown) => {
      if (!signal.aborted) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };

    try {
      const { meta } = await answer(req, "recommend_stream", signal, (requestId) =>
        recommend(deps, request, {
          requestId,
          signal,
          onResults: (event) => send("results", event),
          onPicked: (event) => send("picked", event),
        }),
      );
      send("done", { meta });
    } catch (error) {
      if (!signal.aborted) {
        req.log.error({ err: error }, "recommend stream failed");
        // The headers are sent, so the status cannot change. The message is
        // fixed: details of the failure stay in the log.
        send("error", { message: "Recommendations are not available right now." });
      }
    } finally {
      res.end();
    }
  });

  return router;
}

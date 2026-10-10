import { type RecommendStreamEvent, recommendRequestSchema } from "@cinequery/shared";
import { type Response, Router } from "express";
import { recommend, type RecommendDeps } from "../recommend/pipeline.js";
import { parseRequest } from "./errors.js";

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

export function recommendRouter(deps: RecommendDeps): Router {
  const router = Router();

  router.post("/recommend", async (req, res) => {
    const request = parseRequest(recommendRequestSchema, req.body ?? {});
    const signal = untilDisconnect(res);
    try {
      res.json(await recommend(deps, request, { signal }));
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
      const { meta } = await recommend(deps, request, {
        signal,
        onResults: (event) => send("results", event),
        onPicked: (event) => send("picked", event),
      });
      send("done", { meta });
    } catch (error) {
      if (!signal.aborted) {
        deps.logger.error({ err: error }, "recommend stream failed");
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

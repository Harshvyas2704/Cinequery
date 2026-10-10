import type { ErrorRequestHandler, RequestHandler } from "express";

// Every error response has the same shape: { error: { code, message, details? } }.

export const notFound: RequestHandler = (req, res) => {
  res.status(404).json({
    error: { code: "not_found", message: `No route for ${req.method} ${req.path}` },
  });
};

export const errorHandler: ErrorRequestHandler = (err, req, res, next) => {
  if (res.headersSent) {
    next(err);
    return;
  }
  // Errors from Express itself (bad JSON, body too large) carry a 4xx status.
  const status: unknown = (err as { status?: unknown } | null)?.status;
  if (typeof status === "number" && status >= 400 && status < 500) {
    res.status(status).json({ error: { code: "bad_request", message: "Invalid request" } });
    return;
  }
  req.log.error({ err }, "unhandled error");
  res.status(500).json({ error: { code: "internal_error", message: "Something went wrong" } });
};

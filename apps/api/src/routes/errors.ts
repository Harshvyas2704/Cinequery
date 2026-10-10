import type { ErrorRequestHandler, RequestHandler } from "express";
import type { z } from "zod";

// Every error response has the same shape: { error: { code, message, details? } }.

export type FieldError = { field: string; message: string };

/** An error with a status and a message that are safe to send to the client. */
export class HttpError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details: FieldError[] | undefined;

  constructor(status: number, code: string, message: string, details?: FieldError[]) {
    super(message);
    this.name = "HttpError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

/** Validates request input. On failure the client gets a 400 with one message per field. */
export function parseRequest<Schema extends z.ZodType>(
  schema: Schema,
  input: unknown,
): z.infer<Schema> {
  const result = schema.safeParse(input);
  if (result.success) return result.data;
  throw new HttpError(
    400,
    "validation_error",
    "Invalid request",
    result.error.issues.map((issue) => ({
      field: issue.path.join(".") || "request",
      message: issue.message,
    })),
  );
}

export const notFound: RequestHandler = (req, res) => {
  res.status(404).json({
    error: {
      code: "not_found",
      message: `No route for ${req.method} ${req.path}`,
      requestId: String(req.id),
    },
  });
};

export const errorHandler: ErrorRequestHandler = (err, req, res, next) => {
  if (res.headersSent) {
    next(err);
    return;
  }
  const requestId = String(req.id);
  if (err instanceof HttpError) {
    res.status(err.status).json({
      error: { code: err.code, message: err.message, details: err.details, requestId },
    });
    return;
  }
  // Errors from Express itself (bad JSON, body too large) carry a 4xx status.
  const status: unknown = (err as { status?: unknown } | null)?.status;
  if (typeof status === "number" && status >= 400 && status < 500) {
    const tooLarge = status === 413;
    res.status(status).json({
      error: {
        code: tooLarge ? "payload_too_large" : "bad_request",
        message: tooLarge ? "The request body is too large" : "Invalid request",
        requestId,
      },
    });
    return;
  }
  req.log.error({ err }, "unhandled error");
  res
    .status(500)
    .json({ error: { code: "internal_error", message: "Something went wrong", requestId } });
};

import { type DestinationStream, type Logger, pino } from "pino";

// Request logs include the request's headers. These carry secrets (the admin
// token of GET /api/stats travels in Authorization), so they are blanked
// before a line is written.
const SECRET_HEADERS = ["authorization", "cookie", "x-goog-api-key"];

export function createLogger(level: string, destination?: DestinationStream): Logger {
  return pino(
    {
      level,
      redact: {
        paths: [
          ...SECRET_HEADERS.map((header) => `req.headers["${header}"]`),
          'res.headers["set-cookie"]',
        ],
        censor: "[redacted]",
      },
    },
    destination,
  );
}

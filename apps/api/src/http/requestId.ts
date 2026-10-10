import { randomUUID } from "node:crypto";

export const REQUEST_ID_HEADER = "x-request-id";

// An id sent by the client (or a proxy) is kept only if it is harmless to put
// in logs, in a header and in the database.
const SAFE_ID = /^[A-Za-z0-9._-]{8,64}$/;

/** The id sent with the request if it is usable, otherwise a new one. */
export function requestIdFrom(header: string | string[] | undefined): string {
  const sent = Array.isArray(header) ? header[0] : header;
  return sent !== undefined && SAFE_ID.test(sent) ? sent : randomUUID();
}

/** One Server-Sent Event: its name and its data, still as text. */
export type SseEvent = { event: string; data: string };

/**
 * Reads Server-Sent Events from text that arrives in pieces. A piece can end
 * in the middle of an event, so the unfinished part is kept until the rest
 * arrives. Give it each piece with `push`; it calls `onEvent` for every
 * complete event.
 *
 * The browser's EventSource cannot be used here because it only sends GET
 * requests, and a recommendation is asked for with POST.
 */
export function createSseParser(onEvent: (event: SseEvent) => void): { push(chunk: string): void } {
  let buffer = "";

  return {
    push(chunk) {
      buffer = (buffer + chunk).replace(/\r\n?/g, "\n");
      // A blank line ends an event.
      for (let end = buffer.indexOf("\n\n"); end !== -1; end = buffer.indexOf("\n\n")) {
        const block = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);

        let event = "message";
        const data: string[] = [];
        for (const line of block.split("\n")) {
          if (line.startsWith(":")) continue; // a comment, used as a keep-alive
          const colon = line.indexOf(":");
          const field = colon === -1 ? line : line.slice(0, colon);
          const value = colon === -1 ? "" : line.slice(colon + 1).replace(/^ /, "");
          if (field === "event") event = value;
          if (field === "data") data.push(value);
        }
        if (data.length > 0) onEvent({ event, data: data.join("\n") });
      }
    },
  };
}

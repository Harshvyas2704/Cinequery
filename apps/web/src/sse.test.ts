import { describe, expect, it } from "vitest";
import { createSseParser, type SseEvent } from "./sse.ts";

function parse(...chunks: string[]): SseEvent[] {
  const events: SseEvent[] = [];
  const parser = createSseParser((event) => events.push(event));
  for (const chunk of chunks) parser.push(chunk);
  return events;
}

describe("createSseParser", () => {
  it("reads events that arrive whole", () => {
    expect(parse('event: results\ndata: {"a":1}\n\nevent: done\ndata: {}\n\n')).toEqual([
      { event: "results", data: '{"a":1}' },
      { event: "done", data: "{}" },
    ]);
  });

  it("waits for the rest of an event that arrives in pieces", () => {
    expect(parse("event: res", 'ults\ndata: {"a"', ":1}\n", "\nevent: done\ndata: {}\n\n")).toEqual([
      { event: "results", data: '{"a":1}' },
      { event: "done", data: "{}" },
    ]);
  });

  it("does not report an event before its blank line", () => {
    expect(parse("event: done\ndata: {}\n")).toEqual([]);
  });

  it("accepts Windows line endings, comments and several data lines", () => {
    expect(parse(": keep-alive\r\n\r\nevent: note\r\ndata: one\r\ndata: two\r\n\r\n")).toEqual([
      { event: "note", data: "one\ntwo" },
    ]);
  });

  it("calls an event without a name 'message'", () => {
    expect(parse("data: hello\n\n")).toEqual([{ event: "message", data: "hello" }]);
  });
});

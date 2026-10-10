import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import { createShutdown } from "../src/shutdown.js";
import { silentLogger } from "./helpers.js";

/** A server whose /slow answers only when `finish` is called. */
async function slowServer() {
  let finish = () => {};
  const server = createServer((req, res) => {
    if (req.url === "/slow") finish = () => res.end("done");
    else res.end("ok");
  });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const url = `http://localhost:${(server.address() as AddressInfo).port}`;
  return { server, url, finish: () => finish() };
}

function shutdownOf(server: Awaited<ReturnType<typeof slowServer>>["server"], timeoutMs: number) {
  const closed: string[] = [];
  const shutdown = createShutdown({
    drain: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeIdleConnections();
      }),
    force: () => server.closeAllConnections(),
    close: [
      async () => void closed.push("postgres"),
      async () => {
        throw new Error("redis is already gone");
      },
      async () => void closed.push("queue"),
    ],
    timeoutMs,
    logger: silentLogger,
  });
  return { shutdown, closed };
}

describe("createShutdown", () => {
  it("stops accepting, lets the open request finish, then closes resources in order", async () => {
    const { server, url, finish } = await slowServer();
    const { shutdown, closed } = shutdownOf(server, 5000);

    const inFlight = fetch(`${url}/slow`);
    await new Promise((resolve) => setTimeout(resolve, 50));
    const done = shutdown("SIGTERM");

    // New connections are refused while the old request is still open.
    await expect(fetch(`${url}/`)).rejects.toThrow();
    expect(closed).toEqual([]);

    finish();
    expect(await (await inFlight).text()).toBe("done");
    expect(await done).toBe(true);
    // One resource failing to close does not stop the others.
    expect(closed).toEqual(["postgres", "queue"]);
  });

  it("cuts off a request that outlasts the timeout, and says so", async () => {
    const { server, url } = await slowServer();
    const { shutdown, closed } = shutdownOf(server, 100);

    const inFlight = fetch(`${url}/slow`).then((response) => response.text());
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(await shutdown("SIGTERM")).toBe(false);
    await expect(inFlight).rejects.toThrow();
    expect(closed).toEqual(["postgres", "queue"]);
  });

  it("runs once, however many signals arrive", async () => {
    const { server } = await slowServer();
    const { shutdown, closed } = shutdownOf(server, 1000);

    const [first, second] = await Promise.all([shutdown("SIGTERM"), shutdown("SIGINT")]);
    expect([first, second]).toEqual([true, true]);
    expect(closed).toEqual(["postgres", "queue"]);
  });
});

import { describe, expect, it } from "vitest";
import { createSemaphore } from "../src/limits/semaphore.js";

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("createSemaphore", () => {
  it("lets `max` holders in and makes the rest wait in order", async () => {
    const semaphore = createSemaphore(2);
    const entered: string[] = [];
    const enter = (name: string) => semaphore.acquire().then((release) => (entered.push(name), release));

    const [releaseA] = await Promise.all([enter("a"), enter("b")]);
    void enter("c");
    void enter("d");
    await tick();
    expect(entered).toEqual(["a", "b"]);
    expect(semaphore).toMatchObject({ active: 2, waiting: 2 });

    releaseA!();
    await tick();
    expect(entered).toEqual(["a", "b", "c"]);
    expect(semaphore).toMatchObject({ active: 2, waiting: 1 });
  });

  it("frees a place only once, however often release is called", async () => {
    const semaphore = createSemaphore(1);
    const release = await semaphore.acquire();
    release();
    release();
    expect(semaphore.active).toBe(0);
    await semaphore.acquire();
    expect(semaphore.active).toBe(1);
  });

  it("drops a waiter whose signal fires, without losing the place", async () => {
    const semaphore = createSemaphore(1);
    const release = await semaphore.acquire();
    const controller = new AbortController();
    const waiting = semaphore.acquire(controller.signal);

    controller.abort();
    await expect(waiting).rejects.toThrow("aborted while waiting");
    expect(semaphore.waiting).toBe(0);

    release();
    expect(semaphore.active).toBe(0);
    await expect(semaphore.acquire(AbortSignal.abort())).rejects.toThrow();
  });
});

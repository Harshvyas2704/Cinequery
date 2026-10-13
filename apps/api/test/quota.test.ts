import { describe, expect, it } from "vitest";
import { allowanceOf, lastQuotaReset, nextQuotaReset } from "../src/embeddings/quota.js";

const PACIFIC = "America/Los_Angeles";
const iso = (date: Date) => date.toISOString();

describe("quota day", () => {
  it("runs from midnight to midnight Pacific time (12:30 pm in India in summer)", () => {
    // 10:19 am on 11 October in India is still the evening of the 10th in California.
    const now = new Date("2026-10-11T04:49:00Z");
    expect(iso(lastQuotaReset(PACIFIC, now))).toBe("2026-10-10T07:00:00.000Z");
    expect(iso(nextQuotaReset(PACIFIC, now))).toBe("2026-10-11T07:00:00.000Z");
  });

  it("moves by an hour in winter, when California is on standard time", () => {
    const now = new Date("2026-12-01T12:00:00Z");
    expect(iso(lastQuotaReset(PACIFIC, now))).toBe("2026-12-01T08:00:00.000Z");
    expect(iso(nextQuotaReset(PACIFIC, now))).toBe("2026-12-02T08:00:00.000Z");
  });

  it("gets the days right on which the clocks change", () => {
    // 1 November 2026 has 25 hours in California, 8 March 2026 has 23.
    const autumn = new Date("2026-11-01T20:00:00Z");
    expect(iso(lastQuotaReset(PACIFIC, autumn))).toBe("2026-11-01T07:00:00.000Z");
    expect(iso(nextQuotaReset(PACIFIC, autumn))).toBe("2026-11-02T08:00:00.000Z");

    const spring = new Date("2026-03-08T20:00:00Z");
    expect(iso(lastQuotaReset(PACIFIC, spring))).toBe("2026-03-08T08:00:00.000Z");
    expect(iso(nextQuotaReset(PACIFIC, spring))).toBe("2026-03-09T07:00:00.000Z");
  });

  it("at the very moment of the refill, a new day has begun", () => {
    const refill = new Date("2026-10-11T07:00:00.000Z");
    expect(iso(lastQuotaReset(PACIFIC, refill))).toBe("2026-10-11T07:00:00.000Z");
    expect(iso(lastQuotaReset(PACIFIC, new Date(refill.getTime() - 1)))).toBe("2026-10-10T07:00:00.000Z");
  });

  it("works for any time zone", () => {
    const now = new Date("2026-10-11T04:49:00Z");
    expect(iso(lastQuotaReset("Asia/Kolkata", now))).toBe("2026-10-10T18:30:00.000Z");
    expect(iso(lastQuotaReset("UTC", now))).toBe("2026-10-11T00:00:00.000Z");
  });
});

describe("allowanceOf", () => {
  const settings = { dailyQuota: 1000, reserve: 0, timeZone: PACIFIC };
  // 15 minutes before the refill.
  const now = new Date("2026-10-11T06:45:00Z");

  it("is the quota minus what movies and requests used", () => {
    expect(allowanceOf({ movies: 0, requests: 100 }, settings, now)).toMatchObject({
      used: 100,
      left: 900,
      minutesToReset: 15,
    });
    expect(allowanceOf({ movies: 700, requests: 140 }, settings, now).left).toBe(160);
  });

  it("holds back the reserve, and is never negative", () => {
    expect(allowanceOf({ movies: 700, requests: 140 }, { ...settings, reserve: 80 }, now).left).toBe(80);
    expect(allowanceOf({ movies: 980, requests: 30 }, settings, now).left).toBe(0);
    expect(allowanceOf({ movies: 0, requests: 990 }, { ...settings, reserve: 50 }, now).left).toBe(0);
  });
});

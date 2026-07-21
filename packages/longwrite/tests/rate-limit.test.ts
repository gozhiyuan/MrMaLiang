import { describe, expect, it } from "vitest";
import { ProviderRequestLimiter } from "../src/lib/research/rate-limit.js";

describe("ProviderRequestLimiter", () => {
  it("spaces repeated requests by its reserved interval", async () => {
    let now = 0;
    const waits: number[] = [];
    const limiter = new ProviderRequestLimiter({
      minIntervalMs: 3_000,
      now: () => now,
      sleep: async (ms) => { waits.push(ms); now += ms; },
    });
    const fetchImpl = async () => new Response("ok", { status: 200 });

    await limiter.fetch(fetchImpl, "https://example.test/one", {});
    await limiter.fetch(fetchImpl, "https://example.test/two", {});

    expect(waits).toEqual([3_000]);
  });

  it("honors Retry-After and retries a bounded overload response", async () => {
    let now = 0;
    const waits: number[] = [];
    let calls = 0;
    const limiter = new ProviderRequestLimiter({
      minIntervalMs: 0,
      now: () => now,
      sleep: async (ms) => { waits.push(ms); now += ms; },
    });
    const response = await limiter.fetch(async () => {
      calls += 1;
      return calls === 1
        ? new Response("slow down", { status: 429, headers: { "retry-after": "2" } })
        : new Response("ok", { status: 200 });
    }, "https://example.test", {});

    expect(response.status).toBe(200);
    expect(calls).toBe(2);
    expect(waits).toEqual([2_000]);
  });
});

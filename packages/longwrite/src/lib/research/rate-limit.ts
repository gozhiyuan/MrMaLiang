/**
 * Small per-provider request scheduler for public scholarly APIs.
 *
 * Query variants are sequential, but `multi` asks each provider concurrently.
 * Each provider therefore owns one scheduler. It reserves the next request
 * slot before issuing a fetch, honors `Retry-After`, and retries temporary
 * overload responses a bounded number of times.
 */
export type ResearchFetch = (url: string, init: RequestInit) => Promise<Response>;

export type ProviderRequestLimiterOptions = {
  minIntervalMs: number;
  maxRetries?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
};

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function retryAfterMs(response: Response, now: number): number | undefined {
  const raw = response.headers.get("retry-after")?.trim();
  if (!raw) return undefined;
  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds * 1_000);
  const at = Date.parse(raw);
  return Number.isFinite(at) ? Math.max(0, at - now) : undefined;
}

/** Crossref may advertise an active request window in these headers. */
function advertisedIntervalMs(response: Response): number | undefined {
  const limit = Number(response.headers.get("x-rate-limit-limit"));
  const rawInterval = response.headers.get("x-rate-limit-interval")?.trim();
  if (!Number.isFinite(limit) || limit <= 0 || !rawInterval) return undefined;
  const match = rawInterval.match(/^(\d+(?:\.\d+)?)\s*(ms|s|m)$/i);
  if (!match) return undefined;
  const amount = Number(match[1]);
  const multiplier = match[2].toLowerCase() === "m" ? 60_000 : match[2].toLowerCase() === "s" ? 1_000 : 1;
  return Math.ceil((amount * multiplier) / limit);
}

export class ProviderRequestLimiter {
  private nextAllowedAt = 0;
  private minIntervalMs: number;
  private readonly maxRetries: number;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(opts: ProviderRequestLimiterOptions) {
    this.minIntervalMs = opts.minIntervalMs;
    this.maxRetries = opts.maxRetries ?? 2;
    this.now = opts.now ?? Date.now;
    this.sleep = opts.sleep ?? defaultSleep;
  }

  async fetch(fetchImpl: ResearchFetch, url: string, init: RequestInit): Promise<Response> {
    for (let attempt = 0; attempt <= this.maxRetries; attempt += 1) {
      // Reserve before sleeping so concurrent callers cannot use the same slot.
      const now = this.now();
      const scheduledAt = Math.max(now, this.nextAllowedAt);
      this.nextAllowedAt = scheduledAt + this.minIntervalMs;
      if (scheduledAt > now) await this.sleep(scheduledAt - now);

      const response = await fetchImpl(url, init);
      const currentNow = this.now();
      const advertised = advertisedIntervalMs(response);
      if (advertised !== undefined) this.minIntervalMs = Math.max(this.minIntervalMs, advertised);

      if ((response.status === 429 || response.status === 503) && attempt < this.maxRetries) {
        const retryMs = retryAfterMs(response, currentNow) ?? Math.min(30_000, 1_000 * 2 ** attempt);
        this.nextAllowedAt = Math.max(this.nextAllowedAt, currentNow + retryMs);
        continue;
      }
      return response;
    }
    throw new Error("unreachable rate-limit retry state");
  }
}

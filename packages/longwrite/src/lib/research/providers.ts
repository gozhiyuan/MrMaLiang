import type { RawSource } from "./types.js";
import { ArxivProvider } from "./arxiv.js";
import { CrossrefProvider } from "./crossref.js";
import { DblpProvider } from "./dblp.js";
import { OpenAlexProvider } from "./openalex.js";
import { SemanticScholarProvider } from "./semantic-scholar.js";
import { generateSeedSources } from "./seed.js";

export type ResearchProviderId = "seed" | "arxiv" | "semantic_scholar" | "dblp" | "crossref" | "openalex" | "multi";

export type ResearchProvider = {
  id: ResearchProviderId;
  search(topic: string, limit: number): Promise<RawSource[]>;
};

export type ProviderProgress = {
  provider: ResearchProviderId;
  topic: string;
  outcome: "succeeded" | "failed";
  sources?: number;
  error?: string;
};

export type ProviderOptions = {
  /** Per-provider request deadline. Individual providers receive this as an
   * AbortSignal timeout; the multi adapter also records every settlement. */
  timeoutMs?: number;
  onProgress?: (progress: ProviderProgress) => void;
};

export const seedProvider: ResearchProvider = {
  id: "seed",
  async search(topic, limit) {
    return generateSeedSources(topic, limit);
  },
};

/** Fan out to every keyless live provider and concatenate. The pipeline
 *  dedupes downstream, so overlap across providers is the point: the same
 *  paper found via arXiv + DBLP + Crossref merges into one record carrying
 *  every identifier. Individual provider failures are tolerated as long as
 *  at least one succeeds. */
export function multiProvider(
  providers: ResearchProvider[] = [
    new ArxivProvider(),
    new SemanticScholarProvider(),
    new OpenAlexProvider(),
    new DblpProvider(),
    new CrossrefProvider(),
  ],
  onProgress?: ProviderOptions["onProgress"],
): ResearchProvider {
  return {
    id: "multi",
    async search(topic, limit) {
      const settled = await Promise.allSettled(providers.map((p) => p.search(topic, limit)));
      settled.forEach((result, i) => {
        const provider = providers[i]!;
        if (result.status === "fulfilled") {
          onProgress?.({ provider: provider.id, topic, outcome: "succeeded", sources: result.value.length });
        } else {
          onProgress?.({ provider: provider.id, topic, outcome: "failed", error: String(result.reason) });
        }
      });
      const sources = settled.flatMap((result) => (result.status === "fulfilled" ? result.value : []));
      if (sources.length === 0) {
        const reasons = settled
          .map((result, i) => (result.status === "rejected" ? `${providers[i].id}: ${String(result.reason)}` : null))
          .filter(Boolean)
          .join("; ");
        throw new Error(`All multi-providers failed: ${reasons}`);
      }
      return sources;
    },
  };
}

export function providerById(id: ResearchProviderId, options: ProviderOptions = {}): ResearchProvider {
  const timeoutMs = options.timeoutMs;
  if (id === "seed") return seedProvider;
  if (id === "arxiv") return new ArxivProvider(fetch, timeoutMs);
  if (id === "semantic_scholar") return new SemanticScholarProvider(fetch, timeoutMs);
  if (id === "dblp") return new DblpProvider(fetch, timeoutMs);
  if (id === "crossref") return new CrossrefProvider(fetch, timeoutMs);
  if (id === "openalex") return new OpenAlexProvider(fetch, timeoutMs);
  if (id === "multi") return multiProvider([
    new ArxivProvider(fetch, timeoutMs),
    new SemanticScholarProvider(fetch, timeoutMs),
    new OpenAlexProvider(fetch, timeoutMs),
    new DblpProvider(fetch, timeoutMs),
    new CrossrefProvider(fetch, timeoutMs),
  ], options.onProgress);
  throw new Error(`Provider "${id}" is not registered`);
}

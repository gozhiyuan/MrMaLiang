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
): ResearchProvider {
  return {
    id: "multi",
    async search(topic, limit) {
      const settled = await Promise.allSettled(providers.map((p) => p.search(topic, limit)));
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

export function providerById(id: ResearchProviderId): ResearchProvider {
  if (id === "seed") return seedProvider;
  if (id === "arxiv") return new ArxivProvider();
  if (id === "semantic_scholar") return new SemanticScholarProvider();
  if (id === "dblp") return new DblpProvider();
  if (id === "crossref") return new CrossrefProvider();
  if (id === "openalex") return new OpenAlexProvider();
  if (id === "multi") return multiProvider();
  throw new Error(`Provider "${id}" is not registered`);
}

import fs from "node:fs/promises";
import path from "node:path";
import { dedupeSources } from "./dedupe.js";
import { toJsonl } from "./jsonl.js";
import { ProviderRequestLimiter } from "./rate-limit.js";
import { normalizeSemanticScholarResponse } from "./semantic-scholar.js";
import type { RawSource } from "./types.js";

const FIELDS = "paperId,title,abstract,year,venue,url,authors,externalIds,citationCount,openAccessPdf";

export type SnowballResult = {
  version: 1;
  seed_source_id: string;
  direction: "references" | "citations";
  status: "expanded" | "skipped" | "failed";
  discovered: number;
  detail?: string;
};

function sourceRef(source: RawSource): string | undefined {
  if (source.identifiers?.semantic_scholar_id) return source.identifiers.semantic_scholar_id;
  if (source.identifiers?.arxiv_id) return `ARXIV:${source.identifiers.arxiv_id.replace(/v\d+$/, "")}`;
  return undefined;
}

function snowballUrl(ref: string, limit: number, direction: SnowballResult["direction"]): string {
  const url = new URL(`https://api.semanticscholar.org/graph/v1/paper/${encodeURIComponent(ref)}/${direction}`);
  url.searchParams.set("fields", FIELDS);
  url.searchParams.set("limit", String(limit));
  return url.toString();
}

/** Expand a bounded set of high-value sources through their reference lists.
 * Every fetched record is cached as JSONL and merged through the normal
 * dedupe/score/classify path; failures remain per-seed and never fabricate
 * citations. */
export async function snowballWorkspace(
  workspaceDir: string,
  opts: {
    maxSeeds?: number;
    perSeed?: number;
    directions?: Array<SnowballResult["direction"]>;
    fetchImpl?: typeof fetch;
    limiter?: ProviderRequestLimiter;
  } = {},
): Promise<{ results: SnowballResult[]; written: string[] }> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const limiter = opts.limiter ?? new ProviderRequestLimiter({ minIntervalMs: 1_000 });
  const directions = opts.directions ?? ["references", "citations"];
  const raw = await fs.readFile(path.join(workspaceDir, "sources", "deduped_sources.jsonl"), "utf-8");
  const sources = raw.split("\n").filter(Boolean).map((line) => JSON.parse(line) as RawSource);
  if (sources.every((source) => source.source === "seed")) {
    const results = sources.slice(0, opts.maxSeeds ?? 12).flatMap((source) => directions.map((direction) => ({
      version: 1 as const, seed_source_id: source.id, direction, status: "skipped" as const, discovered: 0,
      detail: "seed provider is deterministic; citation-network expansion is unavailable",
    })));
    await writeSnowball(workspaceDir, results, []);
    return { results, written: ["sources/snowball_results.jsonl", "sources/deduped_sources.jsonl", "reports/snowball.md"] };
  }
  const ranked = sources.slice().sort((a, b) => (b.metrics?.citation_count ?? 0) - (a.metrics?.citation_count ?? 0));
  const results: SnowballResult[] = [];
  const discovered: RawSource[] = [];
  for (const source of ranked.slice(0, opts.maxSeeds ?? 12)) {
    const ref = sourceRef(source);
    for (const direction of directions) {
      if (!ref) {
        results.push({ version: 1, seed_source_id: source.id, direction, status: "skipped", discovered: 0, detail: "no Semantic Scholar or arXiv identifier" });
        continue;
      }
      try {
        const headers: Record<string, string> = { accept: "application/json" };
        if (process.env.SEMANTIC_SCHOLAR_API_KEY) headers["x-api-key"] = process.env.SEMANTIC_SCHOLAR_API_KEY;
        const response = await limiter.fetch(fetchImpl, snowballUrl(ref, opts.perSeed ?? 25, direction), {
          headers,
          signal: AbortSignal.timeout(15_000),
        });
        if (!response.ok) throw new Error(`Semantic Scholar HTTP ${response.status}`);
        const payload = await response.json() as { data?: Array<{ citedPaper?: unknown; citingPaper?: unknown }> };
        const papers = (payload.data ?? [])
          .map((edge) => direction === "references" ? edge.citedPaper : edge.citingPaper)
          .filter((paper): paper is object => Boolean(paper));
        const normalized = normalizeSemanticScholarResponse({ data: papers }, source.title).map((candidate) => ({
          ...candidate,
          provenance: { query: `snowball:${direction}:${source.id}`, provider: "semantic_scholar", retrieved_at: new Date().toISOString() },
        }));
        discovered.push(...normalized);
        results.push({ version: 1, seed_source_id: source.id, direction, status: "expanded", discovered: normalized.length });
      } catch (error) {
        results.push({ version: 1, seed_source_id: source.id, direction, status: "failed", discovered: 0, detail: error instanceof Error ? error.message : String(error) });
      }
    }
  }
  await writeSnowball(workspaceDir, results, dedupeSources([...sources, ...discovered]));
  return { results, written: ["sources/snowball_results.jsonl", "sources/deduped_sources.jsonl", "reports/snowball.md"] };
}

async function writeSnowball(workspaceDir: string, results: SnowballResult[], merged: RawSource[]): Promise<void> {
  const report = [
    "# Citation-Network Expansion", "",
    `Expanded: ${results.filter((entry) => entry.status === "expanded").length} · skipped: ${results.filter((entry) => entry.status === "skipped").length} · failed: ${results.filter((entry) => entry.status === "failed").length}`, "",
    ...results.map((entry) => `- [${entry.status}] ${entry.direction} ${entry.seed_source_id}: ${entry.discovered} discovered${entry.detail ? ` (${entry.detail})` : ""}`), "",
  ].join("\n");
  await fs.mkdir(path.join(workspaceDir, "sources"), { recursive: true });
  await fs.mkdir(path.join(workspaceDir, "reports"), { recursive: true });
  await Promise.all([
    fs.writeFile(path.join(workspaceDir, "sources", "snowball_results.jsonl"), toJsonl(results), "utf-8"),
    ...(merged.length > 0 ? [fs.writeFile(path.join(workspaceDir, "sources", "deduped_sources.jsonl"), toJsonl(merged), "utf-8")] : []),
    fs.writeFile(path.join(workspaceDir, "reports", "snowball.md"), report, "utf-8"),
  ]);
}

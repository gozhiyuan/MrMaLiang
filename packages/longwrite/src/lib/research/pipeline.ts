import fs from "node:fs/promises";
import path from "node:path";
import { toJsonl } from "./jsonl.js";
import { providerById, seedProvider, type ResearchProvider, type ResearchProviderId } from "./providers.js";
import { generateSeedSources } from "./seed.js";
import { dedupeSources } from "./dedupe.js";
import { scoreSources } from "./score.js";
import { classifySources } from "./classify.js";
import { writeBibtex } from "./bibtex.js";
import { buildCitationPlan } from "./citation-plan.js";
import type { RawSource, ResearchArtifacts } from "./types.js";
import { loadSearchPlan, applyExclusions, plannedQueries, SEARCH_PLAN_PATH } from "./search-plan.js";
import { resolveWorkspaceReferenceSeeds } from "./reference-seeds.js";

export type PrepareResearchOptions = {
  workspaceDir: string;
  topic: string;
  count?: number;
  provider?: ResearchProviderId;
  fallbackToSeed?: boolean;
  /** Test seam; production uses the registered provider factory. */
  providerFactory?: (id: ResearchProviderId) => ResearchProvider;
  targetCandidates?: number;
  queryBudget?: number;
};

export type BuildResearchArtifactsOptions = {
  topic: string;
  count?: number;
  provider?: ResearchProviderId;
  fallbackToSeed?: boolean;
  providerFactory?: (id: ResearchProviderId) => ResearchProvider;
};

export function buildResearchArtifactsFromSources(
  topic: string,
  raw: RawSource[],
  providerUsed: ResearchProviderId = "seed",
  fallbackReason?: string,
): ResearchArtifacts {
  const deduped = dedupeSources(raw);
  const scored = scoreSources(deduped);
  const classified = classifySources(scored);
  const citationPlan = buildCitationPlan(classified);
  const bibliographyBibtex = writeBibtex(classified);
  const reportMarkdown =
    `# Research Tooling Report\n\n` +
    `Topic: ${topic}\n\n` +
    `Provider: ${providerUsed}\n\n` +
    (fallbackReason ? `Fallback: ${fallbackReason}\n\n` : "") +
    `Prepared ${raw.length} raw sources, deduped to ${deduped.length}, scored ${scored.length}, ` +
    `classified ${classified.length}, and created ${citationPlan.length} citation-plan entries.\n\n` +
    (providerUsed === "seed"
      ? `This run used deterministic seed data for local development.\n`
      : `This run used live provider data normalized into LongWrite source artifacts.\n`);
  return { raw, deduped, scored, classified, citationPlan, bibliographyBibtex, reportMarkdown };
}

export function buildResearchArtifacts(topic: string, count = 8): ResearchArtifacts {
  const raw = generateSeedSources(topic, count);
  return buildResearchArtifactsFromSources(topic, raw, "seed");
}

export async function buildResearchArtifactsWithProvider(
  opts: BuildResearchArtifactsOptions,
): Promise<ResearchArtifacts> {
  const providerId = opts.provider ?? "seed";
  const count = opts.count ?? 8;
  try {
    const raw = await (opts.providerFactory ?? providerById)(providerId).search(opts.topic, count);
    if (raw.length === 0) throw new Error(`${providerId} returned no sources`);
    return buildResearchArtifactsFromSources(opts.topic, raw, providerId);
  } catch (err) {
    // Live research must fail closed by default. Seed material is useful for
    // demos and offline tests, but it must be an explicit opt-in so a paper
    // cannot look like it used a live provider after a network failure.
    if (providerId === "seed" || opts.fallbackToSeed !== true) throw err;
    const fallbackRaw = await seedProvider.search(opts.topic, count);
    const message = err instanceof Error ? err.message : String(err);
    return buildResearchArtifactsFromSources(opts.topic, fallbackRaw, "seed", `${providerId}: ${message}`);
  }
}

async function writeFiles(workspaceDir: string, files: Array<[string, string]>): Promise<string[]> {
  const written: string[] = [];
  for (const [rel, content] of files) {
    const abs = path.join(workspaceDir, rel);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, content, "utf-8");
    written.push(rel);
  }
  return written;
}

async function readJsonlArtifact<T>(workspaceDir: string, rel: string): Promise<T[]> {
  const raw = await fs.readFile(path.join(workspaceDir, rel), "utf-8");
  return raw.split("\n").filter((l) => l.trim().length > 0).map((l) => JSON.parse(l) as T);
}

/** Stage 1/3: query providers, write raw + deduped source artifacts with
 *  retrieval provenance. Does NOT score or classify — each research stage
 *  owns exactly its own artifacts and is idempotent over its inputs. */
export async function recallSources(opts: PrepareResearchOptions): Promise<string[]> {
  const providerId = opts.provider ?? "seed";
  const targetCandidates = opts.targetCandidates ?? opts.count ?? 8;

  // Optional LLM search plan: execute its query variants deterministically.
  // Invalid plans fail LOUDLY — a claimed planned run must not silently
  // degrade to topic-only retrieval.
  const planLoad = await loadSearchPlan(opts.workspaceDir);
  if (planLoad.present && !planLoad.ok) {
    throw new Error(`invalid ${SEARCH_PLAN_PATH}:\n${planLoad.findings.join("\n")}`);
  }
  const plan = planLoad.present && planLoad.ok ? planLoad.plan : undefined;
  const queries = (plan ? plannedQueries(plan) : [opts.topic]).slice(0, opts.queryBudget ?? 50);
  const countPerQuery = Math.max(1, Math.ceil(targetCandidates / queries.length));

  let raw: Array<RawSource & { provenance?: { query: string; provider: string; retrieved_at: string } }> = [];
  let providerUsed: ResearchProviderId = providerId;
  let fallbackReason: string | undefined;
  const retrievedAt = new Date().toISOString();
  try {
    const provider = (opts.providerFactory ?? providerById)(providerId);
    for (const query of queries) {
      const batch = await provider.search(query, countPerQuery);
      raw.push(...batch.map((source) => ({
        ...source,
        provenance: { query, provider: providerUsed, retrieved_at: retrievedAt },
      })));
    }
    if (raw.length === 0) throw new Error(`${providerId} returned no sources`);
  } catch (err) {
    if (providerId === "seed" || opts.fallbackToSeed !== true) throw err;
    const seeds = await seedProvider.search(opts.topic, targetCandidates);
    raw = seeds.map((source) => ({
      ...source,
      provenance: { query: opts.topic, provider: "seed", retrieved_at: retrievedAt },
    }));
    providerUsed = "seed";
    fallbackReason = `${providerId}: ${err instanceof Error ? err.message : String(err)}`;
  }

  const referenceSeeds = await resolveWorkspaceReferenceSeeds(opts.workspaceDir, opts.topic, fetch, providerId !== "seed");
  raw.push(...referenceSeeds.sources.map((source) => ({
    ...source,
    provenance: { query: `authoritative-reference-link:${source.links?.canonical_url ?? source.url}`, provider: source.source, retrieved_at: retrievedAt },
  })));

  const exclusion = applyExclusions(raw, plan?.exclusion_terms ?? []);
  const withProvenance = exclusion.kept;
  const deduped = dedupeSources(withProvenance);
  const written = await writeFiles(opts.workspaceDir, [
    ["sources/raw_results.jsonl", toJsonl(withProvenance)],
    ["sources/deduped_sources.jsonl", toJsonl(deduped)],
    ...(plan ? [[
      "reports/recall-plan.md",
      `# Planned recall\n\nExecuted ${queries.length} query variants from ${SEARCH_PLAN_PATH}; ` +
      `targeted ${targetCandidates} candidates (${countPerQuery} per query); ` +
      `dropped ${exclusion.dropped} sources matching exclusion terms.\n` +
      (plan.taxonomy_cells.length > 0 ? `Taxonomy cells: ${plan.taxonomy_cells.map((cell) => `${cell.cell} (${cell.query_variants.length})`).join(", ")}\n` : "") +
      (plan.venue_priorities.length > 0 ? `Venue priorities: ${plan.venue_priorities.join(", ")}\n` : ""),
    ] as [string, string]] : []),
  ]);
  written.push(...referenceSeeds.written);
  if (fallbackReason) {
    // A claimed real-provider run must not silently become seed data:
    // surface the fallback loudly in a report the reviewer will see.
    written.push(...await writeFiles(opts.workspaceDir, [
      ["reports/recall-fallback.md", `# Recall fallback\n\n${fallbackReason}\n\nThis run used SEED data, not live provider data.\n`],
    ]));
  }
  return written;
}

/** Stage 2/3: read deduped sources, write scored sources. */
export async function scoreWorkspaceSources(workspaceDir: string): Promise<string[]> {
  const deduped = await readJsonlArtifact<RawSource>(workspaceDir, "sources/deduped_sources.jsonl");
  return writeFiles(workspaceDir, [
    ["sources/scored_sources.jsonl", toJsonl(scoreSources(deduped))],
  ]);
}

/** Stage 3/3: read scored sources, write classification, BibTeX, citation
 *  plan, and the tooling report. */
export async function classifyWorkspaceSources(workspaceDir: string, topic: string): Promise<string[]> {
  const scored = await readJsonlArtifact<ReturnType<typeof scoreSources>[number]>(
    workspaceDir, "sources/scored_sources.jsonl",
  );
  const classified = classifySources(scored);
  const citationPlan = buildCitationPlan(classified);
  const providerUsed = (scored[0] as { provenance?: { provider?: string } })?.provenance?.provider ?? "unknown";
  const reportMarkdown =
    `# Research Tooling Report\n\n` +
    `Topic: ${topic}\n\n` +
    `Provider: ${providerUsed}\n\n` +
    `Recall/score/classify ran as separate idempotent stages. ` +
    `Classified ${classified.length} sources into ${citationPlan.length} citation-plan entries.\n`;
  return writeFiles(workspaceDir, [
    ["sources/classified_sources.jsonl", toJsonl(classified)],
    ["sources/bibliography.bib", writeBibtex(classified)],
    ["sources/citation_plan.jsonl", toJsonl(citationPlan)],
    ["reports/research-tooling.md", reportMarkdown],
  ]);
}

export async function prepareResearchWorkspace(opts: PrepareResearchOptions): Promise<string[]> {
  const artifacts = await buildResearchArtifactsWithProvider({
    topic: opts.topic,
    count: opts.count,
    provider: opts.provider,
    fallbackToSeed: opts.fallbackToSeed,
  });
  const files: Array<[string, string]> = [
    ["sources/raw_results.jsonl", toJsonl(artifacts.raw)],
    ["sources/deduped_sources.jsonl", toJsonl(artifacts.deduped)],
    ["sources/scored_sources.jsonl", toJsonl(artifacts.scored)],
    ["sources/classified_sources.jsonl", toJsonl(artifacts.classified)],
    ["sources/bibliography.bib", artifacts.bibliographyBibtex],
    ["sources/citation_plan.jsonl", toJsonl(artifacts.citationPlan)],
    ["reports/research-tooling.md", artifacts.reportMarkdown],
  ];

  const written: string[] = [];
  for (const [rel, content] of files) {
    const abs = path.join(opts.workspaceDir, rel);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, content, "utf-8");
    written.push(rel);
  }
  return written;
}

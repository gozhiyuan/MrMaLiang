import fs from "node:fs/promises";
import path from "node:path";
import { writeBibtex } from "./bibtex.js";
import { toJsonl } from "./jsonl.js";
import { verifyCitedSourceUrls } from "./verify.js";
import { buildCitationPlan, plannedSections } from "./citation-plan.js";
import { providerById, type ResearchProvider, type ResearchProviderId } from "./providers.js";
import { loadProjectConfig } from "../project-config.js";
import type { ClassifiedSource, RawSource } from "./types.js";

/** The two corpus-side repairs the registry routes findings to.
 *
 * Both capabilities were registered, routable and selectable by the planner,
 * and neither had an executable action in the compiled workflow: the plan
 * splitter dropped their actions into no phase group, and the dispatch had
 * nothing to run even when they reached it. A recovery loop could diagnose the
 * same bibliography defect every round with nothing ever acting on it.
 *
 * Both are DERIVATIONS rather than edits. `sources/bibliography.bib` and
 * `sources/citation_plan.jsonl` are generated from the classified corpus, so an
 * inconsistent one is repaired by regenerating it from the record that is
 * authoritative — not by editing the derived file, which the next generation
 * would overwrite anyway. */

/** The classified corpus, as it stands on disk. An unreadable one is an error;
 * an absent one is an empty corpus, which the caller refuses on its own terms. */
async function readClassifiedSources(workspaceDir: string): Promise<ClassifiedSource[]> {
  const file = path.join(workspaceDir, "sources", "classified_sources.jsonl");
  let raw: string;
  try {
    raw = await fs.readFile(file, "utf-8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw new Error(`cannot read ${file}: ${(error as NodeJS.ErrnoException).code ?? String(error)}`);
  }
  return raw.split("\n").filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as ClassifiedSource);
}

export async function repairBibliography(
  workspaceDir: string,
): Promise<{ sources: number; written: string[] }> {
  const classified = await readClassifiedSources(workspaceDir);
  if (classified.length === 0) {
    throw new Error(
      "sources/classified_sources.jsonl records no source, so there is nothing to derive a " +
      "bibliography from; repair the corpus before its bibliography");
  }
  // The bibliography, and ONLY the bibliography. The citation plan is an
  // allocation of sources to outline sections — a different artifact answering
  // a different question — and regenerating it here would silently discard
  // every section's allocation as a side effect of repairing a .bib file.
  const files: Array<[string, string]> = [
    ["sources/bibliography.bib", writeBibtex(classified)],
  ];
  const written: string[] = [];
  for (const [rel, body] of files) {
    const target = path.join(workspaceDir, rel);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, body, "utf-8");
    written.push(rel);
  }
  const report = [
    "# Bibliography repair", "",
    `Regenerated from ${classified.length} classified source(s).`,
    "",
    "The bibliography is derived from sources/classified_sources.jsonl. An inconsistency between",
    "it and the corpus is repaired by re-deriving it, never by editing the derived file — the",
    "next derivation would overwrite that edit. The citation plan is NOT touched here: it",
    "allocates sources to outline sections, and rebuilding it from the corpus alone would",
    "discard every section's allocation.",
    "",
  ].join("\n");
  const reportPath = path.join(workspaceDir, "reports", "bibliography-repair.md");
  await fs.mkdir(path.dirname(reportPath), { recursive: true });
  await fs.writeFile(reportPath, report, "utf-8");
  written.push("reports/bibliography-repair.md");
  return { sources: classified.length, written };
}

/** Rebuild the section allocation from the real outline and current corpus.
 * This is deliberately separate from bibliography repair: an unknown planned
 * source is an allocation defect, not source-identity drift, and rebuilding a
 * .bib file cannot correct it. */
export async function repairCitationPlan(
  workspaceDir: string,
): Promise<{ sections: number; written: string[] }> {
  const [classified, sections] = await Promise.all([
    readClassifiedSources(workspaceDir), plannedSections(workspaceDir),
  ]);
  if (classified.length === 0) throw new Error("cannot repair a citation plan without classified sources");
  const plan = buildCitationPlan(classified, sections);
  const target = path.join(workspaceDir, "sources", "citation_plan.jsonl");
  await fs.writeFile(target, toJsonl(plan), "utf-8");
  const report = ["# Citation-plan repair", "", `Regenerated ${plan.length} section allocation(s) from outline.json and the classified corpus.`, "", "This repair does not modify source metadata or the bibliography.", ""].join("\n");
  const reportPath = path.join(workspaceDir, "reports", "citation-plan-repair.md");
  await fs.mkdir(path.dirname(reportPath), { recursive: true });
  await fs.writeFile(reportPath, report, "utf-8");
  return { sections: plan.length, written: ["sources/citation_plan.jsonl", "reports/citation-plan-repair.md"] };
}

export async function repairSourceMetadata(
  workspaceDir: string,
  opts: { provider?: ResearchProvider; providerFactory?: (id: ResearchProviderId) => ResearchProvider; fetchImpl?: typeof fetch; maxLookups?: number } = {},
): Promise<{ records: number; written: string[]; replacementNeeded: string[] }> {
  const classified = await readClassifiedSources(workspaceDir);
  if (classified.length === 0) {
    throw new Error("sources/classified_sources.jsonl records no source metadata to repair");
  }

  // Reconciliation repairs DERIVABLE drift (for example a stale identity
  // record after a canonical DOI was added to classified_sources).  It cannot
  // conjure an identifier the corpus never acquired.  Those records must go
  // through a provider lookup, otherwise this action merely projects the same
  // incomplete source back into source-identities.jsonl and calls it repaired.
  const verification = await readCitationVerification(workspaceDir);
  const dead = new Set(verification.filter((entry) =>
    entry.status === "dead" || entry.status === "unknown").map((entry) => entry.source_id));
  // Prefer the workspace's retrieval provider, then the provider that supplied
  // this record, and finally the multi-provider adapter.  Metadata repair used
  // to silently force Crossref for every project, losing the richer identity
  // provenance that arXiv/OpenAlex/Semantic Scholar had already established.
  // An injected provider remains a deterministic test seam and an explicit
  // operator override.
  const configuredProvider = await loadProjectConfig(workspaceDir)
    .then((config) => config.research.provider as ResearchProviderId)
    .catch(() => undefined);
  const lookupLimit = opts.maxLookups ?? 20;
  const repaired: ClassifiedSource[] = [];
  const replacementNeeded: Array<{ source_id: string; title: string; reason: string; query: string }> = [];
  const outcomes: string[] = [];
  let lookups = 0;

  for (const source of classified) {
    const requiresIdentity = !hasStrongIdentifier(source);
    const requiresUrl = dead.has(source.id);
    if (!requiresIdentity && !requiresUrl) {
      repaired.push(source);
      outcomes.push(`- [reconciled] ${source.id}: identity is derivable from the classified record`);
      continue;
    }
    if (lookups >= lookupLimit) {
      repaired.push(source);
      replacementNeeded.push({ source_id: source.id, title: source.title, query: source.title,
        reason: "provider metadata lookup budget was exhausted" });
      outcomes.push(`- [replacement-needed] ${source.id}: provider lookup budget exhausted`);
      continue;
    }
    lookups += 1;
    try {
      const match = await findProviderMatch(source, configuredProvider, opts);
      const candidate = match?.candidate ?? null;
      if (!candidate) {
        repaired.push(source);
        replacementNeeded.push({ source_id: source.id, title: source.title, query: source.title,
          reason: "no provider record matched the classified title" });
        outcomes.push(`- [replacement-needed] ${source.id}: no provider metadata match`);
        continue;
      }
      const merged = mergeProviderMetadata(source, candidate, requiresUrl);
      if (requiresUrl && !await urlIsLive(merged.url, opts.fetchImpl)) {
        repaired.push(source);
        replacementNeeded.push({ source_id: source.id, title: source.title, query: source.title,
          reason: `provider canonical URL could not be validated: ${merged.url}` });
        outcomes.push(`- [replacement-needed] ${source.id}: replacement URL is not live`);
        continue;
      }
      repaired.push(merged);
      outcomes.push(`- [provider-repaired] ${source.id} via ${match!.provider.id}: ${[
        requiresIdentity ? "strong identifier" : null,
        requiresUrl ? "validated canonical URL" : null,
      ].filter(Boolean).join(" and ")}`);
    } catch (error) {
      repaired.push(source);
      replacementNeeded.push({ source_id: source.id, title: source.title, query: source.title,
        reason: `provider lookup failed: ${error instanceof Error ? error.message : String(error)}` });
      outcomes.push(`- [replacement-needed] ${source.id}: provider lookup failed`);
    }
  }

  await fs.writeFile(path.join(workspaceDir, "sources", "classified_sources.jsonl"), toJsonl(repaired), "utf-8");
  const replacementsPath = path.join(workspaceDir, "sources", "metadata-replacement-requests.json");
  await fs.writeFile(replacementsPath, `${JSON.stringify({ version: 1, requests: replacementNeeded }, null, 2)}\n`, "utf-8");

  // Regenerate identities from the repaired corpus, then rerun URL verification
  // against the exact records that will be cited.  The verification output is
  // a post-effect measurement, not the old failed log that prompted repair.
  const { reconcileWorkspaceSources } = await import("./identity.js");
  const { records, written } = await reconcileWorkspaceSources(workspaceDir);
  let urlVerification: string[] = [];
  try {
    urlVerification = (await verifyCitedSourceUrls(workspaceDir, { fetchImpl: opts.fetchImpl })).written;
  } catch (error) {
    outcomes.push(`- [url-verification-unavailable] ${error instanceof Error ? error.message : String(error)}`);
  }
  const report = [
    "# Source metadata repair", "",
    `Reconciled ${records.length} source identity record(s); consulted ${lookups} provider record(s).`,
    "",
    "Derivable identity drift is reconciled deterministically. Missing strong metadata is looked up",
    "from a provider. Dead URLs are replaced only with a provider canonical URL that was revalidated.",
    "Records with no recoverable identity are emitted as targeted replacement-source acquisition requests",
    "rather than being projected unchanged into source-identities.jsonl.", "",
    ...outcomes,
    "",
  ].join("\n");
  const reportPath = path.join(workspaceDir, "reports", "source-metadata-repair.md");
  await fs.mkdir(path.dirname(reportPath), { recursive: true });
  await fs.writeFile(reportPath, report, "utf-8");
  return {
    records: records.length,
    written: [...written, "sources/classified_sources.jsonl", "sources/metadata-replacement-requests.json", ...urlVerification, "reports/source-metadata-repair.md"],
    replacementNeeded: replacementNeeded.map((entry) => entry.source_id),
  };
}

const LIVE_PROVIDER_IDS = new Set<ResearchProviderId>([
  "arxiv", "semantic_scholar", "dblp", "crossref", "openalex", "multi",
]);

function providerIdsFor(source: ClassifiedSource, configured?: ResearchProviderId): ResearchProviderId[] {
  const origin = source.provenance?.provider ?? source.source;
  const primary = [configured, origin]
    .filter((id): id is ResearchProviderId => typeof id === "string" && LIVE_PROVIDER_IDS.has(id as ResearchProviderId));
  // The seed provider is an offline fixture.  Turning a seed-only rehearsal
  // into an implicit multi-provider network call makes a zero-spend dry run
  // hang on unavailable APIs and still cannot recover real metadata.  A live
  // configured/provenance provider gets `multi` as its bounded fallback.
  return [...new Set<ResearchProviderId>(primary.length > 0 ? [...primary, "multi"] : [])];
}

async function findProviderMatch(
  source: ClassifiedSource,
  configured: ResearchProviderId | undefined,
  opts: { provider?: ResearchProvider; providerFactory?: (id: ResearchProviderId) => ResearchProvider; fetchImpl?: typeof fetch; maxLookups?: number },
): Promise<{ provider: ResearchProvider; candidate: RawSource } | null> {
  const providers = opts.provider
    ? [opts.provider]
    : providerIdsFor(source, configured).map((id) => (opts.providerFactory ?? providerById)(id));
  for (const provider of providers) {
    const candidate = bestProviderMatch(source, await provider.search(source.title, 5));
    if (candidate) return { provider, candidate };
  }
  return null;
}

type VerificationRow = { source_id: string; status?: string };

async function readCitationVerification(workspaceDir: string): Promise<VerificationRow[]> {
  const file = path.join(workspaceDir, "sources", "citation-verification.jsonl");
  const raw = await fs.readFile(file, "utf-8").catch(() => "");
  return raw.split("\n").filter((line) => line.trim() !== "").flatMap((line) => {
    try {
      const parsed = JSON.parse(line) as Partial<VerificationRow>;
      return typeof parsed.source_id === "string" ? [{ source_id: parsed.source_id, status: parsed.status }] : [];
    } catch {
      return [];
    }
  });
}

function hasStrongIdentifier(source: ClassifiedSource): boolean {
  const id = source.identifiers;
  return Boolean(id?.doi || id?.arxiv_id || id?.semantic_scholar_id || id?.openalex_id);
}

function similarity(left: string, right: string): number {
  const a = new Set(left.toLowerCase().split(/[^a-z0-9]+/).filter((term) => term.length > 2));
  const b = new Set(right.toLowerCase().split(/[^a-z0-9]+/).filter((term) => term.length > 2));
  const overlap = [...a].filter((term) => b.has(term)).length;
  return overlap / Math.max(1, new Set([...a, ...b]).size);
}

function bestProviderMatch(source: ClassifiedSource, candidates: RawSource[]): RawSource | null {
  const best = candidates.map((candidate) => ({ candidate, score: similarity(source.title, candidate.title) }))
    .sort((a, b) => b.score - a.score || a.candidate.id.localeCompare(b.candidate.id))[0];
  return best && best.score >= 0.72 ? best.candidate : null;
}

function providerCanonicalUrl(source: RawSource): string {
  return source.links?.canonical_url
    ?? (source.identifiers?.doi ? `https://doi.org/${source.identifiers.doi}` : undefined)
    ?? source.url;
}

function mergeProviderMetadata(source: ClassifiedSource, candidate: RawSource, replaceUrl: boolean): ClassifiedSource {
  const canonical = providerCanonicalUrl(candidate);
  return {
    ...source,
    identifiers: { ...source.identifiers, ...candidate.identifiers },
    links: { ...source.links, ...candidate.links, canonical_url: canonical },
    // Only the canonical repair changes a defective URL. A sound existing URL
    // remains the citation surface the paper already used.
    url: replaceUrl ? canonical : source.url,
    venue: /^(arxiv|preprint|unknown)$/i.test(source.venue) ? candidate.venue : source.venue,
    identity: { ...source.identity, ...candidate.identity, canonical_url: canonical,
      doi: candidate.identifiers?.doi ?? source.identity?.doi,
      arxiv_id: candidate.identifiers?.arxiv_id ?? source.identity?.arxiv_id },
  };
}

async function urlIsLive(url: string, fetchImpl: typeof fetch | undefined): Promise<boolean> {
  if (!/^https?:\/\//i.test(url)) return false;
  const request = fetchImpl ?? fetch;
  try {
    let response = await request(url, { method: "HEAD", redirect: "follow", signal: AbortSignal.timeout(8_000) });
    if ([403, 405, 501].includes(response.status)) {
      response = await request(url, { method: "GET", redirect: "follow", signal: AbortSignal.timeout(8_000), headers: { range: "bytes=0-0" } });
    }
    return response.ok;
  } catch {
    return false;
  }
}

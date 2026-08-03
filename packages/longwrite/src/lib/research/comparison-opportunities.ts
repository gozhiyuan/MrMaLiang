import fs from "node:fs/promises";
import path from "node:path";

/**
 * Where in the manuscript does validated evidence sit that no artifact
 * currently serves?
 *
 * Removing the artifact quotas left the planner with a prohibition and no
 * affordance: a long list of what not to select, and nothing telling it where
 * a comparison would be justified. A quota was a crude affordance — it demanded
 * artifacts regardless of evidence — so the replacement has to come from the
 * corpus rather than from a number.
 *
 * This deliberately does not decide whether a section *should* have an
 * artifact, and emits no target, threshold, or pass/fail. It assembles what is
 * already verified — packet-backed sources, the taxonomy cells they span,
 * their recorded limitations, and the comparison dimensions their claims name
 * verbatim — and states whether an artifact is already placed there. Judging
 * which of those is worth a table is the planner's call.
 *
 * Clustering the comparison dimensions was the obvious first design and it
 * does not work: on a real flagship corpus, 113 dimension strings were 111
 * distinct, because they are free-text descriptions rather than a controlled
 * vocabulary. Term overlap only recovers topic words ("task", "agent"). So the
 * dimensions are passed through verbatim for a reader who can tell that
 * "loop-closure degree" and "human involvement" are comparable axes.
 */
export type SectionOpportunity = {
  section_id: string;
  title: string;
  /** Sources cited by the section that carry a validated evidence packet. */
  packet_backed_sources: number;
  /** Distinct screening taxonomy cells those sources span. */
  taxonomy_cells: string[];
  /** Limitations recorded across those sources' validated claims. */
  recorded_limitations: number;
  /** Verbatim comparison dimensions, deduplicated, never clustered. */
  comparison_dimensions: string[];
  /** Ids of artifacts the current visual plan places in this section. */
  placed_artifacts: string[];
};

export type ComparisonOpportunityReport = {
  version: 1;
  sections: SectionOpportunity[];
};

type EvidenceEntry = {
  screening?: { source_id?: unknown; taxonomy_cells?: unknown };
  packet?: { source_id?: unknown; claims?: Array<{ comparison_dimensions?: unknown; limitations?: unknown }> };
};

async function readJson<T>(workspaceDir: string, rel: string): Promise<T | null> {
  try {
    return JSON.parse(await fs.readFile(path.join(workspaceDir, rel), "utf-8")) as T;
  } catch {
    return null;
  }
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0) : [];
}

/** Artifact ids the visual plan currently places, grouped by section. */
async function placementsBySection(workspaceDir: string): Promise<Map<string, string[]>> {
  const plan = await readJson<{
    placements?: Array<{ id?: unknown; placement?: { section_id?: unknown } }>;
    table_specs?: Array<{ id?: unknown; placement?: { section_id?: unknown } }>;
    timelines?: Array<{ id?: unknown; placement?: { section_id?: unknown } }>;
    diagrams?: Array<{ id?: unknown; placement?: { section_id?: unknown } }>;
    concept_map?: { placement?: { section_id?: unknown } };
  }>(workspaceDir, path.join("figures", "placement-plan.json"));
  const bySection = new Map<string, string[]>();
  const add = (sectionId: unknown, id: string) => {
    if (typeof sectionId !== "string" || sectionId.length === 0) return;
    bySection.set(sectionId, [...(bySection.get(sectionId) ?? []), id]);
  };
  for (const group of [plan?.placements, plan?.table_specs, plan?.timelines, plan?.diagrams]) {
    for (const item of group ?? []) add(item?.placement?.section_id, typeof item?.id === "string" ? item.id : "artifact");
  }
  if (plan?.concept_map) add(plan.concept_map.placement?.section_id, "concept-map");

  // A placement is a request, not an outcome: a plan can name a retired
  // built-in, and a backend can fail to render. Report what the manuscript
  // actually carries, or a section looks served by an artifact no reader will
  // ever see. Before the first build there is no manifest, so fall back to the
  // request rather than reporting everything as unserved.
  const manifest = await readJson<{ figures?: Array<{ id?: unknown }>; tables?: Array<{ id?: unknown }> }>(workspaceDir, path.join("figures", "manifest.json"));
  if (!manifest) return new Map([...bySection].map(([section, ids]) => [section, [...new Set(ids)]]));
  const published = new Set([...(manifest.figures ?? []), ...(manifest.tables ?? [])]
    .map((item) => item?.id).filter((id): id is string => typeof id === "string"));
  return new Map([...bySection].map(([section, ids]) => [section, [...new Set(ids)].filter((id) => published.has(id))]));
}

export async function evaluateComparisonOpportunities(workspaceDir: string): Promise<ComparisonOpportunityReport> {
  const outline = await readJson<{ sections?: Array<{ id?: unknown; title?: unknown; source_ids?: unknown }> }>(workspaceDir, "outline.json");
  // The active file is the citation-ready cumulative set; fall back to the
  // working round so this still reports before the first finalization.
  const evidence = await readJson<{ entries?: EvidenceEntry[] }>(workspaceDir, path.join("evidence", "active-validated-source-evidence.json"))
    ?? await readJson<{ entries?: EvidenceEntry[] }>(workspaceDir, path.join("evidence", "validated-source-evidence.json"));

  const cells = new Map<string, string[]>();
  const dimensions = new Map<string, string[]>();
  const limitations = new Map<string, number>();
  for (const entry of evidence?.entries ?? []) {
    const sourceId = typeof entry.packet?.source_id === "string" ? entry.packet.source_id
      : typeof entry.screening?.source_id === "string" ? entry.screening.source_id : undefined;
    if (!sourceId) continue;
    cells.set(sourceId, asStringArray(entry.screening?.taxonomy_cells));
    const claims = entry.packet?.claims ?? [];
    dimensions.set(sourceId, claims.flatMap((claim) => asStringArray(claim.comparison_dimensions)));
    limitations.set(sourceId, claims.reduce((total, claim) => total + asStringArray(claim.limitations).length, 0));
  }

  const placed = await placementsBySection(workspaceDir);
  const sections = (outline?.sections ?? []).flatMap((section) => {
    const sectionId = typeof section.id === "string" ? section.id : undefined;
    if (!sectionId) return [];
    const sourceIds = asStringArray(section.source_ids).filter((id) => dimensions.has(id));
    return [{
      section_id: sectionId,
      title: typeof section.title === "string" ? section.title : sectionId,
      packet_backed_sources: sourceIds.length,
      taxonomy_cells: [...new Set(sourceIds.flatMap((id) => cells.get(id) ?? []))].sort(),
      recorded_limitations: sourceIds.reduce((total, id) => total + (limitations.get(id) ?? 0), 0),
      comparison_dimensions: [...new Set(sourceIds.flatMap((id) => dimensions.get(id) ?? []))],
      placed_artifacts: placed.get(sectionId) ?? [],
    }];
  });
  return { version: 1, sections };
}

function markdown(report: ComparisonOpportunityReport): string {
  const lines = [
    "# Comparison opportunities",
    "",
    "Validated evidence already available per outline section, and whether an",
    "artifact currently serves it. This is an observation, not a target: there",
    "is no required number of figures or tables, and a section with rich",
    "evidence may still be better served by prose. Selecting an artifact that",
    "no evidence here supports is the failure this report exists to prevent.",
    "",
    "| Section | Packet-backed sources | Taxonomy cells | Recorded limitations | Artifacts placed |",
    "| --- | ---: | ---: | ---: | --- |",
  ];
  for (const section of report.sections) {
    const placed = section.placed_artifacts.length > 0 ? section.placed_artifacts.join(", ") : "—";
    lines.push(`| ${section.section_id} ${section.title} | ${section.packet_backed_sources} | ${section.taxonomy_cells.length} | ${section.recorded_limitations} | ${placed} |`);
  }
  for (const section of report.sections) {
    if (section.comparison_dimensions.length === 0) continue;
    lines.push("", `## ${section.section_id} — comparison dimensions named by its validated claims`, "");
    // Verbatim and unclustered: these are free-text descriptions, and deciding
    // which of them are the same axis is a judgment, not a string match.
    for (const dimension of section.comparison_dimensions) lines.push(`- ${dimension}`);
  }
  lines.push("");
  return lines.join("\n");
}

export async function writeComparisonOpportunities(workspaceDir: string): Promise<string[]> {
  const report = await evaluateComparisonOpportunities(workspaceDir);
  await fs.mkdir(path.join(workspaceDir, "reports"), { recursive: true });
  await fs.writeFile(path.join(workspaceDir, "reports", "comparison-opportunities.json"), `${JSON.stringify(report, null, 2)}\n`, "utf-8");
  await fs.writeFile(path.join(workspaceDir, "reports", "comparison-opportunities.md"), markdown(report), "utf-8");
  return ["reports/comparison-opportunities.json", "reports/comparison-opportunities.md"];
}

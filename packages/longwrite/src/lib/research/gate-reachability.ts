import fs from "node:fs/promises";
import path from "node:path";
import { loadProjectConfig } from "../project-config.js";
import { parseJsonl } from "./jsonl.js";
import type { ClassifiedSource } from "./types.js";

/**
 * Can the release gates still be met by the corpus that exists?
 *
 * A release gate is checked at the end, which is the worst moment to discover
 * it was never satisfiable. A flagship run drafted 14k words before its
 * per-section A-level requirement met a corpus holding zero A-level sources —
 * a gate that no amount of revision could have cleared, because the supply was
 * fixed long before drafting began.
 *
 * The useful signal is not static. Nothing in that workspace's configuration
 * was self-contradictory on its face: 20 core sources under a budget of 32,
 * 10 required taxonomy-cell citations under the same budget, 80 required
 * citations against 418 available C-level records. Only the observed corpus
 * shows the problem. So this compares configured requirements against the
 * corpus as classified, and reports what is already out of reach.
 *
 * It reports; it does not fail. Deciding whether to lower a target, spend more
 * on evidence, or narrow the paper's scope is the operator's call, and a hard
 * failure here would only relocate the same dead end to an earlier stage.
 */
export type GateReachability = {
  id: string;
  reachable: boolean;
  required: number;
  available: number;
  detail: string;
};

export type GateReachabilityReport = {
  version: 1;
  evaluated: boolean;
  gates: GateReachability[];
};

async function readClassified(workspaceDir: string): Promise<ClassifiedSource[]> {
  try {
    return parseJsonl<ClassifiedSource>(await fs.readFile(path.join(workspaceDir, "sources", "classified_sources.jsonl"), "utf-8"));
  } catch {
    return [];
  }
}

async function outlineSectionCount(workspaceDir: string): Promise<number> {
  try {
    const outline = JSON.parse(await fs.readFile(path.join(workspaceDir, "outline.json"), "utf-8")) as { sections?: unknown[] };
    return Array.isArray(outline.sections) ? outline.sections.length : 0;
  } catch {
    return 0;
  }
}

export async function evaluateGateReachability(workspaceDir: string): Promise<GateReachabilityReport> {
  const config = await loadProjectConfig(workspaceDir);
  const sources = await readClassified(workspaceDir);
  if (sources.length === 0) return { version: 1, evaluated: false, gates: [] };

  const gates = config.research.release_gates;
  const depth = (level: string) => sources.filter((source) => source.citation_depth === level).length;
  const counts = { A: depth("A"), B: depth("B"), C: depth("C") };
  const citable = counts.A + counts.B + counts.C;
  const sections = await outlineSectionCount(workspaceDir);
  const cells = config.research.taxonomy.length;
  const budget = config.research.semantic_screen.max_evidence_sources;
  const findings: GateReachability[] = [];

  findings.push({
    id: "min_cited_sources",
    reachable: citable >= gates.min_cited_sources,
    required: gates.min_cited_sources,
    available: citable,
    detail: `${citable} citable sources classified (A ${counts.A}, B ${counts.B}, C ${counts.C}); the gate needs ${gates.min_cited_sources}.`,
  });

  // Per-section depth is where a fixed evidence budget becomes visible: A and B
  // require a validated packet, so their supply is capped long before drafting.
  for (const level of ["A", "B"] as const) {
    const required = gates.min_citation_depths_per_section[level];
    if (required <= 0 || sections === 0) continue;
    const available = counts[level];
    findings.push({
      id: `min_citation_depths_per_section.${level}`,
      reachable: available > 0,
      required,
      available,
      detail: available > 0
        ? `${available} ${level}-level sources exist for ${sections} sections needing ${required} each; sources may be cited in more than one section.`
        : `No ${level}-level source exists, so no section can satisfy its ${level}:${required} requirement. ${level} depth requires a validated evidence packet, capped by research.semantic_screen.max_evidence_sources (${budget}) and by min_supported_claims_for_${level.toLowerCase()}.`,
    });
  }

  if (gates.min_cited_ab_sources_per_taxonomy_cell > 0 && cells > 0) {
    const required = gates.min_cited_ab_sources_per_taxonomy_cell * cells;
    const available = counts.A + counts.B;
    findings.push({
      id: "min_cited_ab_sources_per_taxonomy_cell",
      reachable: available >= required,
      required,
      available,
      detail: `${cells} taxonomy cells need ${gates.min_cited_ab_sources_per_taxonomy_cell} A/B sources each (${required} total if no source serves two cells); ${available} A/B sources exist.`,
    });
  }

  return { version: 1, evaluated: true, gates: findings };
}

function markdown(report: GateReachabilityReport): string {
  if (!report.evaluated) {
    return "# Release-gate reachability\n\nNo classified corpus yet; reachability is evaluated once sources are classified.\n";
  }
  const blocked = report.gates.filter((gate) => !gate.reachable);
  const lines = [
    "# Release-gate reachability",
    "",
    "Whether each configured release gate can still be met by the corpus that",
    "exists. This reports and never fails: a gate out of reach is a decision —",
    "lower the target, raise the evidence budget, or narrow the paper's scope —",
    "and failing here would only move the same dead end earlier.",
    "",
    `Status: ${blocked.length === 0 ? "every gate is still reachable." : `${blocked.length} gate(s) already out of reach.`}`,
    "",
    "| Gate | Required | Available | Reachable |",
    "| --- | ---: | ---: | :---: |",
  ];
  for (const gate of report.gates) {
    lines.push(`| ${gate.id} | ${gate.required} | ${gate.available} | ${gate.reachable ? "yes" : "**no**"} |`);
  }
  for (const gate of report.gates) lines.push("", `## ${gate.id}`, "", gate.detail);
  lines.push("");
  return lines.join("\n");
}

export async function writeGateReachability(workspaceDir: string): Promise<{ report: GateReachabilityReport; written: string[] }> {
  const report = await evaluateGateReachability(workspaceDir);
  await fs.mkdir(path.join(workspaceDir, "reports"), { recursive: true });
  await fs.writeFile(path.join(workspaceDir, "reports", "gate-reachability.json"), `${JSON.stringify(report, null, 2)}\n`, "utf-8");
  await fs.writeFile(path.join(workspaceDir, "reports", "gate-reachability.md"), markdown(report), "utf-8");
  return { report, written: ["reports/gate-reachability.json", "reports/gate-reachability.md"] };
}

import fs from "node:fs/promises";
import path from "node:path";
import { parseJsonl } from "./jsonl.js";
import type { ClassifiedSource } from "./types.js";

export type SurveyContractReport = {
  version: 1;
  pass: boolean;
  findings: Array<{ id: string; pass: boolean; detail: string }>;
  sections: Array<{ id: string; title: string; role: string }>;
};

type OutlineSection = {
  id?: unknown;
  title?: unknown;
  role?: unknown;
  keywords?: unknown;
};

const SURVEY_ROLES = new Set([
  "introduction_gap_contributions",
  "multi_axis_taxonomy",
  "method_family",
  "related_work_differentiation",
  "limitations_future_work",
  "body",
]);

function textIncludes(text: string, terms: string[]): boolean {
  const normalized = text.toLowerCase();
  return terms.some((term) => normalized.includes(term));
}

function sectionRole(title: string, declaredRole?: string): string {
  // The outline contract carries an explicit semantic role. Preserve a
  // title-based fallback for workspaces made before this field was required.
  if (declaredRole && SURVEY_ROLES.has(declaredRole)) return declaredRole;
  if (textIncludes(title, ["intro", "problem", "gap", "contribution"])) return "introduction_gap_contributions";
  if (textIncludes(title, ["taxonomy", "classification", "framework"])) return "multi_axis_taxonomy";
  if (textIncludes(title, ["method", "approach", "family", "architecture"])) return "method_family";
  if (textIncludes(title, ["related", "prior survey", "comparison"])) return "related_work_differentiation";
  if (textIncludes(title, ["limitation", "open", "future", "question"])) return "limitations_future_work";
  return "body";
}

async function readOutline(workspaceDir: string): Promise<Array<{ id: string; title: string; role?: string; keywords: string[] }>> {
  const raw = JSON.parse(await fs.readFile(path.join(workspaceDir, "outline.json"), "utf-8")) as { sections?: OutlineSection[] };
  return (raw.sections ?? []).flatMap((section, index) => {
    if (typeof section.id !== "string" || typeof section.title !== "string") return [];
    const keywords = Array.isArray(section.keywords) ? section.keywords.filter((k): k is string => typeof k === "string") : [];
    const role = typeof section.role === "string" ? section.role : undefined;
    return [{ id: section.id || `section-${index + 1}`, title: section.title, role, keywords }];
  });
}

function markdownTable(headers: string[], rows: string[][]): string {
  return [
    `| ${headers.join(" | ")} |`,
    `| ${headers.map(() => "---").join(" | ")} |`,
    ...rows.map((row) => `| ${row.join(" | ")} |`),
    "",
  ].join("\n");
}

function relatedWorkMatrix(sources: ClassifiedSource[]): string {
  const rows = sources
    .filter((source) => source.citation_depth === "A" || source.citation_depth === "B")
    .slice(0, 24)
    .map((source) => [
      source.id,
      String(source.year),
      source.venue.replace(/\|/g, "/"),
      source.topics.slice(0, 4).join(", ").replace(/\|/g, "/"),
      source.citation_depth,
    ]);
  return [
    "# Related-Work Comparison Matrix",
    "",
    "This deterministic matrix is a drafting input: the writer must differentiate the manuscript from these core sources instead of summarizing them one-by-one.",
    "",
    markdownTable(["Source", "Year", "Venue", "Topics", "Depth"], rows),
  ].join("\n");
}

export async function evaluateSurveyContract(workspaceDir: string): Promise<{ report: SurveyContractReport; written: string[] }> {
  const sections = await readOutline(workspaceDir);
  const sourceRaw = await fs.readFile(path.join(workspaceDir, "sources", "classified_sources.jsonl"), "utf-8");
  const sources = parseJsonl<ClassifiedSource>(sourceRaw);
  const roles = sections.map((section) => ({ id: section.id, title: section.title, role: sectionRole(section.title, section.role) }));
  const roleSet = new Set(roles.map((role) => role.role));
  const coreSources = sources.filter((source) => source.citation_depth === "A" || source.citation_depth === "B");
  const findings = [
    {
      id: "introduction_gap_contributions",
      pass: roleSet.has("introduction_gap_contributions"),
      detail: "Outline includes an introduction/problem-gap/contributions section.",
    },
    {
      id: "multi_axis_taxonomy",
      pass: roleSet.has("multi_axis_taxonomy"),
      detail: "Outline includes an explicit taxonomy/classification/framework section.",
    },
    {
      id: "method_family_chapters",
      pass: roles.filter((role) => role.role === "method_family").length >= 2,
      detail: "Outline includes at least two method-family sections.",
    },
    {
      id: "related_work_differentiation",
      pass: roleSet.has("related_work_differentiation"),
      detail: "Outline includes a related-work differentiation/comparison section.",
    },
    {
      id: "limitations_future_work",
      pass: roleSet.has("limitations_future_work"),
      detail: "Outline includes limitations, unresolved questions, or future-work discussion.",
    },
    {
      id: "section_evidence_requirements",
      pass: sections.every((section) => section.keywords.length > 0),
      detail: "Every outline section declares keywords for section-level evidence allocation.",
    },
    {
      id: "related_work_matrix",
      pass: coreSources.length >= 5,
      detail: `${coreSources.length} A/B-depth sources available for related-work matrix; required 5.`,
    },
  ];
  const report: SurveyContractReport = { version: 1, pass: findings.every((finding) => finding.pass), findings, sections: roles };
  await fs.mkdir(path.join(workspaceDir, "reports"), { recursive: true });
  await fs.mkdir(path.join(workspaceDir, "tables"), { recursive: true });
  const written = ["reports/survey-contract.json", "reports/survey-contract.md", "tables/related-work-matrix.md"];
  await Promise.all([
    fs.writeFile(path.join(workspaceDir, written[0]), `${JSON.stringify(report, null, 2)}\n`, "utf-8"),
    fs.writeFile(path.join(workspaceDir, written[1]), [
      "# Survey Contract",
      "",
      `Status: ${report.pass ? "pass" : "fail"}`,
      "",
      ...findings.map((finding) => `- [${finding.pass ? "pass" : "fail"}] ${finding.id}: ${finding.detail}`),
      "",
    ].join("\n"), "utf-8"),
    fs.writeFile(path.join(workspaceDir, written[2]), relatedWorkMatrix(sources), "utf-8"),
  ]);
  return { report, written };
}

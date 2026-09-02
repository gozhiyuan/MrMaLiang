import fs from "node:fs/promises";
import path from "node:path";
import { parseJsonl } from "./jsonl.js";
import type { ClassifiedSource } from "./types.js";
import { gateId } from "../registry/ids.js";
import { FindingSchema, type StructuredCheck } from "../registry/records.js";
import { GLOBAL_SCOPE } from "../registry/scope.js";

export type SurveyContractReport = {
  version: 1;
  pass: boolean;
  /** The routable output. `findings` below is the operator summary derived
   * from it, kept because the JSON report and its Markdown rendering are read
   * by people. */
  checks: StructuredCheck[];
  findings: Array<{ id: string; pass: boolean; detail: string }>;
  sections: Array<{ id: string; title: string; role: string }>;
};

/** Every gate here is a defect in how the survey is organised, which is
 * repaired by reopening the outline. related_work_matrix is the exception: it
 * can also be short because the comparison table itself is thin. */
const ROUTES: Record<string, { kind: "outline" | "table_spec"; effect: "replace_organizing_claim" | "repair_artifact_content" }> = {
  introduction_gap_contributions: { kind: "outline", effect: "replace_organizing_claim" },
  multi_axis_taxonomy: { kind: "outline", effect: "replace_organizing_claim" },
  method_family_chapters: { kind: "outline", effect: "replace_organizing_claim" },
  related_work_differentiation: { kind: "outline", effect: "replace_organizing_claim" },
  limitations_future_work: { kind: "outline", effect: "replace_organizing_claim" },
  section_evidence_requirements: { kind: "outline", effect: "replace_organizing_claim" },
  chapter_outline_identity: { kind: "outline", effect: "replace_organizing_claim" },
  related_work_matrix: { kind: "table_spec", effect: "repair_artifact_content" },
};

const ROUTE_PATHS = { outline: "outline.json", table_spec: "figures/placement-plan.json" } as const;

function surveyCheck(entry: { id: string; pass: boolean; detail: string }): StructuredCheck {
  const route = ROUTES[entry.id];
  if (!route) throw new Error(`survey gate ${entry.id} has no declared repair route`);
  return {
    id: gateId(entry.id), pass: entry.pass, measurements: [], requires_diagnosis: false,
    diagnostic: entry.detail,
    findings: entry.pass ? [] : [FindingSchema.parse({
      id: entry.id,
      gate_id: entry.id,
      artifact: { kind: route.kind, path: ROUTE_PATHS[route.kind] },
      objective_scope_key: GLOBAL_SCOPE,
      required_effect: route.effect,
      severity: "major",
      diagnostic: entry.detail,
    })],
  };
}

type OutlineSection = {
  id?: unknown;
  title?: unknown;
  role?: unknown;
  keywords?: unknown;
};

const KEYWORD_STOPWORDS = new Set(["and", "the", "for", "with", "from", "into", "that", "this", "about", "within", "across", "section"]);

function fallbackKeywords(title: string): string[] {
  const terms = title.toLowerCase().match(/[a-z][a-z0-9-]{2,}/g) ?? [];
  return [...new Set(terms.filter((term) => !KEYWORD_STOPWORDS.has(term)))].slice(0, 4);
}

type OutlineIdentityRepair = {
  repaired: Array<{ from: string; to: string }>;
  mismatch?: string;
};

function sectionOrdinal(id: string): string | null {
  return id.match(/^section-(\d+)(?:-|$)/)?.[1] ?? null;
}

/**
 * After drafting starts, outline IDs are the durable join keys for chapters,
 * evidence allocations, placed artifacts, and LaTeX inputs. A structural
 * reopen may change titles and organizing logic, but must not casually rename
 * those keys. Repair the common one-to-one LLM rename (same ordered ordinals)
 * before downstream stages can spend a full round rebuilding an inconsistent
 * paper. A cardinality or ordering change is deliberately surfaced as a
 * contract finding: it needs an explicit chapter-migration operation.
 */
async function restoreOutlineChapterIds(workspaceDir: string, raw: { sections?: OutlineSection[] }): Promise<OutlineIdentityRepair> {
  const chapterDir = path.join(workspaceDir, "chapters");
  const chapterIds = (await fs.readdir(chapterDir).catch(() => []))
    .filter((name) => name.endsWith(".md"))
    .map((name) => path.basename(name, ".md"))
    .sort();
  const sections = raw.sections ?? [];
  if (chapterIds.length === 0 || sections.length === 0) return { repaired: [] };
  const outlineIds = sections.map((section) => typeof section.id === "string" ? section.id : "");
  if (outlineIds.length !== chapterIds.length) {
    return { repaired: [], mismatch: `outline declares ${outlineIds.length} sections but chapters/ has ${chapterIds.length}; a structural reopen must preserve the existing chapter set or use an explicit chapter migration.` };
  }
  if (new Set(outlineIds).size !== outlineIds.length || outlineIds.some((id) => !id)) {
    return { repaired: [], mismatch: "outline section IDs are missing or duplicated while chapters already exist; preserve the existing chapter IDs exactly." };
  }
  if (outlineIds.every((id) => chapterIds.includes(id))) return { repaired: [] };
  const sameOrderedOrdinals = outlineIds.every((id, index) => {
    const expected = chapterIds[index];
    return sectionOrdinal(id) !== null && sectionOrdinal(id) === sectionOrdinal(expected);
  });
  if (!sameOrderedOrdinals) {
    return { repaired: [], mismatch: "outline section IDs no longer map one-to-one to the existing ordered chapter IDs; preserve IDs, or perform an explicit chapter migration before rebuild." };
  }
  const repaired = outlineIds.flatMap((from, index) => {
    const to = chapterIds[index];
    if (from === to) return [];
    sections[index].id = to;
    return [{ from, to }];
  });
  return { repaired };
}

async function repairOutlineForExistingChapters(workspaceDir: string): Promise<{ keywords: string[]; ids: Array<{ from: string; to: string }>; mismatch?: string }> {
  const outlinePath = path.join(workspaceDir, "outline.json");
  const raw = JSON.parse(await fs.readFile(outlinePath, "utf-8")) as { sections?: OutlineSection[] };
  const identity = await restoreOutlineChapterIds(workspaceDir, raw);
  if (!Array.isArray(raw.sections)) return { keywords: [], ids: identity.repaired, mismatch: identity.mismatch };
  const repaired: string[] = [];
  raw.sections.forEach((section, index) => {
    const existing = Array.isArray(section.keywords) ? section.keywords.filter((value): value is string => typeof value === "string" && value.trim().length > 0) : [];
    if (existing.length > 0 || typeof section.title !== "string") return;
    const keywords = fallbackKeywords(section.title);
    if (keywords.length === 0) return;
    section.keywords = keywords;
    repaired.push(typeof section.id === "string" ? section.id : `section-${index + 1}`);
  });
  if (repaired.length > 0 || identity.repaired.length > 0) await fs.writeFile(outlinePath, `${JSON.stringify(raw, null, 2)}\n`, "utf-8");
  return { keywords: repaired, ids: identity.repaired, mismatch: identity.mismatch };
}

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
  const repairedOutline = await repairOutlineForExistingChapters(workspaceDir);
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
      id: "chapter_outline_identity",
      pass: !repairedOutline.mismatch,
      detail: repairedOutline.mismatch ?? "Outline section IDs align with the existing chapter identity keys.",
    },
    {
      id: "related_work_matrix",
      pass: coreSources.length >= 5,
      detail: `${coreSources.length} A/B-depth sources available for related-work matrix; required 5.`,
    },
  ];
  const report: SurveyContractReport = {
    version: 1, pass: findings.every((finding) => finding.pass),
    checks: findings.map(surveyCheck), findings, sections: roles,
  };
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
      ...(repairedOutline.keywords.length > 0 ? [`- [repair] Restored title-derived keywords for: ${repairedOutline.keywords.join(", ")}`] : []),
      ...(repairedOutline.ids.length > 0 ? [`- [repair] Restored stable chapter IDs: ${repairedOutline.ids.map(({ from, to }) => `${from} → ${to}`).join(", ")}`] : []),
      ...findings.map((finding) => `- [${finding.pass ? "pass" : "fail"}] ${finding.id}: ${finding.detail}`),
      "",
    ].join("\n"), "utf-8"),
    fs.writeFile(path.join(workspaceDir, written[2]), relatedWorkMatrix(sources), "utf-8"),
  ]);
  return { report, written };
}

import { defineProducer } from "../registry/producer-types.js";

/** Gate declarations, kept beside the checks that emit them so a reviewer
 * sees a gate's repair semantics and its code together. The class table,
 * legal triples and routes are all generated from this. */
export const PRODUCER = defineProducer({
  module: "survey-contract",
  gates: [
    { id: "introduction_gap_contributions", class: "manuscript", findings: [
      { kind: "outline", effect: "replace_organizing_claim", capability: "reopen_outline" },
    ] },
    { id: "multi_axis_taxonomy", class: "manuscript", findings: [
      { kind: "outline", effect: "replace_organizing_claim", capability: "reopen_outline" },
    ] },
    { id: "method_family_chapters", class: "manuscript", findings: [
      { kind: "outline", effect: "replace_organizing_claim", capability: "reopen_outline" },
    ] },
    { id: "related_work_differentiation", class: "manuscript", findings: [
      { kind: "outline", effect: "replace_organizing_claim", capability: "reopen_outline" },
    ] },
    { id: "limitations_future_work", class: "manuscript", findings: [
      { kind: "outline", effect: "replace_organizing_claim", capability: "reopen_outline" },
    ] },
    { id: "section_evidence_requirements", class: "manuscript", findings: [
      { kind: "outline", effect: "replace_organizing_claim", capability: "reopen_outline" },
    ] },
    { id: "chapter_outline_identity", class: "manuscript", findings: [
      { kind: "outline", effect: "replace_organizing_claim", capability: "reopen_outline" },
    ] },
    { id: "related_work_matrix", class: "manuscript", findings: [
      { kind: "outline", effect: "replace_organizing_claim", capability: "reopen_outline" },
      { kind: "table_spec", effect: "repair_artifact_content", capability: "revise_visual_plan" },
    ] },
  ],
});

import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { loadProjectConfig } from "../project-config.js";
import { paperProfile } from "../paper-profiles.js";
import { loadCodebaseManifest } from "../research/codebase-contract.js";
import { parseJsonl } from "../research/jsonl.js";
import type { ClassifiedSource } from "../research/types.js";

const AcceptanceCriterion = z.object({
  metric: z.enum(["citation_depth_per_section", "taxonomy_cell_ab_sources", "comparative_tables", "verified_metadata_plots", "figures", "tables", "empirical_trials"]),
  target: z.number().nonnegative(),
  scope: z.string().min(1).max(160).optional(),
}).strict();

/** This is a creative decision record, not a command channel. The LLM may
 * choose a small number of analytical artifacts, while renderers and workers
 * remain responsible for their bounded output contracts. */
const ArtifactIntent = z.object({
  id: z.string().min(1).regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/),
  kind: z.enum(["formalization", "comparison_matrix", "metadata_plot", "timeline", "architecture_diagram", "taxonomy_recall", "empirical_pilot"]),
  rationale: z.string().min(20).max(4_000),
  section_id: z.string().min(1).max(160).optional(),
  source_ids: z.array(z.string().min(1)).max(12).default([]),
  taxonomy_cell: z.string().min(2).max(240).optional(),
  plot_metric: z.enum(["publication_year", "citation_depth", "venue"]).optional(),
  experiment_hypothesis: z.string().min(20).max(2_000).optional(),
  control: z.string().min(10).max(2_000).optional(),
  acceptance_criteria: z.array(AcceptanceCriterion).min(1).max(3),
}).strict().superRefine((intent, ctx) => {
  if (intent.kind === "formalization" && (!intent.section_id || intent.source_ids.length === 0)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "formalization requires section_id and at least one supporting source_id" });
  }
  if (intent.kind === "comparison_matrix" && intent.source_ids.length === 0) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "comparison_matrix requires representative source_ids" });
  }
  if (intent.kind === "metadata_plot" && (!intent.section_id || !intent.plot_metric)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "metadata_plot requires section_id and plot_metric" });
  }
  if (intent.kind === "timeline" && (!intent.section_id || intent.source_ids.length < 3)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "timeline requires section_id and at least three supporting source_ids" });
  }
  if (intent.kind === "architecture_diagram" && (!intent.section_id || intent.source_ids.length < 1)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "architecture_diagram requires section_id and at least one supporting source_id" });
  }
  if (intent.kind === "taxonomy_recall" && !intent.taxonomy_cell) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "taxonomy_recall requires taxonomy_cell" });
  }
  if (intent.kind === "empirical_pilot" && (!intent.experiment_hypothesis || !intent.control)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "empirical_pilot requires experiment_hypothesis and control" });
  }
});

export const AgenticArtifactPlan = z.object({
  version: z.literal(1),
  intents: z.array(ArtifactIntent).max(5),
}).strict().superRefine((plan, ctx) => {
  const ids = new Set<string>();
  for (const [index, intent] of plan.intents.entries()) {
    if (ids.has(intent.id)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["intents", index, "id"], message: `duplicate intent id ${intent.id}` });
    ids.add(intent.id);
  }
});

export type AgenticArtifactPlan = z.infer<typeof AgenticArtifactPlan>;

function unwrapFence(raw: string): { content: string; normalized: boolean } {
  const trimmed = raw.trim();
  const matched = trimmed.match(/^```(?:json)?\s*\n([\s\S]*?)\n```$/i);
  return matched ? { content: matched[1]!.trim(), normalized: true } : { content: trimmed, normalized: false };
}

async function knownSections(workspaceDir: string): Promise<Set<string>> {
  try {
    const outline = JSON.parse(await fs.readFile(path.join(workspaceDir, "outline.json"), "utf-8")) as { sections?: Array<{ id?: unknown }> };
    return new Set((outline.sections ?? []).flatMap((section) => typeof section.id === "string" ? [section.id] : []));
  } catch {
    return new Set();
  }
}

/** Normalize a fenced plan, then make the LLM's intellectual choices
 * inspectable against the current workspace. It deliberately does not choose
 * an artifact on the model's behalf. */
export async function repairAgenticArtifactPlan(workspaceDir: string): Promise<{ normalized: boolean; reportPath: string }> {
  const target = path.join(workspaceDir, "reviews", "artifact-plan.json");
  const reportPath = path.join(workspaceDir, "reports", "artifact-plan-repair.md");
  const raw = await fs.readFile(target, "utf-8");
  const { content, normalized } = unwrapFence(raw);
  let plan: AgenticArtifactPlan;
  try {
    plan = AgenticArtifactPlan.parse(JSON.parse(content));
    const [config, sections, sourceRaw, codebaseRaw] = await Promise.all([
      loadProjectConfig(workspaceDir),
      knownSections(workspaceDir),
      fs.readFile(path.join(workspaceDir, "sources", "classified_sources.jsonl"), "utf-8").catch(() => ""),
      loadCodebaseManifest(workspaceDir),
    ]);
    const sourceIds = new Set(parseJsonl<ClassifiedSource>(sourceRaw).map((source) => source.id));
    const codebaseIds = new Set((codebaseRaw?.codebases ?? []).map((codebase) => `codebase:${codebase.id}`));
    const profile = paperProfile(config.research.paper_profile);
    for (const intent of plan.intents) {
      if (intent.section_id && sections.size > 0 && !sections.has(intent.section_id)) throw new Error(`artifact intent ${intent.id} names unknown section ${intent.section_id}`);
      for (const sourceId of intent.source_ids) {
        if (!sourceIds.has(sourceId) && !codebaseIds.has(sourceId)) throw new Error(`artifact intent ${intent.id} names unknown source/codebase ${sourceId}`);
        if (codebaseIds.has(sourceId) && intent.kind !== "architecture_diagram") throw new Error(`artifact intent ${intent.id} may use pinned codebase evidence only for architecture_diagram`);
      }
      if (intent.kind === "architecture_diagram") {
        if (profile.architectureDiagram.requiresPinnedCodebaseSource && !intent.source_ids.some((sourceId) => codebaseIds.has(sourceId))) throw new Error(`${profile.id} architecture intent ${intent.id} requires at least one pinned codebase source`);
        if (!profile.architectureDiagram.requiresPinnedCodebaseSource && intent.source_ids.length < profile.architectureDiagram.minSources) throw new Error(`architecture intent ${intent.id} requires at least ${profile.architectureDiagram.minSources} supporting scholarly source IDs`);
      }
      if (intent.kind === "taxonomy_recall" && !config.research.taxonomy.includes(intent.taxonomy_cell!)) throw new Error(`artifact intent ${intent.id} names taxonomy cell not configured in longwrite.yaml`);
      if (intent.kind === "empirical_pilot" && config.research.paper_kind !== "empirical") throw new Error("empirical_pilot is allowed only when research.paper_kind is empirical");
    }
  } catch (error) {
    const detail = error instanceof Error ? error.message.split("\n")[0] : String(error);
    await fs.mkdir(path.dirname(reportPath), { recursive: true });
    await fs.writeFile(reportPath, ["# Agentic artifact-plan contract repair", "", "- Status: failed", `- Detail: ${detail}`, "- Required repair: write exactly one JSON object with bounded, source-grounded artifact intents.", ""].join("\n"), "utf-8");
    throw new Error("reviews/artifact-plan.json: invalid artifact-plan contract; see reports/artifact-plan-repair.md");
  }
  if (normalized) {
    await fs.writeFile(`${target}.pre-normalization.md`, raw, "utf-8");
    await fs.writeFile(target, `${JSON.stringify(plan, null, 2)}\n`, "utf-8");
  }
  await fs.mkdir(path.dirname(reportPath), { recursive: true });
  await fs.writeFile(reportPath, [
    "# Agentic artifact-plan contract repair", "", "- Status: pass",
    `- Selected intents: ${plan.intents.length}`,
    ...plan.intents.map((intent) => `- ${intent.id}: ${intent.kind}${intent.section_id ? ` in ${intent.section_id}` : ""}; ${intent.acceptance_criteria.map((criterion) => `${criterion.metric} >= ${criterion.target}`).join("; ")}`),
    `- Envelope normalized: ${normalized ? "yes" : "no"}`, "",
  ].join("\n"), "utf-8");
  return { normalized, reportPath: "reports/artifact-plan-repair.md" };
}

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

export type TemplateId = string;
export type ResearchAxes = {
  paperKind: "survey" | "empirical";
  evidenceProfile: "literature" | "repository";
  experimentSource: "none" | "run" | "import";
  experimentAuthoring?: "prescribed" | "agentic";
};
export type ResearchTemplateContract = {
  paperKind: "survey" | "empirical";
  experimentSource: "none" | "run" | "import";
  repository: "optional";
  experimentAuthoring?: {
    default: "prescribed" | "agentic";
    allowed: Array<"prescribed" | "agentic">;
  };
};
export type Template = {
  id: TemplateId;
  title: string;
  description: string;
  writing?: { mode: "novel" | "technical_book" | "auto_research_agentic" };
  experiment?: { flagship?: string; authoring?: "prescribed" | "agentic" };
  research?: ResearchTemplateContract;
  handoff?: "none" | "run_then_import" | "import_existing";
};

function validateResearchContract(template: Template): void {
  const contract = template.research;
  if (!contract) return;
  if (!template.writing) throw new Error(`Template ${template.id}: research contract requires a writing component`);
  if (contract.paperKind === "survey" && contract.experimentSource !== "none") throw new Error(`Template ${template.id}: survey papers cannot run or import experiments`);
  if (contract.paperKind === "empirical" && contract.experimentSource === "none") throw new Error(`Template ${template.id}: empirical papers require run or import evidence`);
  if (contract.experimentSource === "run" && !template.experiment) throw new Error(`Template ${template.id}: run source requires LongExperiment`);
  if (contract.experimentSource !== "run" && template.experiment) throw new Error(`Template ${template.id}: only run source may create LongExperiment`);
  if (contract.experimentSource === "run" && !contract.experimentAuthoring) throw new Error(`Template ${template.id}: run source requires experiment authoring options`);
  if (contract.experimentSource !== "run" && contract.experimentAuthoring) throw new Error(`Template ${template.id}: experiment authoring applies only to run source`);
  if (contract.experimentAuthoring && !contract.experimentAuthoring.allowed.includes(contract.experimentAuthoring.default)) {
    throw new Error(`Template ${template.id}: default experiment authoring must be allowed`);
  }
  const handoff = template.handoff ?? "none";
  const expected = contract.experimentSource === "run" ? "run_then_import" : contract.experimentSource === "import" ? "import_existing" : "none";
  if (handoff !== expected) throw new Error(`Template ${template.id}: handoff ${handoff} conflicts with experiment source ${contract.experimentSource}`);
}

export function resolveResearchAxes(template: Template, options: { hasRepository: boolean; experimentAuthoring?: "prescribed" | "agentic" }): ResearchAxes | undefined {
  const contract = template.research;
  if (!contract) {
    if (options.experimentAuthoring) throw new Error("--experiment-authoring is only valid for paper.empirical");
    return undefined;
  }
  if (contract.experimentSource !== "run" && options.experimentAuthoring) {
    throw new Error("--experiment-authoring is only valid for paper.empirical");
  }
  const authoring = contract.experimentAuthoring
    ? options.experimentAuthoring ?? contract.experimentAuthoring.default
    : undefined;
  if (authoring && !contract.experimentAuthoring!.allowed.includes(authoring)) {
    throw new Error(`Template ${template.id} does not allow experiment authoring mode ${authoring}`);
  }
  return {
    paperKind: contract.paperKind,
    evidenceProfile: options.hasRepository ? "repository" : "literature",
    experimentSource: contract.experimentSource,
    ...(authoring ? { experimentAuthoring: authoring } : {}),
  };
}

export function templateAcceptsAxes(template: Template, axes: ResearchAxes | undefined): boolean {
  const contract = template.research;
  if (!contract) return axes === undefined;
  if (!axes || axes.paperKind !== contract.paperKind || axes.experimentSource !== contract.experimentSource) return false;
  if (!(["literature", "repository"] as const).includes(axes.evidenceProfile)) return false;
  if (!contract.experimentAuthoring) return axes.experimentAuthoring === undefined;
  return axes.experimentAuthoring !== undefined && contract.experimentAuthoring.allowed.includes(axes.experimentAuthoring);
}

export function templateModeSummary(template: Template): string {
  const contract = template.research;
  if (!contract) return "non-paper";
  const authoring = contract.experimentAuthoring ? contract.experimentAuthoring.allowed.join("|") : "-";
  return `${contract.paperKind}/literature|repository/${contract.experimentSource}/${authoring}`;
}

const monorepoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const catalogPath = path.join(monorepoRoot, "apps", "maliang", "templates", "catalog.yaml");

function loadCatalog(): readonly Template[] {
  const parsed = parse(fs.readFileSync(catalogPath, "utf8")) as { version?: unknown; templates?: unknown };
  if (parsed.version !== 1 || !Array.isArray(parsed.templates)) throw new Error(`Invalid MrMaLiang template catalog: ${catalogPath}`);
  const seen = new Set<string>();
  return parsed.templates.map((value) => {
    const template = value as Template;
    if (!template?.id || !template.title || !template.description || seen.has(template.id)) throw new Error(`Invalid or duplicate MrMaLiang template in ${catalogPath}`);
    validateResearchContract(template);
    seen.add(template.id);
    return Object.freeze(template);
  });
}

export const TEMPLATES = Object.freeze(loadCatalog());

export function templateById(id: string): Template {
  const template = TEMPLATES.find((item) => item.id === id);
  if (!template) throw new Error(`Unknown template ${id}. Run: maliang template list`);
  return template;
}

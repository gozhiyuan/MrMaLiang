import fs from "node:fs/promises";
import path from "node:path";
import { parse, stringify } from "yaml";
import { templateAcceptsAxes, templateById, type ResearchAxes, type TemplateId } from "./templates.js";

export type MaliangProject = {
  version: 1;
  project: { id: string; name?: string; template: TemplateId };
  research?: ResearchAxes;
  components: { writing?: { workspace: string }; experiment?: { workspace: string } };
  handoff: { mode: "none" | "run_then_import" | "import_existing"; state: "not_required" | "awaiting_experiment" | "awaiting_import" | "prepared"; manifest_path?: string };
};

export function projectIdFromDir(target: string): string {
  const id = path.basename(path.resolve(target)).toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
  return id || "maliang-project";
}

export async function readMaliangProject(workspace: string): Promise<MaliangProject> {
  const source = await fs.readFile(path.join(workspace, "maliang.yaml"), "utf8");
  const value = parse(source) as MaliangProject;
  if (value?.version !== 1 || !value.project?.template || !value.components || !value.handoff) throw new Error("Invalid maliang.yaml");
  if (value.research) {
    const { paperKind, evidenceProfile, experimentSource, experimentAuthoring } = value.research;
    if (!["survey", "empirical"].includes(paperKind) || !["literature", "repository"].includes(evidenceProfile) || !["none", "run", "import"].includes(experimentSource)) throw new Error("Invalid maliang.yaml: invalid research axes");
    if (paperKind === "survey" && experimentSource !== "none") throw new Error("Invalid maliang.yaml: survey papers require experimentSource=none");
    if (paperKind === "empirical" && experimentSource === "none") throw new Error("Invalid maliang.yaml: empirical papers require run or import evidence");
    if (experimentSource === "run" && !["prescribed", "agentic"].includes(experimentAuthoring ?? "")) throw new Error("Invalid maliang.yaml: run source requires experimentAuthoring");
    if (experimentSource !== "run" && experimentAuthoring) throw new Error("Invalid maliang.yaml: experimentAuthoring applies only to run source");
  }
  if (value.components.writing && value.components.writing.workspace !== "writing") {
    throw new Error("Invalid maliang.yaml: writing components must live in writing/");
  }
  if (value.components.experiment && value.components.experiment.workspace !== "experiment") {
    throw new Error("Invalid maliang.yaml: experiment components must live in experiment/");
  }
  const template = templateById(value.project.template);
  if (Boolean(template.writing) !== Boolean(value.components.writing) || Boolean(template.experiment) !== Boolean(value.components.experiment)) {
    throw new Error(`Invalid maliang.yaml: components do not match template ${template.id}`);
  }
  if (!templateAcceptsAxes(template, value.research)) {
    throw new Error(`Invalid maliang.yaml: research axes do not match template ${template.id}`);
  }
  if (value.handoff.mode !== (template.handoff ?? "none")) {
    throw new Error(`Invalid maliang.yaml: handoff mode does not match template ${template.id}`);
  }
  return value;
}

export async function writeMaliangProject(workspace: string, project: MaliangProject): Promise<void> {
  await fs.writeFile(path.join(workspace, "maliang.yaml"), stringify(project), "utf8");
}

export async function assertNewWorkspace(workspace: string): Promise<void> {
  await fs.mkdir(workspace, { recursive: true });
  const entries = await fs.readdir(workspace);
  if (entries.length > 0) throw new Error(`Refusing to initialize non-empty workspace: ${workspace}`);
}

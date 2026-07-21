import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { templateById, type TemplateId } from "./templates.js";

const monorepoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const blueprintsRoot = path.join(monorepoRoot, "examples", "flagships");

export type FlagshipBlueprint = {
  version: 1;
  id: string;
  template: TemplateId;
  topic?: string;
  hypothesis?: string;
  repositories?: string[];
  reference_links?: string[];
  experiment_authoring?: "prescribed" | "agentic";
  experiment_template?: string;
  init_args?: string[];
};

export function readFlagshipBlueprint(id: string): FlagshipBlueprint {
  if (!/^[a-z0-9-]+$/.test(id)) throw new Error(`Invalid flagship blueprint id: ${id}`);
  const blueprintPath = path.join(blueprintsRoot, id, "blueprint.yaml");
  let source: string;
  try {
    source = fs.readFileSync(blueprintPath, "utf8");
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(`Unknown release-ready flagship blueprint: ${id}. Run: maliang template list or inspect examples/flagships`);
    }
    throw error;
  }
  const parsed = parse(source) as FlagshipBlueprint;
  if (parsed?.version !== 1 || parsed.id !== id || typeof parsed.template !== "string") {
    throw new Error(`Invalid flagship blueprint: ${id}`);
  }
  templateById(parsed.template);
  if (parsed.topic !== undefined && typeof parsed.topic !== "string") throw new Error(`Invalid flagship blueprint topic: ${id}`);
  if (parsed.hypothesis !== undefined && typeof parsed.hypothesis !== "string") throw new Error(`Invalid flagship blueprint hypothesis: ${id}`);
  if (parsed.repositories !== undefined && (!Array.isArray(parsed.repositories) || !parsed.repositories.every((value) => typeof value === "string"))) throw new Error(`Invalid flagship blueprint repositories: ${id}`);
  if (parsed.reference_links !== undefined && (!Array.isArray(parsed.reference_links) || !parsed.reference_links.every((value) => typeof value === "string"))) throw new Error(`Invalid flagship blueprint reference_links: ${id}`);
  if (parsed.experiment_authoring !== undefined && !["prescribed", "agentic"].includes(parsed.experiment_authoring)) throw new Error(`Invalid flagship blueprint experiment_authoring: ${id}`);
  if (parsed.experiment_template !== undefined && typeof parsed.experiment_template !== "string") throw new Error(`Invalid flagship blueprint experiment_template: ${id}`);
  if (parsed.init_args !== undefined && (!Array.isArray(parsed.init_args) || !parsed.init_args.every((arg) => typeof arg === "string"))) {
    throw new Error(`Invalid flagship blueprint init_args: ${id}`);
  }
  return parsed;
}

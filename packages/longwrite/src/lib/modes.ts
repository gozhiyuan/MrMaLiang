import fs from "node:fs/promises";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import { LongWriteModeDef } from "./mode-schema.js";
import { modesDir } from "./paths.js";

export async function listModeIds(): Promise<string[]> {
  const entries = await fs.readdir(modesDir());
  const modeFiles = entries
    .filter((entry) => entry.endsWith(".yaml"))
    .sort();
  const modes = await Promise.all(modeFiles.map(async (entry) => {
    const raw = await fs.readFile(path.join(modesDir(), entry), "utf-8");
    return LongWriteModeDef.parse(parseYaml(raw));
  }));
  return modes.filter((mode) => !mode.internal).map((mode) => mode.id).sort();
}

export async function loadMode(modeId: string, seen: string[] = []): Promise<LongWriteModeDef> {
  if (seen.includes(modeId)) {
    throw new Error(`Mode inheritance cycle: ${[...seen, modeId].join(" -> ")}`);
  }
  const filePath = path.join(modesDir(), `${modeId}.yaml`);
  let raw: string;
  try {
    raw = await fs.readFile(filePath, "utf-8");
  } catch {
    throw new Error(`Mode "${modeId}" not found. Available: ${(await listModeIds()).join(", ")}`);
  }
  const mode = LongWriteModeDef.parse(parseYaml(raw));
  if (mode.extends) {
    // Inherit the parent's workflow (and artifacts, unless overridden) so a
    // derived mode can reuse one shared pipeline.
    const parent = await loadMode(mode.extends, [...seen, modeId]);
    mode.workflow = mode.workflow ?? parent.workflow;
    if (mode.artifacts.required.length === 0 && mode.artifacts.optional.length === 0) {
      mode.artifacts = parent.artifacts;
    }
  }
  if (!mode.workflow) {
    throw new Error(`Mode "${modeId}" has no workflow and no resolvable extends target.`);
  }
  return mode;
}

export async function loadAllModes(): Promise<LongWriteModeDef[]> {
  return Promise.all((await listModeIds()).map((id) => loadMode(id)));
}

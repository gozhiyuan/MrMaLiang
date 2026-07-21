import { stringify as stringifyYaml } from "yaml";
import { loadAllModes, loadMode } from "../lib/modes.js";

export async function runModeList(): Promise<void> {
  const modes = await loadAllModes();
  for (const mode of modes) {
    console.log(`${mode.id}\t${mode.name}\t${mode.artifact_type}`);
  }
}

export async function runModeShow(modeId: string): Promise<void> {
  const mode = await loadMode(modeId);
  console.log(stringifyYaml(mode));
}

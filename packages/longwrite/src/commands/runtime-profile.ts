import { stringify as stringifyYaml } from "yaml";
import { loadAllRuntimeProfiles, loadRuntimeProfile } from "../lib/runtime-profiles.js";

export async function runRuntimeProfileList(): Promise<void> {
  const profiles = await loadAllRuntimeProfiles();
  console.log("\nRuntime profiles:\n");
  console.log("  Default (default)");
  console.log("    Use the selected mode's built-in runtime defaults.\n");
  for (const profile of profiles) {
    console.log(`  ${profile.name} (${profile.id})`);
    console.log(`    ${profile.description ?? ""}`);
    console.log(`    agent runtime: ${profile.agent_runtime ?? "mode default"}`);
  }
}

export async function runRuntimeProfileShow(id: string): Promise<void> {
  if (id === "default") {
    console.log("id: default\nname: Default\ndescription: Use the selected mode's built-in runtime defaults.");
    return;
  }
  const profile = await loadRuntimeProfile(id);
  console.log(stringifyYaml(profile));
}

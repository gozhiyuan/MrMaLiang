import fs from "node:fs/promises";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { runtimeProfilesDir } from "./paths.js";

const RuntimeProfileDef = z
  .object({
    id: z.string().regex(/^[a-z0-9][a-z0-9_-]*$/),
    version: z.number().default(1),
    name: z.string(),
    description: z.string().optional(),
    agent_runtime: z.enum(["openclaw", "claude-code", "codex", "clawteam"]).optional(),
    workflow: z
      .object({
        runtime_policy: z.record(z.unknown()).optional(),
        model_tiers: z.record(z.record(z.unknown())).optional(),
        stage_model_tiers: z.record(z.string()).default({}),
        step_model_tiers: z.record(z.string()).default({}),
      })
      .strict()
      .default({}),
  })
  .strict();

export type RuntimeProfileDef = z.infer<typeof RuntimeProfileDef>;

export async function listRuntimeProfileIds(): Promise<string[]> {
  const entries = await fs.readdir(runtimeProfilesDir());
  return entries
    .filter((entry) => entry.endsWith(".yaml"))
    .map((entry) => entry.replace(/\.yaml$/, ""))
    .sort();
}

export async function loadRuntimeProfile(profileId: string): Promise<RuntimeProfileDef> {
  const filePath = path.join(runtimeProfilesDir(), `${profileId}.yaml`);
  let raw: string;
  try {
    raw = await fs.readFile(filePath, "utf-8");
  } catch {
    throw new Error(`Runtime profile "${profileId}" not found. Available: ${(await listRuntimeProfileIds()).join(", ")}`);
  }
  return RuntimeProfileDef.parse(parseYaml(raw));
}

export async function loadRuntimeProfileIfSelected(profileId?: string): Promise<RuntimeProfileDef | undefined> {
  if (!profileId || profileId === "default") return undefined;
  return loadRuntimeProfile(profileId);
}

export async function loadAllRuntimeProfiles(): Promise<RuntimeProfileDef[]> {
  return Promise.all((await listRuntimeProfileIds()).map(loadRuntimeProfile));
}

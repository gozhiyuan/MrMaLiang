import fs from "node:fs/promises";
import path from "node:path";
import type { ReproductionClaim as ReproductionClaimType } from "@mr-maliang/research-protocol";
export async function auditClaimArtifacts(root: string, claim: ReproductionClaimType): Promise<{ available: string[]; missing: string[] }> {
  const results = await Promise.all(claim.required_artifacts.map(async (artifact) => {
    try { await fs.access(path.resolve(root, artifact)); return [artifact, true] as const; } catch { return [artifact, false] as const; }
  }));
  return { available: results.filter(([, ok]) => ok).map(([item]) => item), missing: results.filter(([, ok]) => !ok).map(([item]) => item) };
}

import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

export type EvaluatorIntegrityResult = { ok: boolean; findings: string[]; digests: Record<string, string> };

function safeRelative(value: string): boolean { return value.length > 0 && !path.isAbsolute(value) && !value.split(/[\\/]/).includes(".."); }
async function digest(file: string): Promise<string> { return crypto.createHash("sha256").update(await fs.readFile(file)).digest("hex"); }

/** Verify candidate execution cannot silently modify a protected evaluator.
 * This is a content check at the worktree boundary, not a sandbox substitute. */
export async function verifyEvaluatorIntegrity(baselineDir: string, candidateDir: string, protectedPaths: readonly string[]): Promise<EvaluatorIntegrityResult> {
  const findings: string[] = [];
  const digests: Record<string, string> = {};
  for (const rel of protectedPaths) {
    if (!safeRelative(rel)) { findings.push(`unsafe protected evaluator path: ${rel}`); continue; }
    const baseline = path.join(baselineDir, rel);
    const candidate = path.join(candidateDir, rel);
    try {
      const [before, after] = await Promise.all([digest(baseline), digest(candidate)]);
      digests[rel] = before;
      if (before !== after) findings.push(`protected evaluator changed: ${rel}`);
    } catch (error) {
      findings.push(`protected evaluator unavailable: ${rel} (${error instanceof Error ? error.message : String(error)})`);
    }
  }
  return { ok: findings.length === 0, findings, digests };
}

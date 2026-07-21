import path from "node:path";
import { writeWordMetrics } from "../lib/ops/word-metrics.js";

export async function runMetricsWords(workspaceDir: string): Promise<void> {
  const resolved = path.resolve(workspaceDir);
  const metrics = await writeWordMetrics(resolved);
  console.log(`# Word Metrics`);
  console.log(`Workspace: ${resolved}`);
  console.log(`Total words: ${metrics.totalWords}`);
  if (metrics.targetWords) {
    console.log(`Target words: ${metrics.targetWords}`);
    console.log(`Progress: ${Math.round((metrics.percentOfTarget ?? 0) * 100)}%`);
  }
  console.log(`Status: ${metrics.status}`);
  console.log(`Wrote reports/word-metrics.json and reports/word-metrics.md`);
}

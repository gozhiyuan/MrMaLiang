import { readReviewAgenda } from "../lib/ops/review.js";
import { scoreWorkspace, routeWorkspace } from "../lib/ops/scorecard.js";

export async function runReviewAgenda(workspaceDir: string): Promise<void> {
  console.log(await readReviewAgenda(workspaceDir));
}

export async function runReviewScore(workspaceDir: string): Promise<void> {
  const result = await scoreWorkspace(workspaceDir);
  console.log(`# Review score — round ${result.round}\n`);
  console.log(`Official review_score: ${result.reviewScore} (raw median ${result.rawMedian})`);
  for (const cap of result.capsApplied) console.log(`  cap applied: ${cap}`);
  console.log("\nPersona overalls:");
  for (const [id, score] of Object.entries(result.personaOverall)) {
    console.log(`  ${id}: ${score}`);
  }
  console.log("\nDimension medians:");
  for (const [dim, score] of Object.entries(result.dimensionMedians)) {
    console.log(`  ${dim}: ${score}`);
  }
  console.log(`\nWrote ${result.metricsPath}`);
}

export async function runReviewRoute(workspaceDir: string): Promise<void> {
  const { routed, routingPath, remediationPath, actions } = await routeWorkspace(workspaceDir);
  if (routed.length === 0) {
    console.log("No weaknesses reported by any reviewer persona.");
  }
  for (const w of routed) {
    console.log(`[${w.severity}] ${w.category} (${w.personaId}) → ${w.targets.map((t) => t.stage).join(", ")}`);
  }
  for (const action of actions) {
    console.log(`[${action.priority}] ${action.id} → ${action.stage} (${action.weaknesses.length} finding(s))`);
  }
  console.log(`\nWrote ${routingPath}`);
  console.log(`Wrote ${remediationPath}`);
}

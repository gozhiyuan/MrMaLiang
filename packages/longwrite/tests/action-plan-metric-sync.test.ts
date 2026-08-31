import { describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import url from "node:url";
import { ACCEPTANCE_METRICS } from "../src/lib/ops/action-plan.js";

/**
 * Final whole-branch review (2026-08-29 scholarly-quality-v3-core), Critical
 * finding #1: the `action_plan` planner's instruction text in
 * `composition.ts` teaches the model metric names that the
 * `AcceptanceCriterion.metric` zod enum (action-plan.ts) does not accept.
 * The planner stage itself is not exercised by any golden fixture (it lives
 * inside `quality_loop`, which `withProductionAutoResearchV2` currently
 * splices out of the compiled manifest for the only research mode that has
 * it — see final-review-fix-report.md), so this cross-reference has to be
 * verified directly against the instruction source text rather than a
 * compiled stage. This test fails whenever a new metric name is added to the
 * planner's prose without a matching enum member (or vice versa drifts the
 * two apart), so the mismatch this finding describes can never regress
 * silently again.
 */

const here = path.dirname(url.fileURLToPath(import.meta.url));
const compositionPath = path.join(here, "..", "src", "workflow", "composition.ts");

/** Pull the literal metric names out of the `action_plan` planner's schema
 * sentence: "...Every action needs at least one measurable criterion. Use
 * cited_sources, ..., diagram_connectivity, or review_score. Map weak
 * comparative synthesis..." Parenthetical scope annotations like
 * "citation_depth_per_section (scope=A|B|C or a named section)" are stripped
 * before splitting so they don't get mistaken for extra metric names. */
function parsePlannerMetricList(source: string): string[] {
  const anchorStart = "Every action needs at least one measurable criterion. Use ";
  const anchorEnd = ". Map weak comparative synthesis";
  const startIndex = source.indexOf(anchorStart);
  const endIndex = source.indexOf(anchorEnd);
  if (startIndex < 0 || endIndex < 0 || endIndex < startIndex) {
    throw new Error("could not locate the action_plan planner's metric-list sentence in composition.ts; the instruction text moved or was reworded — update the anchors in this test");
  }
  const listText = source.slice(startIndex + anchorStart.length, endIndex);
  const withoutParens = listText.replace(/\([^)]*\)/g, "");
  return withoutParens
    .split(",")
    .map((token) => token.replace(/^\s*(?:or\s+)?/, "").trim().replace(/\.$/, ""))
    .filter((token) => token.length > 0);
}

describe("action_plan planner instruction vs. AcceptanceCriterion.metric enum", () => {
  it("every metric name the planner prose offers is accepted by the schema", async () => {
    const source = await fs.readFile(compositionPath, "utf-8");
    const promptMetrics = parsePlannerMetricList(source);
    // Sanity check on the parser itself: the sentence really does list more
    // than a couple of names, and includes the four names this finding was
    // about, so a parsing regression can't silently produce a trivial pass.
    expect(promptMetrics.length).toBeGreaterThan(10);
    expect(promptMetrics).toEqual(expect.arrayContaining([
      "landmark_coverage_ratio", "claim_contradictions", "prose_redundancy", "diagram_connectivity",
    ]));
    const schemaMetrics = new Set<string>(ACCEPTANCE_METRICS);
    const unknown = promptMetrics.filter((metric) => !schemaMetrics.has(metric));
    expect(unknown).toEqual([]);
  });
});

import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { materializeAction } from "../src/lib/ops/action-instance.js";
import { buildDiagnosisPacket, ATTEMPTS_PATH } from "../src/lib/ops/diagnosis-packet.js";
import { runRecordOutcome } from "../src/commands/dispatch.js";

/** One kernel judgment, in the shape the outcome channel delivers it. */
async function outcomeFile(
  ws: string, actionId: string, attemptRef: string, contract: string,
): Promise<string> {
  const record = path.join(ws, `outcome-${attemptRef}.json`);
  await fs.writeFile(record, JSON.stringify({
    version: 1, unit_key: `improve.x[${actionId}]`, objective: "kernel objective",
    action_id: actionId, attempt_ref: attemptRef, invocation_id: attemptRef,
    execution_outcome: "completed", contract_outcome: contract, at: new Date().toISOString(),
  }), "utf-8");
  return record;
}

/** The domain half of the corrective cycle.
 *
 * The kernel decides WHEN to diagnose and carries the decision forward; this
 * package decides what a decision MEANS. Three things have to be true for the
 * loop to close, and each of them was false while its own unit test passed:
 * the attempt ledger has to record how an attempt was judged rather than only
 * that it was dispatched, a directive has to change what the next
 * materialization compiles, and a directive that changes nothing must not be
 * reported as applied. */

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((r) => fs.rm(r, { recursive: true, force: true })));
});

async function workspace(): Promise<string> {
  const ws = await fs.mkdtemp(path.join(os.tmpdir(), "longwrite-directive-"));
  roots.push(ws);
  await fs.mkdir(path.join(ws, "chapters"), { recursive: true });
  await fs.mkdir(path.join(ws, "sources"), { recursive: true });
  await fs.writeFile(path.join(ws, "chapters", "section-03.md"), "Alpha.\n\nBeta.\n", "utf-8");
  await fs.writeFile(path.join(ws, "sources", "classified_sources.jsonl"), "{}\n", "utf-8");
  return ws;
}

/** A corpus-side defect. Two capabilities own `sources/**`, so "repairing the
 * record did not help; go acquire better sources" is a real escalation rather
 * than a routing change no envelope could support. */
const corpusFinding = {
  id: "source-7-dead-url", gate_id: "citation_url_liveness",
  artifact: { kind: "source_record" as const, path: "sources/classified_sources.jsonl", artifact_id: "source-7" },
  objective_scope_key: "",
  required_effect: "repair_source_metadata" as const,
  acceptance_metric: null,
  severity: "major" as const,
  diagnostic: "The recorded URL for source-7 no longer resolves.",
};
const corpusObservations = new Map([
  ["cited_sources ", 18], ["landmark_coverage_ratio ", 0.8], ["accepted_cited_ratio ", 0.9],
  ["citation_verification_status ", 0],
]);
const CORPUS_OBJECTIVE = "gate:citation_url_liveness";

const finding = {
  id: "section-3-unsupported", gate_id: "figure_references",
  artifact: { kind: "chapter_prose" as const, path: "chapters/section-03.md", artifact_id: "figure-1" },
  objective_scope_key: "",
  required_effect: "add_explicit_artifact_reference" as const,
  acceptance_metric: null,
  severity: "major" as const,
  diagnostic: "Figure 1 is not named before its placement.",
};
const observations = new Map([
  ["claim_support ", 0.94], ["citation_verification_status ", 1], ["cited_sources ", 18],
]);

/** The objective in the form both sides of the protocol use: a gate, because
 * no registered metric tracks this defect. */
const OBJECTIVE = "gate:figure_references";

describe("a diagnosis directive changes what the next attempt is", () => {
  it("records the attempt as dispatched, and resolves it from the kernel's judgment", async () => {
    const ws = await workspace();
    const instance = await materializeAction(ws, {
      actionId: "a1", findings: [finding], observations,
    }) as { attempt_ref: string };

    const dispatched = (await fs.readFile(path.join(ws, ATTEMPTS_PATH), "utf-8"))
      .split("\n").filter(Boolean).map((line) => JSON.parse(line));
    expect(dispatched).toHaveLength(1);
    // Not "unmet" and not the PREVIOUS attempt's outcome: at materialization
    // nobody knows yet how this one turns out, and saying otherwise is how a
    // diagnosis came to read a history in which nothing had failed.
    expect(dispatched[0].outcome).toBe("dispatched");

    // The kernel reports its judgment through the outcome channel.
    const record = path.join(ws, "outcome.json");
    await fs.writeFile(record, JSON.stringify({
      version: 1, unit_key: "improve.revise_sections[a1]", objective: OBJECTIVE,
      action_id: "a1", attempt_ref: instance.attempt_ref, invocation_id: "inv-1",
      execution_outcome: "completed", contract_outcome: "unmet", at: new Date().toISOString(),
    }), "utf-8");
    await runRecordOutcome(ws, { record });

    // Appended, not rewritten: the ledger is a journal several processes append
    // to. The packet is what collapses it.
    const packet = await buildDiagnosisPacket(ws, OBJECTIVE);
    expect(packet.prior_attempts).toHaveLength(1);
    expect(packet.prior_attempts[0]!.outcome).toBe("unmet");
    expect(packet.prior_attempts[0]!.capability).toBe("revise_sections");
  });

  it("keeps a run that never completed out of the strategy history", async () => {
    const ws = await workspace();
    const instance = await materializeAction(ws, {
      actionId: "a1", findings: [finding], observations,
    }) as { attempt_ref: string };
    const record = path.join(ws, "outcome.json");
    await fs.writeFile(record, JSON.stringify({
      version: 1, unit_key: "u", objective: OBJECTIVE, action_id: "a1",
      attempt_ref: instance.attempt_ref, invocation_id: "inv-1",
      execution_outcome: "timeout", contract_outcome: "not_applicable", at: new Date().toISOString(),
    }), "utf-8");
    await runRecordOutcome(ws, { record });
    const packet = await buildDiagnosisPacket(ws, OBJECTIVE);
    // A strategy that timed out was not tried and rejected; recording it as
    // `not_applicable` would tell the diagnosing unit the approach had been
    // evaluated when the run never got that far.
    expect(packet.prior_attempts[0]!.outcome).toBe("timeout");
  });

  it("escalates to the capability the directive names, and says so", async () => {
    const ws = await workspace();
    const instance = await materializeAction(ws, {
      actionId: "a2", findings: [corpusFinding], observations: corpusObservations,
      directives: [{
        id: "lineage-1", objective: CORPUS_OBJECTIVE, decision: "escalate_capability",
        next_capability: "targeted_research_expansion",
      }],
    }) as { from_template: string; applied_directive?: string; owns: string[] };

    // The registry routes this finding to repair_source_metadata. The directive
    // is the only reason it went anywhere else.
    expect(instance.from_template).toBe("targeted_research_expansion");
    // Echoed back as the kernel's own id, which is what the kernel checks.
    expect(instance.applied_directive).toBe("lineage-1");
    // And the escalated capability's OWN envelope governs, not the one the
    // registry would have used: an escalation that kept the previous
    // capability's authority would let a diagnosis widen a grant.
    expect(instance.owns).toContain("reports/research-expansion.md");
  });

  it("refuses an escalation to a capability that cannot own the artifact", async () => {
    const ws = await workspace();
    // Diagnosis chooses a STRATEGY, and a capability whose envelope cannot
    // reach the artifact is not one. Refused here, where the capability and the
    // artifact can both be named, rather than several steps later as a generic
    // envelope violation in the kernel.
    await expect(materializeAction(ws, {
      actionId: "a2", findings: [finding], observations,
      directives: [{
        objective: OBJECTIVE, decision: "escalate_capability",
        next_capability: "reopen_outline",
      }],
    })).rejects.toThrow(/cannot own chapters\/section-03\.md/);
  });

  it("compiles the substituted effect into the packet and the ledger", async () => {
    const ws = await workspace();
    await fs.mkdir(path.join(ws, "figures"), { recursive: true });
    await fs.writeFile(path.join(ws, "figures", "placement-plan.json"), "{}\n", "utf-8");
    // The same gate routes two effects for this artifact kind, which is what
    // makes "try the other one" a strategy rather than a wish.
    const visual = {
      ...finding,
      artifact: { kind: "figure_spec" as const, path: "figures/placement-plan.json", artifact_id: "fig-1" },
      required_effect: "repair_artifact_content" as const,
      acceptance_metric: "figures" as const,
    };
    await materializeAction(ws, {
      actionId: "a3", findings: [visual],
      observations: new Map([["figures ", 3], ["tables ", 1], ["diagram_connectivity ", 1]]),
      targets: new Map([["figures ", { operator: "at_least", target: 1 }]]),
      directives: [{
        objective: OBJECTIVE, decision: "retry_with_different_effect",
        next_effect: "repair_artifact_placement",
      }],
    });
    const ledger = (await fs.readFile(path.join(ws, ATTEMPTS_PATH), "utf-8"))
      .split("\n").filter(Boolean).map((line) => JSON.parse(line));
    // The substitution has to be total. An effect that reached the packet but
    // not the ledger would let the same strategy be chosen again next round,
    // because the history would still show the effect that was abandoned.
    expect(ledger[0].effect).toBe("repair_artifact_placement");
    const packet = JSON.parse(await fs.readFile(path.join(ws, "repair", "a3", "packet.json"), "utf-8"));
    expect(packet.findings[0].required_effect).toBe("repair_artifact_placement");
  });

  it("does not claim a directive that changed nothing", async () => {
    const ws = await workspace();
    const instance = await materializeAction(ws, {
      actionId: "a4", findings: [finding], observations,
      directives: [{
        objective: OBJECTIVE, decision: "escalate_capability",
        // The capability the registry already routes to.
        next_capability: "revise_sections",
      }],
    }) as { applied_directive?: string };
    // Consuming it would let one diagnosis be discharged by a repeat of the
    // very attempt it rejected.
    expect(instance.applied_directive).toBeUndefined();
  });

  it("keeps two strategies against one plan item as two attempts", async () => {
    const ws = await workspace();
    // A length defect: the gate routes two effects for chapter prose, which is
    // what gives diagnosis a second strategy to name at all.
    const marker = {
      ...finding, gate_id: "target_length",
      required_effect: "remove_redundant_prose" as const,
      acceptance_metric: null,
    };
    const a = await materializeAction(ws, {
      actionId: "a1", findings: [marker],
      observations: new Map([...observations, ["citation_verification_status ", 0]]),
    }) as { attempt_ref: string };
    await runRecordOutcome(ws, { record: await outcomeFile(ws, "a1", a.attempt_ref, "unmet") });
    // The SAME plan item, escalated by diagnosis. Keyed on the action id these
    // two collapse to one row and the next diagnosis is told the first strategy
    // was never tried — which is the history it exists to reason over.
    const b = await materializeAction(ws, {
      actionId: "a1", findings: [marker],
      observations: new Map([...observations, ["citation_verification_status ", 0]]),
      directives: [{
        objective: "gate:target_length", decision: "retry_with_different_effect",
        next_effect: "expand_argument",
      }],
    }) as { attempt_ref: string };
    await runRecordOutcome(ws, { record: await outcomeFile(ws, "a1", b.attempt_ref, "unmet") });

    expect(a.attempt_ref).not.toBe(b.attempt_ref);
    const packet = await buildDiagnosisPacket(ws, "gate:target_length");
    expect(packet.prior_attempts.map((row) => row.effect))
      .toEqual(["remove_redundant_prose", "expand_argument"]);
    expect(packet.prior_attempts.every((row) => row.outcome === "unmet")).toBe(true);
  });

  it("applies the directive the kernel bound to this dispatch item", async () => {
    const ws = await workspace();
    // The kernel binds a directive to the plan item that failed and hands over
    // only what belongs to this dispatch; matching here on an objective string
    // a model was asked to repeat is what a formatting drift silently broke.
    const instance = await materializeAction(ws, {
      actionId: "a5", findings: [corpusFinding], observations: corpusObservations,
      directives: [{
        id: "lineage-9", objective: "whatever the diagnosing model wrote",
        decision: "escalate_capability", next_capability: "targeted_research_expansion",
      }],
    }) as { from_template: string; applied_directive?: string };
    expect(instance.from_template).toBe("targeted_research_expansion");
    expect(instance.applied_directive).toBe("lineage-9");
  });
});

import { afterAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** A synchronous child blocks this worker's event loop, so vitest's own
 * timeout cannot interrupt it. Without a timeout of its own, a child that
 * never exits hangs the entire run instead of failing one test. */
const SUBPROCESS_TIMEOUT_MS = 300_000;

/** The corrective cycle across BOTH repositories, driven only by their CLIs.
 *
 * The MalaClaw-side canary proves the kernel's half with scripted stand-ins for
 * the domain. This one removes the stand-ins: the workspace is created by
 * `longwrite init`, the run is driven by `malaclaw flow run`, and every domain
 * decision is made by the real LongWrite commands — `materialize-action`
 * compiles the packet and the contract from the real registries,
 * `diagnose-objective` assembles the real diagnosis packet,
 * `answer-verifications` answers what the kernel issued, and `record-outcome`
 * resolves the real attempt ledger. Nothing edits `.malaclaw/flow/state.json`;
 * the resume is an ordinary `malaclaw flow run`, and the operator decision is
 * an ordinary `malaclaw flow approve`.
 *
 * The one thing simulated is the WORKER, which is a script rather than a model:
 * a repair is judged on the bytes it produces, and a zero-spend test cannot buy
 * a model to produce them. The script reads the packet the real materializer
 * compiled and repairs only under the effect diagnosis chose — which is what
 * makes "strategy A failed and strategy B worked" a real distinction here
 * rather than a hard-coded outcome.
 *
 * A budget-approval gate sits between B's materialization and B's execution,
 * deliberately: a diagnosis directive retired at materialization is already
 * gone by the time that approval arrives, and the resumed round then
 * re-materializes the strategy the diagnosis rejected. */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const longwriteCli = path.join(repoRoot, "dist", "cli.js");
const malaclawRoot = process.env.MALACLAW_SOURCE_DIR
  ? path.resolve(process.env.MALACLAW_SOURCE_DIR)
  : path.resolve(repoRoot, "..", "..", ".dependencies", "MalaClaw");
const tmp = path.join(os.tmpdir(), `lw-cross-repo-${Date.now()}`);

afterAll(async () => {
  if (!process.env.KEEP_WS) await fs.rm(tmp, { recursive: true, force: true });
});

function nodeAtLeast22(): boolean {
  return Number(process.versions.node.split(".")[0]) >= 22;
}

const LIVE_URL = "https://example.org/live/seed-1";

/** The repair. It reads the packet the REAL materializer compiled and acts on
 * the capability it was dispatched as — so which strategy is in force is
 * decided by the domain layer and the diagnosis, never by this script. */
const WORKER = `
const fs = require("fs");
const path = require("path");
// The RENDERED packet, which is what the kernel actually put in this worker's
// isolated workspace and named in its prompt. The JSON beside it is not a
// declared read of this instance, and a worker reaching for it would be reading
// something nobody granted it.
const packet = fs.readFileSync(path.join("repair", "repair-1", "packet.md"), "utf-8");
const rel = "sources/classified_sources.jsonl";
const record = JSON.parse(fs.readFileSync(rel, "utf-8").trim());
if (packet.includes("(targeted_research_expansion)")) {
  // Acquiring a source that actually resolves is what the objective asks for.
  record.url = ${JSON.stringify("https://example.org/live/seed-1")};
  fs.mkdirSync("reports", { recursive: true });
  fs.writeFileSync("reports/research-expansion.md", "# Expansion\\n\\nAcquired a live replacement.\\n");
} else {
  // Tidying the metadata leaves the dead URL exactly as dead as it was.
  record.title = String(record.title || "") + " (metadata repaired)";
}
fs.writeFileSync(rel, JSON.stringify(record) + "\\n");
// The exact verifier consumes the citation-verification producer artifact,
// rather than the old marker-only acceptance metric.  Keep that artifact in
// sync with the record this repair actually changed.
fs.writeFileSync("sources/citation-verification.jsonl", JSON.stringify({
  version: 1, source_id: record.id, url: record.url,
  status: record.url.includes("/live/") ? "live" : "dead",
  checked_at: new Date().toISOString(),
}) + "\\n");
`;

/** The measurement. These are registered metrics, so the envelope is the one
 * the kernel already knows how to ingest — target and operator included, which
 * is what lets the real materializer compile a contract instead of refusing for
 * want of a target, and what the capability templates protect as invariants. */
const MEASURE = `
const fs = require("fs");
const body = fs.readFileSync("sources/classified_sources.jsonl", "utf-8");
const live = body.includes(${JSON.stringify("https://example.org/live/seed-1")}) ? 1 : 0;
const digest = (s) => require("crypto").createHash("sha256").update(s).digest("hex");
const of = (metric, value, extra) => Object.assign({
  metric, scope_key: "", status: "measured", value,
  evaluator: metric, evaluator_digest: digest("evaluator"),
  input_digest: digest(body), measurement_kind: "script",
}, extra || {});
fs.mkdirSync("reports", { recursive: true });
fs.writeFileSync("reports/measurements.json", JSON.stringify({
  version: 1,
  measurements: [
    of("citation_verification_status", live,
       { operator: "at_least", target: 1, tolerance: 0, direction: "maximize" }),
    of("cited_sources", 3),
    of("claim_support", 1),
    of("landmark_coverage_ratio", 0.9),
    of("accepted_cited_ratio", 0.9),
  ],
}, null, 2));
`;

/** Stands in for the diagnosing model, and only for it.
 *
 * It reads the packet the REAL `diagnose-objective` command assembled — the
 * whole history of the objective, with every strategy already attempted — and
 * names one that has not been tried. A model would make this judgment; the
 * evidence it makes it on is genuine either way, and choosing from the packet
 * rather than from a constant is what makes this a decision. */
const DIAGNOSE = `
const fs = require("fs");
const packet = JSON.parse(fs.readFileSync("repair/diagnosis-packet.json", "utf-8"));
if (packet.prior_attempts.length === 0) {
  throw new Error("nothing has been attempted; there is nothing to diagnose");
}
const attempted = new Set(packet.prior_attempts.map((a) => a.capability));
const next = ["repair_source_metadata", "targeted_research_expansion"].find((c) => !attempted.has(c));
if (!next) throw new Error("every routed strategy has been tried: " + [...attempted].join(", "));
fs.mkdirSync("reviews", { recursive: true });
fs.writeFileSync("reviews/diagnosis.json", JSON.stringify({
  version: 1,
  objective: packet.objective,
  decision: "escalate_capability",
  next_capability: next,
  detail: "already attempted " + [...attempted].join(", ") + " without meeting the objective",
}, null, 2));
`;

/** The finding the run repairs, in the shape the domain's own producers emit.
 *
 * Written as a validation report rather than injected into the dispatch: the
 * materializer resolves finding IDS from the reports its producers write, which
 * is the split the whole protocol is built around — the kernel passes an id and
 * knows nothing about what it means. */
function validationReport(): unknown {
  return {
    version: 1,
    pass: false,
    checks: [{
      id: "citation_url_liveness",
      pass: false,
      findings: [{
        id: "source-1-dead-url",
        gate_id: "citation_url_liveness",
        artifact: { kind: "source_record", path: "sources/classified_sources.jsonl", artifact_id: "seed-1" },
        objective_scope_key: "",
        required_effect: "repair_source_metadata",
        // Metadata liveness is repaired by the exact source-record verifier;
        // it must not borrow the marker-only aggregate metric.
        acceptance_metric: null,
        severity: "major",
        diagnostic: "The recorded URL for seed-1 no longer resolves.",
      }],
    }],
  };
}

function manifest(node: string, ws: string): unknown {
  const lw = (args: string[]) => ({ cmd: node, args: [longwriteCli, ...args] });
  return {
    version: 1,
    project: {
      id: "cross-repo-canary", name: "Cross-repository corrective canary",
      // Owners are validated against the project's agent roster, and this
      // manifest declares its own stages rather than inheriting a team.
      attached_agents: ["pm", "writer", "analyst"],
    },
    workflow: {
      ir_version: 2,
      // Every one of these is a REAL LongWrite command.
      verifiers: ["citation_url_liveness"],
      verifier_command: lw(["research", "answer-verifications", "."]),
      outcome_command: lw(["research", "record-outcome", "."]),
      model_tiers: {
        // The escalated strategy costs money, and an operator authorizes it.
        // That pause is where a prematurely-consumed directive disappears.
        high: { runtime: "script", requires_budget_approval: true },
      },
      tool_catalog: [
        {
          // Strategy A: the registry's own routing for this triple.
          id: "repair_source_metadata",
          owner: "analyst", kind: "mutation", runtime: "script",
          reads: ["sources/**", "reports/**", "longwrite.yaml"],
          // The registry template's own envelope, including the report this
          // capability leaves behind on every dispatch: a catalog entry
          // narrower than the template is one the materializer's instance
          // cannot fit inside.
          owns: ["sources/classified_sources.jsonl", "sources/**",
                 "reports/source-identities.md", "reports/source-metadata-repair.md",
                 "reports/source-verification.md"],
          writes: ["sources/classified_sources.jsonl"],
          outputs: ["sources/classified_sources.jsonl"],
          evaluate_with: ["measure_round_metrics"],
          corrective_capability: "repair_source_metadata",
          on_diagnose: "diagnose_objective",
          command: { cmd: node, args: [path.join(ws, "bin", "worker.js")] },
        },
        {
          // Strategy B: a different capability that owns the same artifact, so
          // an escalation to it is a real strategy rather than a routing change
          // no envelope could support. It costs money, and an operator says so.
          id: "targeted_research_expansion",
          owner: "analyst", kind: "mutation", runtime: "script", model_tier: "high",
          reads: ["sources/**", "reports/**", "longwrite.yaml"],
          owns: ["sources/**", "evidence/**", "fulltext/**", "research/**",
                 "reports/research-expansion.md"],
          writes: ["sources/classified_sources.jsonl", "reports/research-expansion.md"],
          outputs: ["reports/research-expansion.md"],
          evaluate_with: ["measure_round_metrics"],
          corrective_capability: "targeted_research_expansion",
          on_diagnose: "diagnose_objective",
          command: { cmd: node, args: [path.join(ws, "bin", "worker.js")] },
        },
      ],
      stages: [
        {
          type: "action_dispatch",
          id: "improve",
          owner: "pm",
          plan_path: "reviews/action-plan.json",
          materializer: lw(["research", "materialize-action", "."]),
          on_diagnose: "diagnose_objective",
        },
        {
          id: "measure_round_metrics",
          owner: "analyst",
          kind: "measurement",
          runtime: "script",
          reads: ["sources/**"],
          writes_observations: ["citation_verification_status", "claim_support", "cited_sources",
                                "landmark_coverage_ratio", "accepted_cited_ratio"],
          outputs: ["reports/measurements.json"],
          command: { cmd: node, args: ["-e", MEASURE] },
        },
        {
          // The REAL packet builder. Its input is the real attempt ledger the
          // real outcome command resolved.
          id: "build_diagnosis_packet",
          owner: "analyst",
          runtime: "script",
          reads: ["repair/**", "reviews/**", "reports/**", ".malaclaw/observations/**"],
          outputs: ["repair/diagnosis-packet.json"],
          command: lw(["review", "diagnose-objective", "."]),
          enabled: false,
          skippable: true,
          disabled_reason: "runs with the diagnosis stage the kernel reaches through its diagnose transition",
        },
        {
          id: "diagnose_objective",
          owner: "analyst",
          runtime: "script",
          reads: ["repair/**"],
          owns: ["reviews/diagnosis.json"],
          writes: ["reviews/diagnosis.json"],
          inputs: ["repair/diagnosis-packet.json"],
          outputs: ["reviews/diagnosis.json"],
          diagnosis_output: "reviews/diagnosis.json",
          validator_commands: [lw(["review", "validate-diagnosis", "."])],
          command: { cmd: node, args: [path.join(ws, "bin", "diagnose.js")] },
          enabled: false,
          skippable: true,
          disabled_reason: "reached only through the kernel's diagnose transition",
        },
        {
          id: "release",
          owner: "pm",
          runtime: "script",
          inputs: ["sources/classified_sources.jsonl"],
          reads: ["sources/classified_sources.jsonl"],
          owns: ["dist/**"],
          writes: ["dist/release.md"],
          outputs: ["dist/release.md"],
          command: { cmd: node, args: ["-e",
            `const fs=require('fs');fs.mkdirSync('dist',{recursive:true});` +
            `fs.writeFileSync('dist/release.md', fs.readFileSync('sources/classified_sources.jsonl','utf-8'))`] },
        },
      ],
    },
  };
}

describe.skipIf(!nodeAtLeast22())("the corrective cycle across both repositories", () => {
  it("fails A, diagnoses with the real packet, approves B, and releases what B produced", async () => {
    const ws = path.join(tmp, "canary");
    const node = process.execPath;
    const longwrite = (args: string[]) =>
      execFileSync(node, [longwriteCli, ...args], { cwd: repoRoot, stdio: "pipe", timeout: SUBPROCESS_TIMEOUT_MS, killSignal: "SIGKILL" });
    const malaclaw = (args: string[]) =>
      execFileSync(node, [path.join(malaclawRoot, "dist", "cli.js"), ...args], { cwd: ws, stdio: "pipe", timeout: SUBPROCESS_TIMEOUT_MS, killSignal: "SIGKILL" });
    const read = async (rel: string) => fs.readFile(path.join(ws, rel), "utf-8");
    const readJson = async (rel: string) => JSON.parse(await read(rel));
    const events = async (): Promise<Array<Record<string, unknown>>> =>
      (await read(".malaclaw/flow/events.jsonl").catch(() => ""))
        .split("\n").filter((line) => line.trim()).map((line) => JSON.parse(line));

    // 1. A real workspace, created by the real initializer.
    longwrite(["init", ws, "--mode", "auto_research_agentic",
               "--topic", "cross-repository corrective canary", "--research-provider", "seed"]);

    // The exact URL-liveness verifier is a release gate only when this policy
    // is enabled.  The canary deliberately makes it the objective rather than
    // borrowing the aggregate citation metric the registry forbids here.
    const configPath = path.join(ws, "longwrite.yaml");
    const config = await fs.readFile(configPath, "utf-8");
    await fs.writeFile(configPath, config.replace("require_live_urls: false", "require_live_urls: true"), "utf-8");

    await fs.mkdir(path.join(ws, "bin"), { recursive: true });
    await fs.mkdir(path.join(ws, "sources"), { recursive: true });
    await fs.mkdir(path.join(ws, "reports"), { recursive: true });
    await fs.mkdir(path.join(ws, "reviews"), { recursive: true });
    await fs.writeFile(path.join(ws, "bin", "worker.js"), WORKER, "utf-8");
    await fs.writeFile(path.join(ws, "bin", "diagnose.js"), DIAGNOSE, "utf-8");
    await fs.writeFile(path.join(ws, "sources", "classified_sources.jsonl"),
      `${JSON.stringify({
        id: "seed-1", title: "A seed source", authors: ["Ada Lovelace"], year: 2025,
        venue: "Journal", url: "https://example.org/dead/seed-1", abstract: "A seed abstract.",
        source: "openalex", topics: ["canary"], identifiers: { doi: "10.1000/seed-1" },
        quality_score: 0.9, score_rationale: "fixture", citation_depth: "A",
        citation_depth_rationale: "fixture",
      })}\n`,
      "utf-8");
    await fs.writeFile(path.join(ws, "sources", "citation-verification.jsonl"),
      `${JSON.stringify({ version: 1, source_id: "seed-1", url: "https://example.org/dead/seed-1", status: "dead", checked_at: new Date().toISOString() })}\n`,
      "utf-8");
    // The producer output the domain resolves findings from.
    await fs.writeFile(path.join(ws, "reports", "longwrite-validation.json"),
      `${JSON.stringify(validationReport(), null, 2)}\n`, "utf-8");
    // The plan the kernel reads: an id, a severity, a summary, and a tool.
    await fs.writeFile(path.join(ws, "reviews", "action-plan.json"), JSON.stringify({
      version: 1,
      findings: [{ id: "source-1-dead-url", severity: "major",
                   summary: "A cited source URL no longer resolves." }],
      // The plan names strategy A, and never changes. If anything other than
      // the diagnosis were steering this, B would never run.
      actions: [{ id: "repair-1", tool: "repair_source_metadata",
                  finding_ids: ["source-1-dead-url"],
                  rationale: "Repair the recorded source metadata." }],
    }, null, 2), "utf-8");
    await fs.writeFile(path.join(ws, "malaclaw.yaml"),
      `${JSON.stringify(manifest(node, ws), null, 2)}\n`, "utf-8");

    // ---- Round one: strategy A, chosen by the registry -------------------
    try { malaclaw(["flow", "run", "--runtime", "script"]); } catch { /* the pause is expected */ }

    const afterA = await readJson(".malaclaw/flow/state.json");
    const attemptA = afterA.units["improve.repair_source_metadata[repair-1]"];
    expect(attemptA?.contractOutcome, "strategy A should not have met the objective").toBe("unmet");
    // The real materializer compiled a real packet and put it in front of the
    // worker; the real ledger recorded how the kernel judged it.
    expect(await read("repair/repair-1/packet.md")).toContain("Acceptance:");
    const ledgerA = (await read("repair/attempts.jsonl")).split("\n").filter(Boolean).map((l) => JSON.parse(l));
    expect(ledgerA.at(-1)).toMatchObject({ capability: "repair_source_metadata", outcome: "unmet" });

    // The real diagnosis packet was assembled from that ledger, and the
    // decision named the strategy that had NOT been tried.
    const packet = await readJson("repair/diagnosis-packet.json");
    expect(packet.prior_attempts.map((a: { capability: string }) => a.capability))
      .toEqual(["repair_source_metadata"]);
    const decision = await readJson("reviews/diagnosis.json");
    expect(decision).toMatchObject({
      decision: "escalate_capability", next_capability: "targeted_research_expansion",
    });
    expect(afterA.diagnoses?.[0]).toMatchObject({ status: "available" });
    expect(await read("dist/release.md").catch(() => null),
      "the release ran on an unmet objective").toBeNull();

    // ---- Resume: an ordinary run, no state edited ------------------------
    try { malaclaw(["flow", "run", "--runtime", "script"]); } catch { /* the approval pause */ }

    const atGate = await readJson(".malaclaw/flow/state.json");
    const approval = atGate.pendingApprovals?.[0];
    expect(approval, "B should have paused for budget approval before running").toBeTruthy();
    // Materialized against the directive, and NOT yet retired: the operator has
    // not decided, so the replacement has not run.
    expect(atGate.diagnoses[0].status).toBe("claimed");
    const instanceB = await readJson("repair/repair-1/instance.json");
    expect(instanceB.applied_directive, "the directive never reached materialization").toBeTruthy();
    expect(instanceB.attempt_ref).not.toBe(
      ledgerA.at(-1)!.attempt_ref);

    // ---- The operator authorizes the spend, and B runs --------------------
    malaclaw(["flow", "approve", approval.id]);
    malaclaw(["flow", "run", "--runtime", "script"]);

    const done = await readJson(".malaclaw/flow/state.json");
    const attemptB = done.units["improve.targeted_research_expansion[repair-1]"];
    expect(attemptB.contractOutcome, "strategy B should have met the objective").toBe("accepted");
    expect(done.diagnoses[0].status, "the directive outlived the pause and was retired on a judgment")
      .toBe("resolved");

    // Two strategies in the history, not one row overwritten by the other.
    const ledgerB = (await read("repair/attempts.jsonl")).split("\n").filter(Boolean).map((l) => JSON.parse(l));
    const refs = new Set(ledgerB.map((row: { attempt_ref?: string }) => row.attempt_ref));
    expect(refs.size).toBe(2);

    // And only now the release, on the bytes B produced.
    expect(await read("dist/release.md")).toContain(LIVE_URL);
    expect((await events()).map((event) => event.type))
      .toEqual(expect.arrayContaining(["diagnosis_directive_recorded", "diagnosis_directive_claimed",
                                       "diagnosis_directive_applied", "diagnosis_directive_resolved"]));
  }, 900_000);
});

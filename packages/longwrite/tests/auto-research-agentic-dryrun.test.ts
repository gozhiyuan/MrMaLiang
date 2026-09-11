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

// A zero-spend end-to-end check for the agentic control plane. Its action-plan
// fixture selects a real catalog action, so this covers planner validation,
// the allowlisted dispatcher, and ordinary release gates together.
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const longwrite = path.join(repoRoot, "dist", "cli.js");
const malaclawRoot = process.env.MALACLAW_SOURCE_DIR
  ? path.resolve(process.env.MALACLAW_SOURCE_DIR)
  : path.resolve(repoRoot, "..", "..", ".dependencies", "MalaClaw");
const tmp = path.join(os.tmpdir(), `lw-agentic-dry-${Date.now()}`);

function nodeAtLeast22(): boolean {
  return Number(process.versions.node.split(".")[0]) >= 22;
}

afterAll(async () => { if (!process.env.KEEP_WS) await fs.rm(tmp, { recursive: true, force: true }); });

describe.skipIf(!nodeAtLeast22())("auto_research_agentic dry-run", () => {
  it("executes a validated allowlisted action and completes", async () => {
    const ws = path.join(tmp, "agentic");
    const node = process.execPath;
    const run = (args: string[]) => execFileSync(node, [longwrite, ...args], { cwd: repoRoot, stdio: "pipe", timeout: SUBPROCESS_TIMEOUT_MS, killSignal: "SIGKILL" });
    const malaclaw = (args: string[]) =>
      execFileSync(node, [path.join(malaclawRoot, "dist", "cli.js"), ...args], { cwd: ws, stdio: "pipe", timeout: SUBPROCESS_TIMEOUT_MS, killSignal: "SIGKILL" });
    const statePath = path.join(ws, ".malaclaw", "flow", "state.json");

    run(["init", ws, "--mode", "auto_research_agentic", "--topic", "agentic dry-run plumbing", "--research-provider", "seed"]);
    // A rehearsal has to be able to REACH its objectives. The seeded corpus is
    // six sources and the paper profile's release gates ask for eighty, so the
    // reachability verdict correctly refuses to spend improvement rounds on
    // something that cannot succeed — which is the control working, and which
    // would leave this test rehearsing nothing past it. Gates the rehearsal can
    // actually meet are configuration, and configuration is what a dry run is
    // allowed to choose.
    const configPath = path.join(ws, "longwrite.yaml");
    await fs.writeFile(configPath,
      (await fs.readFile(configPath, "utf-8"))
        .replace(/min_cited_sources: \d+/, "min_cited_sources: 0")
        .replace(/min_citations_per_page: \d+/, "min_citations_per_page: 0")
        .replace(/min_cited_within_one_year_ratio: [\d.]+/, "min_cited_within_one_year_ratio: 0")
        .replace(/min_accepted_cited_ratio: [\d.]+/, "min_accepted_cited_ratio: 0")
        .replace(/min_cited_ab_sources_per_taxonomy_cell: \d+/, "min_cited_ab_sources_per_taxonomy_cell: 0")
        .replace(/(min_citation_depths_per_section:\n(?:\s+[ABC]: )\d+\n(?:\s+[ABC]: )\d+\n(?:\s+[ABC]: ))\d+/,
                 (_m, head: string) => `${head}0`)
        .replace(/^(\s+)([ABC]): \d+$/gm, "$1$2: 0"),
      "utf-8");

    const manifestPath = path.join(ws, "malaclaw.yaml");
    const manifest = (await fs.readFile(manifestPath, "utf-8"))
      .replace(/cmd: \S*node\S*/g, `cmd: ${node}`)
      // A simulated worker cannot author a valid adjudication decision. Keep
      // this zero-spend control-plane canary on the unresolved branch; the
      // real adjudication contract has its own schema/integration coverage.
      .replace(/when: ['"]?review_score_disagreement >= 1['"]?/g,
        "when: review_score_disagreement >= 99");
    expect(manifest).toContain("when: review_score_disagreement >= 99");
    await fs.writeFile(manifestPath, manifest, "utf-8");

    for (let i = 0; i < 24; i++) {
      let startupError: unknown;
      // `--simulate` downgrades stage-pinned model runtimes too; selecting a
      // dry-run default alone intentionally leaves an explicit `runtime: codex`
      // stage intact and would turn this zero-spend canary into a paid call.
      try { malaclaw(["flow", "run", "--simulate"]); } catch (error) { startupError = error; /* approval pauses are expected */ }
      const stateRaw = await fs.readFile(statePath, "utf-8").catch(() => null);
      if (!stateRaw) {
        const stderr = startupError && typeof startupError === "object" && "stderr" in startupError
          ? String((startupError as { stderr?: Buffer | string }).stderr ?? "")
          : String(startupError ?? "unknown error");
        throw new Error(`MalaClaw failed before initializing flow state:\n${stderr}`);
      }
      const state = JSON.parse(stateRaw);
      if (state.status === "completed" || state.status === "failed") break;
      if (state.status === "paused_for_approval") { try { malaclaw(["flow", "review", "--batch"]); } catch { /* no-op */ } }
    }

    const state = JSON.parse(await fs.readFile(statePath, "utf-8"));
    const units = state.units as Record<string, { status?: string; lastError?: string; contractOutcome?: string }>;

    // A dispatched repair now carries a contract compiled from the findings it
    // answers, and a simulated worker cannot satisfy one: it writes placeholder
    // prose. So this run is not judged on whether the objective was MET — it is
    // judged on whether every mechanism between the finding and the verdict
    // actually ran. A unit that fails for a plumbing reason fails this test; a
    // unit whose contract came back unmet is the dry run working.
    const plumbing = [
      "materializing", "verification could not be issued", "already attempted under a different invocation",
      "measurement envelope rejected", "undeclared_write", "required input is missing",
      "no verifier is registered", "wrote no output",
    ];
    const broken = Object.entries(units)
      .filter(([, unit]) => plumbing.some((needle) => (unit.lastError ?? "").includes(needle)))
      .map(([key, unit]) => `${key}: ${unit.lastError}`);
    expect(broken, `plumbing failures:\n${broken.join("\n")}`).toEqual([]);

    // Every unit that failed did so on its CONTRACT, which is a verdict, not a
    // defect — or it is a dispatcher or loop reporting a child's verdict
    // upward. Anything else is an execution failure this run should not have.
    const contractOutcomes = new Set([
      "unmet", "regressed", "repeated_strategy", "strategy_exhausted", "improved",
      "partially_improved_with_regression", "unreachable",
    ]);
    // A dispatcher or loop has no contract of its own: it fails because the
    // work it scheduled did. Only those two may fail without a verdict.
    const orchestrator = (key: string) => key.endsWith("_dispatch") || key === "improve";
    const unexplained = Object.entries(units)
      .filter(([key, unit]) => unit.status === "failed"
        && !contractOutcomes.has(unit.contractOutcome ?? "")
        && !orchestrator(key))
      .map(([key, unit]) => `${key}: ${unit.contractOutcome ?? "no contract outcome"} — ${unit.lastError ?? ""}`);
    expect(unexplained, `failed for a non-contract reason:\n${unexplained.join("\n")}`).toEqual([]);

    // The dispatch protocol ran end to end: a structured finding set became an
    // instance, the instance ran in isolation, its verification was issued AND
    // answered, and the unmet objective reached diagnosis.
    const events = (await fs.readFile(path.join(ws, ".malaclaw", "flow", "events.jsonl"), "utf-8"))
      .split("\n").filter((line) => line.trim() !== "").map((line) => JSON.parse(line) as { type: string });
    const seen = new Set(events.map((event) => event.type));
    for (const type of ["action_materialized", "unit_needs_diagnosis"]) {
      expect(seen.has(type), `expected a ${type} event; saw ${[...seen].join(", ")}`).toBe(true);
    }
    // Objective isolation can split one planner suggestion into several
    // independently verifiable repair instances.  The stable prefix is the
    // selected capability/finding lineage; a numeric suffix is deliberately
    // not part of the public dispatch contract.
    const repairRoot = path.join(ws, "repair");
    const instanceDir = (await fs.readdir(repairRoot)).find((entry) =>
      entry.startsWith("required-final-release-revise-sections"));
    expect(instanceDir, "the selected revise_sections action was not materialized").toBeDefined();
    const instance = JSON.parse(await fs.readFile(
      path.join(repairRoot, instanceDir!, "instance.json"), "utf-8"));
    expect(instance.acceptance.length, "a materialized instance must carry a contract").toBeGreaterThan(0);
    expect(instance.owns).toContain("reviews/revision-report.md");

    // A verification result exists for the request THIS run issued: the answer
    // is bound to the request, not carried over from an earlier workspace.
    const verificationDir = path.join(ws, ".malaclaw", "observations", "verifications");
    const gates = await fs.readdir(verificationDir);
    expect(gates.length, "no verification was answered").toBeGreaterThan(0);

    // Diagnosis is executable and durable, not a name recorded in state.
    expect(units["build_diagnosis_packet"]?.status).toBe("succeeded");
    expect(units["diagnose_objective"]?.status).toBe("succeeded");
    const diagnosis = JSON.parse(await fs.readFile(path.join(ws, "reviews", "diagnosis.json"), "utf-8"));
    expect(diagnosis.decision).toBeTruthy();
    // And the kernel CONSUMED it. A decision the next materialization never
    // sees is a high-tier model call spent on a file nothing reads, which is
    // what this stage looked like from the outside for its whole first life.
    // And the kernel CONSUMED it. The dry-run fixture decides that no automated
    // strategy remains, so consumption is visible as the operator block the
    // kernel raised and the pause it produced — not as a directive. A decision
    // the kernel never reads would leave the run resuming straight back into
    // the repair the diagnosis had just rejected.
    expect(diagnosis.decision).toBe("operator_required");
    expect(seen.has("diagnosis_operator_required"),
      `the diagnosis decision was never consumed; saw ${[...seen].join(", ")}`).toBe(true);
    const blocks = (state as { blocks?: Array<{ outcome: string; unit_key: string }> }).blocks ?? [];
    expect(blocks.some((block) => block.outcome === "operator_required")).toBe(true);
    // And the gate it left behind is one an ordinary resume cannot walk past.
    const gated = Object.values(units as Record<string, { correctiveGate?: { requires: string } }>)
      .filter((unit) => unit.correctiveGate !== undefined);
    expect(gated.some((unit) => unit.correctiveGate!.requires === "different_strategy")).toBe(true);

    // The attempt ledger records how the attempt was JUDGED, not merely that it
    // was dispatched — which is the difference between a history a diagnosis
    // can reason about and one in which nothing has ever failed.
    const ledger = (await fs.readFile(path.join(ws, "repair", "attempts.jsonl"), "utf-8"))
      .split("\n").filter((line) => line.trim() !== "").map((line) => JSON.parse(line) as { outcome: string });
    expect(ledger.some((row) => row.outcome !== "dispatched"),
      `no attempt was ever resolved; outcomes were ${ledger.map((r) => r.outcome).join(", ")}`).toBe(true);

    // Everything before the improve loop still has to actually work.
    for (const key of ["outline", "measure_round_metrics", "acquire_review_score", "acquire_claim_support"]) {
      expect(units[key]?.status, `${key} did not succeed`).toBe("succeeded");
    }
    expect(await fs.readFile(path.join(ws, "reports", "action-dispatch.json"), "utf-8")).toContain("revise_sections");
  }, 1_800_000);
});

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { intakePaperSource } from "../src/lib/reproduction/paper-source.js";
import { reconcileClaims } from "../src/lib/reproduction/claims.js";
import { auditClaimArtifacts } from "../src/lib/reproduction/artifact-audit.js";
import { verifyReproductionVerdict } from "../src/lib/reproduction/verify.js";
import { reproductionLogbook } from "../src/lib/reproduction/logbook.js";
import { claimExtractionStages } from "../src/workflow/claim-extraction.js";
const dirs: string[] = []; afterEach(async () => { await Promise.all(dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true }))); });
const claim = { id: "claim-1", statement: "The reported method improves heldout accuracy by five points.", anchor: { section: "Results", quote: "The reported method improves heldout accuracy by five points." }, claim_type: "quantitative", metric: "accuracy", reported_value: 0.05, tolerance: 0.01, required_artifacts: ["code/run.py"], feasibility: "exact", feasibility_reason: "code and data are public" };
describe("paper reproduction contracts", () => {
  it("intakes sources, rejects injected claims, audits artifacts, verifies verdicts, and exports a logbook", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "reproduction-")); dirs.push(root); const pdf = path.join(root, "paper.pdf"); await fs.writeFile(pdf, "pdf bytes"); await fs.mkdir(path.join(root, "code")); await fs.writeFile(path.join(root, "code/run.py"), "run");
    const source = await intakePaperSource(pdf, "Fixture paper"); expect(source.kind).toBe("local_pdf"); expect(source.checksum).toMatch(/^sha256:/);
    expect(reconcileClaims(claim.anchor.quote, [claim])).toHaveLength(1);
    expect(() => reconcileClaims(claim.anchor.quote, [{ ...claim, id: "injected", anchor: { quote: "a claim from another paper" } }])).toThrow(/absent/);
    expect(await auditClaimArtifacts(root, claim as any)).toEqual({ available: ["code/run.py"], missing: [] });
    const verdict = verifyReproductionVerdict(claim, { claim_id: "claim-1", verdict: "exact_reproduction", trial_ids: ["t1"], evidence_artifacts: ["results.json"], rationale: "The heldout result matched within the declared tolerance." });
    expect(reproductionLogbook(source, [verdict])).toContain("exact_reproduction");
  });
  it("keeps claim extraction ahead of deterministic reconciliation", () => {
    const stages = claimExtractionStages((args) => ({ cmd: "longexperiment", args }));
    expect(stages.map((stage) => stage.id)).toEqual(["extract_claims", "reconcile_claims"]);
    expect(stages[1].outputs).toEqual(["reproduction/claims.json"]);
  });
});

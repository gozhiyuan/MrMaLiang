import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ActionInstance, materializeAction } from "../src/lib/ops/action-instance.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((r) => fs.rm(r, { recursive: true, force: true })));
});

async function workspace(): Promise<string> {
  const ws = await fs.mkdtemp(path.join(os.tmpdir(), "longwrite-instance-"));
  roots.push(ws);
  await fs.mkdir(path.join(ws, "chapters"), { recursive: true });
  await fs.writeFile(path.join(ws, "chapters", "section-03.md"), "Alpha.\n\nBeta.\n", "utf-8");
  await fs.writeFile(path.join(ws, "chapters", "section-06.md"), "Gamma.\n\nDelta.\n", "utf-8");
  return ws;
}

const finding = {
  id: "figure-1-missing-reference", gate_id: "figure_references",
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

describe("action instances", () => {
  it("resolves the template from the finding's triple", async () => {
    const instance = await materializeAction(await workspace(), {
      actionId: "a1", findings: [finding], observations,
    });
    expect((instance as { from_template: string }).from_template).toBe("revise_sections");
  });

  it("narrows owns to the artifacts its findings name", async () => {
    const instance = await materializeAction(await workspace(), {
      actionId: "a1", findings: [finding], observations,
    }) as { owns: string[] };
    // The template's envelope is the maximum; the instance's is the minimum
    // this dispatch needs — but that minimum includes the artifacts the
    // capability writes on EVERY dispatch, which no finding will ever name.
    // Narrowing past them makes the worker's own report an undeclared write.
    expect(instance.owns).toContain("chapters/section-03.md");
    expect(instance.owns).toContain("reviews/revision-report.md");
    expect(instance.owns).not.toContain("chapters/**");
  });

  it("carries acceptance derived from the finding's gate", async () => {
    const instance = await materializeAction(await workspace(), {
      actionId: "a1", findings: [finding], observations,
    }) as { acceptance: Array<{ kind: string; verification_id?: string }> };
    expect(instance.acceptance.length).toBeGreaterThan(0);
    expect(instance.acceptance[0].verification_id).toBe("figure_references");
  });

  it("carries the finding's declared objective scope, never one inferred from a path", async () => {
    // A prose defect in section 6 can belong to a workspace-global rendered-PDF
    // objective; inferring scope from the path would split one objective into
    // per-section ones that each look separately unmet.
    const global = {
      ...finding, objective_scope_key: "",
      artifact: { ...finding.artifact, path: "chapters/section-06.md" },
    };
    expect((await materializeAction(await workspace(), {
      actionId: "a1", findings: [global], observations,
    }) as { scope_key: string }).scope_key).toBe("");
  });

  it("carries a section objective scope when the finding declares one", async () => {
    const scoped = {
      ...finding, gate_id: "cited_literature_release_gates",
      objective_scope_key: "section-section-06-1a2b3c4d5e",
      required_effect: "add_supporting_citation" as const,
      acceptance_metric: "cited_sources" as const,
      artifact: { ...finding.artifact, path: "chapters/section-06.md" },
    };
    const instance = await materializeAction(await workspace(), {
      actionId: "a1", findings: [scoped], observations,
      targets: new Map([["cited_sources section-section-06-1a2b3c4d5e", { operator: "at_least" as const, target: 20 }]]),
    }) as { scope_key: string };
    expect(instance.scope_key).toBe("section-section-06-1a2b3c4d5e");
  });

  it("refuses findings whose objective scopes disagree", async () => {
    const other = { ...finding, id: "f2", objective_scope_key: "section-x-0000000000" };
    await expect(materializeAction(await workspace(), {
      actionId: "a1", findings: [finding, other], observations,
    })).rejects.toThrow(/objective scope/i);
  });

  it("refuses to invent a target for a scoped metric objective", async () => {
    const scoped = {
      ...finding, gate_id: "cited_literature_release_gates",
      objective_scope_key: "section-x", acceptance_metric: "cited_sources" as const,
      required_effect: "add_supporting_citation" as const,
    };
    // A metric-wide default would judge every scope against one number.
    await expect(materializeAction(await workspace(), {
      actionId: "a1", findings: [scoped], observations,
    })).rejects.toThrow(/carries no operator\/target/);
  });

  it("compiles must_preserve from current observations with tolerance and direction", async () => {
    const instance = await materializeAction(await workspace(), {
      actionId: "a1", findings: [finding], observations,
    }) as { must_preserve: Array<{ metric: string; direction: string; tolerance: number }> };
    const protectedMetric = instance.must_preserve.find((c) => c.metric === "claim_support")!;
    expect(protectedMetric.direction).toBe("maximize");
    expect(typeof protectedMetric.tolerance).toBe("number");
  });

  it("fails when a template-protected metric has no observation", async () => {
    await expect(materializeAction(await workspace(), {
      actionId: "a1", findings: [finding], observations: new Map(),
    })).rejects.toThrow(/no current observation/);
  });

  it("declares reads covering the packet and the owned artifacts", async () => {
    const dir = await workspace();
    const instance = await materializeAction(dir, {
      actionId: "a1", findings: [finding], observations,
    }) as { reads: string[]; packet_path: string; requested_tools: string[] };
    // The RENDERED packet is what the worker is handed; the JSON beside it is
    // what a later round and a diagnosis parse. Both are written; only the
    // rendered one is named to the kernel, because only one of them is a
    // prompt.
    expect(instance.packet_path).toBe("repair/a1/packet.md");
    expect(instance.reads).toContain("repair/a1/packet.md");
    expect(instance.reads).toContain("chapters/section-03.md");
    const rendered = await fs.readFile(path.join(dir, "repair", "a1", "packet.md"), "utf-8");
    expect(rendered).toContain("Acceptance:");
    expect(JSON.parse(await fs.readFile(path.join(dir, "repair", "a1", "packet.json"), "utf-8")).action_id)
      .toBe("a1");
    // Least privilege reaches the kernel as a request, not as a comment: a
    // prose repair asks for read/edit/write and nothing that touches a network.
    expect(instance.requested_tools).toEqual(["Edit", "Read", "Write"]);
  });

  it("declares a strategy key including scope", async () => {
    const instance = await materializeAction(await workspace(), {
      actionId: "a1", findings: [finding], observations,
    }) as { strategy_key: string[] };
    expect(instance.strategy_key).toEqual(
      expect.arrayContaining(["template", "finding_ids", "scope_key", "acceptance"]));
  });

  it("declares a union return type the dispatcher can parse", async () => {
    const result = await materializeAction(await workspace(), {
      actionId: "a1", findings: [finding], observations,
    });
    // MaterializationResult, not ActionInstance: both arms must be
    // representable at the boundary, or the blocker arm fails to parse.
    expect(result.kind === "action_instance" || result.kind === "operator_required").toBe(true);
  });

  it("turns an operator target into a blocker rather than an instance", async () => {
    const result = await materializeAction(await workspace(), {
      actionId: "a1", observations,
      findings: [{ ...finding, gate_id: "latex_build",
        artifact: { kind: "toolchain" as const, target: "pdflatex" },
        required_effect: "repair_toolchain" as const,
        acceptance_metric: "latex_build_status" as const }],
    });
    expect(result.kind).toBe("operator_required");
    expect((result as { target: string }).target).toBe("pdflatex");
    expect((result as { question: string }).question.length).toBeGreaterThan(0);
  });

  it("turns an unrecoverable source replacement request into a durable operator blocker", async () => {
    const ws = await workspace();
    await fs.mkdir(path.join(ws, "sources"), { recursive: true });
    await fs.writeFile(path.join(ws, "sources", "metadata-replacement-requests.json"), JSON.stringify({
      version: 1, requests: [{ source_id: "lost-source", title: "Unrecoverable source" }],
    }), "utf-8");
    const result = await materializeAction(ws, {
      actionId: "replace-source", observations: new Map(),
      findings: [{
        id: "missing-candidate", gate_id: "total_candidates",
        artifact: { kind: "corpus", path: "sources/classified_sources.jsonl" },
        objective_scope_key: "", required_effect: "acquire_additional_evidence",
        acceptance_metric: "candidate_count", severity: "major",
        diagnostic: "A replacement source must be acquired.",
      }],
    });
    expect(result).toMatchObject({ kind: "operator_required", target: "replace_unrecoverable_source" });
  });

  it("rejects a runtime finding whose acceptance metric is not declared by its gate", async () => {
    await expect(materializeAction(await workspace(), {
      actionId: "a1", observations,
      findings: [{
        id: "dead-url", gate_id: "citation_url_liveness",
        artifact: { kind: "source_record", path: "sources/classified_sources.jsonl", artifact_id: "seed-1" },
        objective_scope_key: "", required_effect: "repair_source_metadata",
        acceptance_metric: "citation_verification_status", severity: "major",
        diagnostic: "A dead URL requires a source-record repair.",
      }],
    })).rejects.toThrow(/never declared acceptance metric citation_verification_status/);
  });

  it("produces a schema-valid instance", async () => {
    const instance = await materializeAction(await workspace(), {
      actionId: "a1", findings: [finding], observations,
    });
    expect(ActionInstance.safeParse(instance).success).toBe(true);
  });

  it("writes the repair packet alongside the instance", async () => {
    const ws = await workspace();
    await materializeAction(ws, { actionId: "a1", findings: [finding], observations });
    expect(JSON.parse(await fs.readFile(path.join(ws, "repair/a1/packet.json"), "utf-8")).capability)
      .toBe("revise_sections");
  });
});

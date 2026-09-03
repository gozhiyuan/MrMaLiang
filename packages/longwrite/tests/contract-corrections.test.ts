import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { stringify } from "yaml";
import { defineProducer } from "../src/lib/registry/producer-types.js";
import { registerProducers } from "../src/lib/registry/routing.js";
import { gateId, metricId } from "../src/lib/registry/ids.js";
import { FindingSchema, StructuredCheckSchema } from "../src/lib/registry/records.js";
import { computeInputDigest } from "../src/lib/registry/digests.js";
import { metricDefinition } from "../src/lib/registry/metrics.js";
import { evaluateCorpusGates } from "../src/lib/research/corpus-gates.js";
import { CORPUS_EVALUATORS } from "../src/lib/registry/evaluators/corpus.js";
import { REGISTRY } from "../src/lib/registry/producers.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((r) => fs.rm(r, { recursive: true, force: true })));
});
const AS_OF = "2026-09-01T00:00:00.000Z";

async function scratch(prefix: string): Promise<string> {
  const ws = await fs.mkdtemp(path.join(os.tmpdir(), `longwrite-${prefix}-`));
  roots.push(ws);
  return ws;
}

describe("finding to acceptance-objective binding", () => {
  it("requires every declared finding to name the metric it moves, or state that it moves none", () => {
    // A compound gate evaluates several metrics, so "the gate's metric" is not
    // a function. Without this, acceptance cannot be derived from a finding.
    expect(() => defineProducer({
      module: "bad", gates: [{ id: "g", class: "manuscript", findings: [
        // @ts-expect-error acceptance_metric is required, not optional
        { kind: "corpus", effect: "acquire_additional_evidence", capability: "targeted_research_expansion" },
      ] }],
    })).toThrow(/acceptance_metric/);
  });

  it("rejects an acceptance metric that is not registered", () => {
    expect(() => defineProducer({
      module: "bad", gates: [{ id: "g", class: "manuscript", findings: [
        { kind: "corpus", effect: "acquire_additional_evidence", capability: "targeted_research_expansion",
          acceptance_metric: "invented_metric" },
      ] }],
    })).toThrow(/unknown metric|not registered/i);
  });

  it("carries the acceptance metric onto each emitted finding", async () => {
    const ws = await scratch("acceptance");
    await fs.mkdir(path.join(ws, "sources"), { recursive: true });
    await fs.writeFile(path.join(ws, "longwrite.yaml"), stringify({
      version: 1, project: { id: "s", artifact_type: "research_paper", mode: "auto_research_agentic" },
      research: { provider: "multi", topic: "t", taxonomy: ["memory"],
        corpus_gates: { min_candidates: 99, min_core_sources: 99, min_sources_per_taxonomy_cell: 9 } },
    }), "utf-8");
    await fs.writeFile(path.join(ws, "sources", "classified_sources.jsonl"),
      JSON.stringify({ id: "s1", citation_depth: "C", source: "arxiv", title: "T", abstract: "a", year: 2020 }), "utf-8");
    const report = await evaluateCorpusGates(ws, { asOfDate: AS_OF });
    const core = report.checks.find((check) => String(check.id) === "core_sources")!;
    expect(core.findings[0].acceptance_metric).toBe("core_sources");
  });

  it("resolves the acceptance metric for a compound gate per finding, not per gate", () => {
    // cited_literature_release_gates moves several different metrics; each
    // finding must say which one it is about.
    const gate = gateId("cited_literature_release_gates");
    // One triple, several objectives: the corpus-quality route alone blocks
    // four different acceptance metrics.
    const corpus = REGISTRY.acceptanceMetrics(gate, "corpus", "upgrade_source_quality");
    expect(corpus.size).toBeGreaterThan(1);
    const all = new Set(REGISTRY.legalTriples(gate)
      .flatMap((triple) => [...REGISTRY.acceptanceMetrics(gate, triple.kind, triple.effect)]));
    expect(all.size).toBeGreaterThan(2);
  });
});

describe("model measurement identity", () => {
  it("changes the input digest when the prompt changes but the model does not", async () => {
    const ws = await scratch("prompt-digest");
    const definition = metricDefinition(metricId("review_score"));
    const model = { name: "opus" };
    const a = await computeInputDigest(ws, definition, { asOfDate: AS_OF, model, promptDigest: "a".repeat(64) });
    const b = await computeInputDigest(ws, definition, { asOfDate: AS_OF, model, promptDigest: "b".repeat(64) });
    expect(a).not.toBe(b);
  });

  it("refuses to identify a model measurement with no prompt digest", async () => {
    const ws = await scratch("prompt-missing");
    const definition = metricDefinition(metricId("review_score"));
    // Silently reusing a judgment taken under different instructions is the
    // failure this prevents.
    await expect(computeInputDigest(ws, definition, { asOfDate: AS_OF, model: { name: "opus" } }))
      .rejects.toThrow(/prompt/i);
  });
});

describe("binary dependency digests", () => {
  it("distinguishes two byte sequences that are identical once decoded as text", async () => {
    const ws = await scratch("binary-digest");
    await fs.mkdir(path.join(ws, "build"), { recursive: true });
    await fs.mkdir(path.join(ws, "chapters"), { recursive: true });
    await fs.mkdir(path.join(ws, "sources"), { recursive: true });
    await fs.writeFile(path.join(ws, "sources", "classified_sources.jsonl"), "", "utf-8");
    const definition = metricDefinition(metricId("citations_per_page"));
    // 0xFF and 0xFE are both invalid UTF-8 and both decode to a single U+FFFD,
    // so a digest taken over decoded text cannot tell these two PDFs apart.
    await fs.writeFile(path.join(ws, "build", "manuscript.pdf"), Buffer.from([0x25, 0x50, 0xff]));
    const first = await computeInputDigest(ws, definition, { asOfDate: AS_OF });
    await fs.writeFile(path.join(ws, "build", "manuscript.pdf"), Buffer.from([0x25, 0x50, 0xfe]));
    expect(await computeInputDigest(ws, definition, { asOfDate: AS_OF })).not.toBe(first);
  });
});

describe("rendered visual review registration", () => {
  it("depends on the artifacts the review actually inspects", () => {
    const definition = metricDefinition(metricId("rendered_visual_review"));
    expect(definition.dependencies).toContain("build/manuscript.pdf");
    expect(definition.dependencies).toContain("reports/visual-render-manifest.json");
  });

  it("names the file the reviewer actually writes", () => {
    const definition = metricDefinition(metricId("rendered_visual_review"));
    expect(definition.raw_output).toContain("reviews/visual-qa.json");
    expect(definition.raw_output).not.toContain("reports/visual-review.json");
  });
});

describe("duplicate gate declarations", () => {
  it("rejects two modules routing one triple to different capabilities", () => {
    // Accepting this silently kept the first capability, so which repair ran
    // depended on producer registration order.
    const shape = { kind: "corpus", effect: "acquire_additional_evidence", acceptance_metric: "core_sources" } as const;
    const a = defineProducer({ module: "a", gates: [{ id: "shared", class: "manuscript", findings: [
      { ...shape, capability: "targeted_research_expansion" }] }] });
    const b = defineProducer({ module: "b", gates: [{ id: "shared", class: "manuscript", findings: [
      { ...shape, capability: "request_operator_clarification" }] }] });
    expect(() => registerProducers([a, b])).toThrow(/capability|declared differently/i);
  });

  it("still accepts an identical re-declaration", () => {
    const gates = [{ id: "shared", class: "manuscript" as const, findings: [
      { kind: "corpus" as const, effect: "acquire_additional_evidence" as const,
        capability: "targeted_research_expansion", acceptance_metric: "core_sources" }] }];
    expect(() => registerProducers([
      defineProducer({ module: "a", gates }), defineProducer({ module: "b", gates }),
    ])).not.toThrow();
  });
});

describe("source type diversity", () => {
  it("reports one value for one workspace", async () => {
    const ws = await scratch("diversity");
    await fs.mkdir(path.join(ws, "sources"), { recursive: true });
    await fs.writeFile(path.join(ws, "longwrite.yaml"), stringify({
      version: 1, project: { id: "s", artifact_type: "research_paper", mode: "auto_research_agentic" },
      research: { provider: "multi", topic: "t", taxonomy: [] },
    }), "utf-8");
    // One provider, two identifier kinds: the gate counted 3, the evaluator 1.
    await fs.writeFile(path.join(ws, "sources", "classified_sources.jsonl"), [
      { id: "s1", citation_depth: "A", source: "arxiv", title: "T", abstract: "a", year: 2025, identifiers: { doi: "10.1/x" } },
      { id: "s2", citation_depth: "A", source: "arxiv", title: "U", abstract: "b", year: 2025, identifiers: { arxiv_id: "2401.1" } },
    ].map((s) => JSON.stringify(s)).join("\n"), "utf-8");
    const gate = await evaluateCorpusGates(ws, { asOfDate: AS_OF });
    const fromGate = gate.measurements.find((entry) => entry.metric === "source_type_diversity_count")!.value;
    const fromEvaluator = (await CORPUS_EVALUATORS.source_type_diversity_count({ workspaceDir: ws, asOfDate: AS_OF }))[0].value;
    expect(fromEvaluator).toBe(fromGate);
  });
});

describe("structured check integrity", () => {
  const finding = {
    id: "f1", gate_id: "core_sources",
    artifact: { kind: "corpus", path: "sources/" },
    objective_scope_key: "", required_effect: "acquire_additional_evidence",
    acceptance_metric: "core_sources", severity: "major", diagnostic: "short",
  };

  it("rejects a passing check that carries findings", () => {
    // A repair request on a satisfied gate would dispatch work nobody asked for.
    expect(StructuredCheckSchema.safeParse({
      id: "core_sources", pass: true, findings: [finding],
    }).success).toBe(false);
  });

  it("rejects a finding whose gate differs from the check that carries it", () => {
    expect(StructuredCheckSchema.safeParse({
      id: "total_candidates", pass: false, findings: [finding],
    }).success).toBe(false);
  });

  it("accepts a coherent failing check", () => {
    expect(StructuredCheckSchema.safeParse({
      id: "core_sources", pass: false, findings: [finding],
    }).success).toBe(true);
  });

  it("still requires an acceptance metric on the finding itself", () => {
    const { acceptance_metric, ...without } = finding;
    expect(FindingSchema.safeParse(without).success).toBe(false);
  });
});

describe("acceptance is per emitted finding, not per triple", () => {
  async function citedWorkspace(): Promise<string> {
    const ws = await scratch("cited-gates");
    await fs.mkdir(path.join(ws, "sources"), { recursive: true });
    await fs.mkdir(path.join(ws, "chapters"), { recursive: true });
    await fs.writeFile(path.join(ws, "longwrite.yaml"), stringify({
      version: 1, project: { id: "s", artifact_type: "research_paper", mode: "auto_research_agentic" },
      research: {
        provider: "multi", topic: "t", taxonomy: [],
        release_gates: {
          min_cited_sources: 5, min_citations_per_page: 3,
          min_cited_within_one_year_ratio: 0.9, min_accepted_cited_ratio: 0.9,
          max_cited_arxiv_only_ratio: 0.1, min_citation_depths_per_section: { A: 0, B: 0, C: 0 },
          min_cited_ab_sources_per_taxonomy_cell: 0,
        },
      },
    }), "utf-8");
    await fs.writeFile(path.join(ws, "sources", "classified_sources.jsonl"),
      JSON.stringify({ id: "s1", citation_depth: "A", source: "arxiv", title: "T", abstract: "a",
        year: 2015, venue: "arXiv", authors: ["Ada Lovelace"], identifiers: { arxiv_id: "1501.1" } }), "utf-8");
    await fs.writeFile(path.join(ws, "chapters", "section-01.md"), "[source:s1:p1]\n", "utf-8");
    return ws;
  }

  const metricsOf = async (ws: string) => {
    const { validateResearchWorkspace } = await import("../src/lib/validation/research.js");
    const report = await validateResearchWorkspace(ws, AS_OF);
    const check = report.checks.find((c) => String(c.id) === "cited_literature_release_gates")!;
    return new Map(check.findings.map((f) => [f.id, f.acceptance_metric]));
  };

  it("targets the metric each failure is actually about", async () => {
    const byId = await metricsOf(await citedWorkspace());
    const find = (fragment: string) =>
      [...byId.entries()].find(([id]) => id.includes(fragment))?.[1];
    // Each of these previously resolved to accepted_cited_ratio or
    // citation_depth_per_section, because the metric came from the triple.
    expect(find("cited-count")).toBe("cited_sources");
    expect(find("recency")).toBe("cited_within_one_year_ratio");
    expect(find("acceptance")).toBe("accepted_cited_ratio");
    expect(find("venue-mix")).toBe("cited_arxiv_only_ratio");
    expect(find("citation-density")).toBe("citations_per_page");
  });

  it("emits distinct acceptance metrics from one compound gate", async () => {
    const byId = await metricsOf(await citedWorkspace());
    expect(new Set(byId.values()).size).toBeGreaterThan(2);
  });
});

describe("registry validation of acceptance metrics", () => {
  it("rejects a finding carrying a metric its gate never declared", async () => {
    const { validateFindingAgainstRegistry } = await import("../src/lib/registry/records.js");
    const finding = FindingSchema.parse({
      id: "x", gate_id: "core_sources", artifact: { kind: "corpus", path: "sources/" },
      objective_scope_key: "", required_effect: "acquire_additional_evidence",
      acceptance_metric: "review_score", severity: "major", diagnostic: "d",
    });
    // An LLM-produced plan carrying structured findings makes this reachable.
    expect(() => validateFindingAgainstRegistry(finding, REGISTRY)).toThrow(/acceptance metric|review_score/i);
  });

  it("accepts a finding whose metric its gate did declare", async () => {
    const { validateFindingAgainstRegistry } = await import("../src/lib/registry/records.js");
    const finding = FindingSchema.parse({
      id: "x", gate_id: "core_sources", artifact: { kind: "corpus", path: "sources/" },
      objective_scope_key: "", required_effect: "acquire_additional_evidence",
      acceptance_metric: "core_sources", severity: "major", diagnostic: "d",
    });
    expect(() => validateFindingAgainstRegistry(finding, REGISTRY)).not.toThrow();
  });
});

describe("measurement kind decides which fingerprint is required", () => {
  it("requires a prompt digest for a model measurement only", async () => {
    const ws = await scratch("kind-model");
    await expect(computeInputDigest(ws, metricDefinition(metricId("review_score")), { asOfDate: AS_OF }))
      .rejects.toThrow(/prompt/i);
  });

  it("requires a toolchain digest, not a prompt, for an external measurement", async () => {
    // Instructions belong to a model. A LaTeX build is identified by the
    // toolchain and configuration it ran under.
    const ws = await scratch("kind-external");
    const definition = metricDefinition(metricId("latex_build_status"));
    await expect(computeInputDigest(ws, definition, { asOfDate: AS_OF, promptDigest: "a".repeat(64) }))
      .rejects.toThrow(/toolchain/i);
    const a = await computeInputDigest(ws, definition, { asOfDate: AS_OF, toolchainDigest: "a".repeat(64) });
    const b = await computeInputDigest(ws, definition, { asOfDate: AS_OF, toolchainDigest: "b".repeat(64) });
    expect(a).not.toBe(b);
  });
});

describe("source type diversity counts providers", () => {
  it("counts one provider as one source type however many identifiers it carries", async () => {
    const ws = await scratch("diversity-providers");
    await fs.mkdir(path.join(ws, "sources"), { recursive: true });
    await fs.writeFile(path.join(ws, "longwrite.yaml"), stringify({
      version: 1, project: { id: "s", artifact_type: "research_paper", mode: "auto_research_agentic" },
      research: { provider: "multi", topic: "t", taxonomy: [] },
    }), "utf-8");
    await fs.writeFile(path.join(ws, "sources", "classified_sources.jsonl"), [
      { id: "s1", citation_depth: "A", source: "arxiv", title: "T", abstract: "a", year: 2025,
        identifiers: { doi: "10.1/x", arxiv_id: "2401.1", openalex_id: "W1" } },
    ].map((s) => JSON.stringify(s)).join("\n"), "utf-8");
    const value = (await CORPUS_EVALUATORS.source_type_diversity_count({ workspaceDir: ws, asOfDate: AS_OF }))[0].value;
    // One retrieval provider. Identifier systems are metadata completeness,
    // which is a different property with its own gate.
    expect(value).toBe(1);
    const gate = await evaluateCorpusGates(ws, { asOfDate: AS_OF });
    expect(gate.measurements.find((entry) => entry.metric === "source_type_diversity_count")!.value).toBe(1);
  });
});

describe("visual review invalidation", () => {
  it("invalidates when a figure asset or the template changes, not only the PDF", () => {
    const definition = metricDefinition(metricId("rendered_visual_review"));
    for (const dependency of ["figures/", "paper/", "build/manuscript.pdf", "reports/visual-render-manifest.json"]) {
      expect(definition.dependencies, dependency).toContain(dependency);
    }
  });
});

describe("digest read failures", () => {
  it("fails the measurement on an unreadable dependency rather than hashing it as absent", async () => {
    const ws = await scratch("digest-eacces");
    await fs.mkdir(path.join(ws, "chapters"), { recursive: true });
    const blocked = path.join(ws, "chapters", "locked.md");
    await fs.writeFile(blocked, "text\n", "utf-8");
    await fs.chmod(blocked, 0o000);
    const definition = metricDefinition(metricId("prose_redundancy"));
    // An absent file is a fact about the workspace; an unreadable one is a
    // fact about us, and hashing it as absent would mint a trusted digest for
    // content nobody looked at.
    const run = computeInputDigest(ws, definition, { asOfDate: AS_OF });
    await run.then(
      () => { throw new Error("expected an unreadable dependency to fail the measurement"); },
      (error: Error) => expect(error.message).toMatch(/locked\.md|permission|EACCES/i),
    ).finally(() => fs.chmod(blocked, 0o644));
  });
});

describe("deferred measurement identity", () => {
  it("never shares an identity with the same metric measured for real", async () => {
    const ws = await scratch("deferred-identity");
    const { buildEnvelope } = await import("../src/lib/registry/evaluate.js");
    const envelope = await buildEnvelope(ws, { metrics: [metricId("review_score")], asOfDate: AS_OF });
    const deferred = envelope.measurements[0];
    expect(deferred.status).toBe("deferred");
    const real = await computeInputDigest(ws, metricDefinition(metricId("review_score")),
      { asOfDate: AS_OF, promptDigest: "e".repeat(64) });
    // The kernel must never reuse a deferred entry as if it were a measurement.
    expect(deferred.input_digest).not.toBe(real);
  });
});

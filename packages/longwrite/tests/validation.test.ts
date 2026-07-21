import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { toJsonl } from "../src/lib/research/jsonl.js";
import type { CitationPlanEntry, ClassifiedSource } from "../src/lib/research/types.js";
import {
  validateResearchWorkspace,
  validationReportToMarkdown,
  writeValidationReport,
} from "../src/lib/validation/research.js";

const tempDirs: string[] = [];

async function makeWorkspace(files: Record<string, string | Buffer>): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "longwrite-validation-"));
  tempDirs.push(dir);
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(dir, rel);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, content);
  }
  return dir;
}

afterEach(async () => {
  while (tempDirs.length > 0) await fs.rm(tempDirs.pop()!, { recursive: true, force: true });
});

const sources: ClassifiedSource[] = [
  {
    id: "source-1",
    title: "Grounded Research Agents",
    authors: ["Ada Lovelace"],
    year: 2026,
    venue: "LongWrite Test",
    url: "https://example.org/source-1",
    abstract: "Research agents should cite their sources.",
    source: "seed",
    topics: ["research", "agents"],
    quality_score: 0.9,
    score_rationale: "Test source.",
    citation_depth: "A",
    citation_depth_rationale: "Primary test source.",
  },
  {
    id: "source-2",
    title: "Workflow Validation",
    authors: ["Grace Hopper"],
    year: 2025,
    venue: "LongWrite Test",
    url: "https://example.org/source-2",
    abstract: "Workflow outputs need deterministic validation.",
    source: "seed",
    topics: ["workflow", "validation"],
    quality_score: 0.82,
    score_rationale: "Test source.",
    citation_depth: "A",
    citation_depth_rationale: "Primary test source.",
  },
];

const citationPlan: CitationPlanEntry[] = [
  {
    section_id: "section-1",
    section_title: "Background",
    source_ids: ["source-1", "source-2"],
  },
];

function validFiles(): Record<string, string | Buffer> {
  return {
    "sources/classified_sources.jsonl": toJsonl(sources),
    "sources/citation_plan.jsonl": toJsonl(citationPlan),
    "sources/bibliography.bib":
      "@misc{lovelace2026,\n  title = {Grounded Research Agents}\n}\n\n" +
      "@misc{hopper2025,\n  title = {Workflow Validation}\n}\n",
    "chapters/section-1.md":
      "# Background\n\nGrounded research agents cite source records [source:source-1] and validators [source:source-2].\n",
    "build/manuscript.pdf": Buffer.from("not really a pdf, but non-empty for validator tests"),
  };
}

describe("research workspace validation", () => {
  it("passes a workspace with citations, source coverage, bibliography, and build artifact", async () => {
    const ws = await makeWorkspace(validFiles());
    const report = await validateResearchWorkspace(ws);
    expect(report.pass).toBe(true);
    expect(report.checks.map((check) => check.id)).toEqual([
      "research_artifacts_present",
      "citation_markers_present",
      "source_coverage",
      "bibliography_consistent",
      "literature_quality_score",
      "citation_verification",
      "research_policy",
      "cited_literature_release_gates",
      "citation_url_liveness",
      "codebase_evidence",
      "taxonomy_direct_evidence",
      "target_length",
      "review_target",
      "empirical_experiment",
      "review_no_regressions",
      "claim_support",
      "full_research_contracts",
      "publication_artifact_contract",
      "manuscript_build",
    ]);
    expect(validationReportToMarkdown(report)).toContain("Status: pass");
  });

  it("reports missing citation markers and unknown source ids", async () => {
    const files = validFiles();
    files["chapters/section-1.md"] = "# Background\n\nUnsupported claim [source:missing-source].\n";
    const ws = await makeWorkspace(files);
    const report = await validateResearchWorkspace(ws);
    expect(report.pass).toBe(false);
    expect(report.checks.flatMap((check) => check.findings)).toEqual(expect.arrayContaining([
      expect.stringContaining("unknown source id \"missing-source\""),
      expect.stringContaining("does not cite any planned source"),
    ]));
  });

  it("accepts evidence-chunk citation locators as citations to their base source", async () => {
    const files = validFiles();
    files["chapters/section-1.md"] = "# Background\n\nGrounded claim [source:source-1:p12] and supporting context [source:source-2].\n";
    const ws = await makeWorkspace(files);
    const report = await validateResearchWorkspace(ws);
    expect(report.pass).toBe(true);
  });

  it("validates GitHub-discovered codebase markers against the shared pinned manifest", async () => {
    const files = validFiles();
    files["longwrite.yaml"] = [
      "version: 1", "project:", "  id: repo-paper", "  artifact_type: research_paper", "  mode: auto_research_agentic",
      "research:", "  paper_profile: repository_study", "  codebase_discovery:", "    enabled: true", "",
    ].join("\n");
    files["codebases/manifest.json"] = JSON.stringify({
      version: 1,
      codebases: [{ version: 1, id: "github-101", source: "https://github.com/org/repo.git", requested_ref: "main", resolved_commit: "a".repeat(40), title: "org/repo", role: "primary_artifact", snapshot_path: "codebases/github-101/snapshot", files: [], generated_at: "2026-07-19T00:00:00.000Z" }],
    });
    files["evidence/codebase-chunks.jsonl"] = `${JSON.stringify({ id: "repo", codebase_id: "github-101", path: "README.md", start_line: 1, end_line: 2, text: "repository evidence" })}\n`;
    files["evidence/codebase-comparison.json"] = JSON.stringify({
      version: 1, codebases: [{ codebase_id: "github-101", purpose: "This repository provides the primary software artifact.", architecture_summary: "The README documents a bounded repository architecture surface.", license: null, extension_points: [], limitations: [], locators: ["[codebase:github-101:README.md#L1-L2]"] }], comparisons: [],
    });
    files["chapters/section-1.md"] += "\nRepository evidence [codebase:github-101:README.md#L1-L2], with invalid evidence [codebase:unknown-repo:README.md#L1-L2].\n";
    const ws = await makeWorkspace(files);
    const report = await validateResearchWorkspace(ws);
    expect(report.checks.find((check) => check.id === "codebase_evidence")).toMatchObject({
      pass: false,
      findings: expect.arrayContaining([expect.stringContaining('unknown codebase id "unknown-repo"')]),
    });
  });

  it("requires a full research release to reach 80% of its configured word target", async () => {
    const files = validFiles();
    files["longwrite.yaml"] = [
      "version: 1",
      "project:",
      "  id: paper",
      "  artifact_type: research_paper",
      "  mode: auto_research_agentic",
      "writing:",
      "  target_length_words: 1000",
      "",
    ].join("\n");
    const ws = await makeWorkspace(files);
    const report = await validateResearchWorkspace(ws);
    expect(report.checks.find((check) => check.id === "target_length")).toMatchObject({
      pass: false,
      findings: [expect.stringContaining("full-release minimum 800")],
    });
  });

  it("gates cited sources, accepted venues, and per-section citation depth separately from corpus breadth", async () => {
    const files = validFiles();
    files["longwrite.yaml"] = [
      "version: 1",
      "project:",
      "  id: paper",
      "  artifact_type: research_paper",
      "  mode: auto_research_agentic",
      "research:",
      "  provider: multi",
      "  release_gates:",
      "    min_cited_sources: 3",
      "    min_accepted_cited_ratio: 0.75",
      "    min_citation_depths_per_section:",
      "      A: 1",
      "      B: 1",
      "      C: 0",
      "",
    ].join("\n");
    const ws = await makeWorkspace(files);
    const report = await validateResearchWorkspace(ws);
    expect(report.checks.find((check) => check.id === "cited_literature_release_gates")).toMatchObject({
      pass: false,
      findings: expect.arrayContaining([
        expect.stringContaining("cited sources 2 is below configured minimum 3"),
        expect.stringContaining("accepted cited-source ratio"),
        expect.stringContaining("has 0 B-depth cited sources"),
      ]),
    });
  });

  it("writes JSON and Markdown reports", async () => {
    const ws = await makeWorkspace(validFiles());
    const report = await validateResearchWorkspace(ws);
    const written = await writeValidationReport(ws, report);
    expect(written).toEqual(["reports/longwrite-validation.json", "reports/longwrite-validation.md"]);
    expect(await fs.readFile(path.join(ws, "reports/longwrite-validation.md"), "utf-8"))
      .toContain("LongWrite Validation Report");
  });
});

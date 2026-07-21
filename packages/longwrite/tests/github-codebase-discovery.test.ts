import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  discoverGithubCodebases,
  repairGithubCodebaseSelection,
  selectedGithubCodebases,
} from "../src/lib/research/github-codebase-discovery.js";

const tempDirs: string[] = [];

afterEach(async () => {
  while (tempDirs.length > 0) await fs.rm(tempDirs.pop()!, { recursive: true, force: true });
});

describe("GitHub codebase discovery", () => {
  it("filters GitHub search results, bounds README retrieval, and only materializes validated selections", async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "longwrite-github-discovery-"));
    tempDirs.push(workspace);
    await fs.mkdir(path.join(workspace, "sources"), { recursive: true });
    await fs.writeFile(path.join(workspace, "longwrite.yaml"), [
      "version: 1", "project:", "  id: github-discovery", "  artifact_type: research_paper", "  mode: auto_research_agentic",
      "research:", "  codebase_discovery:", "    enabled: true", "    query_budget: 1", "    max_candidates: 4", "    max_readme_fetches: 1", "    max_selected: 2", "    require_license: true", "    include_archived: false", "    languages: [TypeScript]",
      "writing: {}", "publication: {}", "figures: {}", "review: {}", "execution: {}", "",
    ].join("\n"), "utf8");
    await fs.writeFile(path.join(workspace, "sources", "search-plan.json"), JSON.stringify({
      version: 1, topic: "agent memory", query_variants: ["agent memory repository"], exclusion_terms: [], venue_priorities: [], source_types: [], taxonomy_cells: [],
    }), "utf8");
    const fetchImpl = (async (input: URL | RequestInfo) => {
      const url = String(input);
      if (url.includes("/search/repositories")) return new Response(JSON.stringify({ items: [
        { id: 101, full_name: "org/kept", html_url: "https://github.com/org/kept", clone_url: "https://github.com/org/kept.git", default_branch: "main", description: "Agent memory runner", topics: ["agents", "memory"], language: "TypeScript", license: { spdx_id: "MIT" }, archived: false, fork: false, stargazers_count: 7, updated_at: "2026-01-01T00:00:00Z" },
        { id: 102, full_name: "org/fork", html_url: "https://github.com/org/fork", clone_url: "https://github.com/org/fork.git", default_branch: "main", description: "Fork", topics: [], language: "TypeScript", license: { spdx_id: "MIT" }, archived: false, fork: true, stargazers_count: 0, updated_at: null },
        { id: 103, full_name: "org/no-license", html_url: "https://github.com/org/no-license", clone_url: "https://github.com/org/no-license.git", default_branch: "main", description: "No license", topics: [], language: "TypeScript", license: null, archived: false, fork: false, stargazers_count: 0, updated_at: null },
        { id: 104, full_name: "org/python", html_url: "https://github.com/org/python", clone_url: "https://github.com/org/python.git", default_branch: "main", description: "Wrong language", topics: [], language: "Python", license: { spdx_id: "MIT" }, archived: false, fork: false, stargazers_count: 0, updated_at: null },
      ] }), { status: 200 });
      if (url.includes("/repos/org/kept/readme")) return new Response("# Kept\n\nA bounded README for semantic screening.", { status: 200 });
      return new Response("not found", { status: 404 });
    }) as typeof fetch;

    await discoverGithubCodebases(workspace, fetchImpl);
    const candidates = JSON.parse(await fs.readFile(path.join(workspace, "codebases", "github-candidates.json"), "utf8")) as { candidates: Array<{ id: string; readme_excerpt: string | null }> };
    expect(candidates.candidates).toHaveLength(1);
    expect(candidates.candidates[0]).toMatchObject({ id: "github-101", readme_excerpt: expect.stringContaining("bounded README") });
    await fs.writeFile(path.join(workspace, "codebases", "github-selection.json"), JSON.stringify({
      version: 1,
      selections: [{ candidate_id: "github-101", role: "primary_artifact", rationale: "Its declared runner architecture directly supports the paper's repository-centered scope." }],
    }), "utf8");
    await repairGithubCodebaseSelection(workspace);
    await expect(selectedGithubCodebases(workspace)).resolves.toEqual([{
      id: "github-101", source: "https://github.com/org/kept.git", ref: "main", title: "org/kept", role: "primary_artifact",
    }]);
  });

  it("rejects an empty discovery selection when a repository study has no explicit codebase", async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "longwrite-github-empty-selection-"));
    tempDirs.push(workspace);
    await fs.mkdir(path.join(workspace, "codebases"), { recursive: true });
    await fs.writeFile(path.join(workspace, "longwrite.yaml"), [
      "version: 1", "project:", "  id: repo-study", "  artifact_type: research_paper", "  mode: auto_research_agentic",
      "research:", "  paper_profile: repository_study", "  codebase_discovery:", "    enabled: true",
      "writing: {}", "publication: {}", "figures: {}", "review: {}", "execution: {}", "",
    ].join("\n"), "utf8");
    await fs.writeFile(path.join(workspace, "codebases", "github-candidates.json"), JSON.stringify({
      version: 1, provider: "github", queries: ["repo"], token_authenticated: false, candidates: [],
    }), "utf8");
    await fs.writeFile(path.join(workspace, "codebases", "github-selection.json"), JSON.stringify({ version: 1, selections: [] }), "utf8");
    await expect(repairGithubCodebaseSelection(workspace)).rejects.toThrow(/invalid GitHub codebase-selection contract/i);
    expect(await fs.readFile(path.join(workspace, "reports", "github-codebase-selection-repair.md"), "utf8"))
      .toContain("add a pinned research.codebases entry or change the paper profile");
  });

  it("bounds GitHub queries, honors include_archived, and retries a throttled request", async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "longwrite-github-query-limit-"));
    tempDirs.push(workspace);
    await fs.mkdir(path.join(workspace, "sources"), { recursive: true });
    await fs.writeFile(path.join(workspace, "longwrite.yaml"), [
      "version: 1", "project:", "  id: github-query-limit", "  artifact_type: research_paper", "  mode: auto_research_agentic",
      "research:", "  codebase_discovery:", "    enabled: true", "    query_budget: 1", "    max_candidates: 1", "    max_readme_fetches: 0", "    include_archived: true",
      "writing: {}", "publication: {}", "figures: {}", "review: {}", "execution: {}", "",
    ].join("\n"), "utf8");
    await fs.writeFile(path.join(workspace, "sources", "search-plan.json"), JSON.stringify({
      version: 1, topic: "long query", query_variants: ["repository ".repeat(80)], exclusion_terms: [], venue_priorities: [], source_types: [], taxonomy_cells: [],
    }), "utf8");
    let requests = 0;
    let query = "";
    const fetchImpl = (async (input: URL | RequestInfo) => {
      requests += 1;
      query = new URL(String(input)).searchParams.get("q") ?? "";
      if (requests === 1) return new Response("slow down", { status: 429, headers: { "retry-after": "0" } });
      return new Response(JSON.stringify({ items: [] }), { status: 200 });
    }) as typeof fetch;
    await discoverGithubCodebases(workspace, fetchImpl);
    expect(requests).toBe(2);
    expect(query.length).toBeLessThanOrEqual(256);
    expect(query).not.toContain("archived:false");
  });

  it("rejects a discovered repository that canonicalizes to an explicit repository input", async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "longwrite-github-duplicate-source-"));
    tempDirs.push(workspace);
    await fs.mkdir(path.join(workspace, "codebases"), { recursive: true });
    await fs.writeFile(path.join(workspace, "longwrite.yaml"), [
      "version: 1", "project:", "  id: duplicate-source", "  artifact_type: research_paper", "  mode: auto_research_agentic",
      "research:", "  paper_profile: repository_study", "  codebases:", "    - id: explicit", "      source: https://github.com/Org/Demo", "      ref: main",
      "  codebase_discovery:", "    enabled: true", "writing: {}", "publication: {}", "figures: {}", "review: {}", "execution: {}", "",
    ].join("\n"), "utf8");
    await fs.writeFile(path.join(workspace, "codebases", "github-candidates.json"), JSON.stringify({
      version: 1, provider: "github", queries: ["demo"], token_authenticated: false, candidates: [{
        id: "github-1", github_id: 1, full_name: "org/demo", html_url: "https://github.com/org/demo", clone_url: "https://github.com/org/demo.git",
        default_branch: "main", description: "demo", topics: [], language: null, license_spdx_id: "MIT", archived: false, fork: false,
        stargazers_count: 0, updated_at: null, query_indices: [0], readme_excerpt: null, readme_status: "not_requested",
      }],
    }), "utf8");
    await fs.writeFile(path.join(workspace, "codebases", "github-selection.json"), JSON.stringify({
      version: 1, selections: [{ candidate_id: "github-1", role: "supplementary_artifact", rationale: "This appears relevant but duplicates the explicitly pinned software source." }],
    }), "utf8");
    await expect(repairGithubCodebaseSelection(workspace)).rejects.toThrow(/duplicates explicitly configured repository/i);
  });
});

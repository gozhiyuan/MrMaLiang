import { afterEach, describe, expect, it } from "vitest";
import { execFile as execFileCallback } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { prepareCodebases } from "../src/lib/research/codebase.js";
import { codebaseBibtexKey } from "../src/lib/research/codebase-contract.js";

const execFile = promisify(execFileCallback);
const tempDirs: string[] = [];

async function command(file: string, args: string[], cwd?: string): Promise<void> {
  await execFile(file, args, { cwd });
}

afterEach(async () => {
  while (tempDirs.length > 0) await fs.rm(tempDirs.pop()!, { recursive: true, force: true });
});

describe("pinned codebase evidence", () => {
  it("creates collision-free BibTeX keys for punctuation-distinct ids", () => {
    expect(codebaseBibtexKey("repo-a")).not.toBe(codebaseBibtexKey("repo_a"));
    expect(codebaseBibtexKey("repo-a")).not.toBe(codebaseBibtexKey("repo_2d_a"));
  });

  it("snapshots a local Git repository, writes bounded evidence, and produces an @software citation", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "longwrite-codebase-"));
    tempDirs.push(root);
    const repository = path.join(root, "repository");
    const workspace = path.join(root, "workspace");
    await fs.mkdir(path.join(repository, "src"), { recursive: true });
    await fs.writeFile(path.join(repository, "README.md"), "# Demo repository\n\nThis repository defines a reproducible runner and interoperates with https://github.com/example/related-tool.\n", "utf8");
    await fs.writeFile(path.join(repository, "CITATION.cff"), [
      "cff-version: 1.2.0", "title: Citation-aware Demo", "version: 2.1.0", "date-released: 2024-04-05",
      "doi: 10.5555/demo.21", "repository-code: https://github.com/example/demo", "authors:",
      "  - family-names: Lovelace", "    given-names: Ada", "",
    ].join("\n"), "utf8");
    await fs.writeFile(path.join(repository, "src", "runner.ts"), "export function runTrial() { return 'verified'; }\n", "utf8");
    await command("git", ["init"], repository);
    await command("git", ["config", "user.email", "tests@example.com"], repository);
    await command("git", ["config", "user.name", "LongWrite Tests"], repository);
    await command("git", ["add", "."], repository);
    await command("git", ["commit", "-m", "initial"], repository);
    await fs.mkdir(workspace, { recursive: true });
    await fs.writeFile(path.join(workspace, "longwrite.yaml"), [
      "version: 1", "project:", "  id: codebase-paper", "  artifact_type: research_paper", "  mode: auto_research_agentic",
      "research:", "  codebases:", "    - id: demo", `      source: ${repository}`, "      ref: HEAD", "      title: Demo repository", "writing: {}", "publication: {}", "figures: {}", "review: {}", "execution: {}", "",
    ].join("\n"), "utf8");

    const result = await prepareCodebases(workspace);
    const manifest = JSON.parse(await fs.readFile(path.join(workspace, "codebases", "manifest.json"), "utf8")) as { codebases: Array<{ id: string; resolved_commit: string; title: string; citation_metadata: { source: string; version: string; doi: string } }> };
    const context = await fs.readFile(path.join(workspace, "evidence", "codebase-context.md"), "utf8");
    const bibliography = await fs.readFile(path.join(workspace, "sources", "codebases.bib"), "utf8");
    const mentioned = JSON.parse(await fs.readFile(path.join(workspace, "codebases", "mentioned-repositories.json"), "utf8")) as { candidates: Array<{ url: string }>; recursive_fetch_performed: boolean };
    const dryRunArchitecture = JSON.parse(await fs.readFile(path.join(workspace, ".malaclaw", "fixtures", "evidence", "codebase-analysis.raw.json"), "utf8")) as { codebases: Array<{ codebase_id: string; summary: string }> };
    expect(result).toMatchObject({ codebases: 1 });
    expect(manifest.codebases[0]).toMatchObject({ id: "demo", title: "Citation-aware Demo", citation_metadata: { source: "CITATION.cff", version: "2.1.0", doi: "10.5555/demo.21" } });
    expect(manifest.codebases[0]?.resolved_commit).toMatch(/^[0-9a-f]{40}$/);
    expect(context).toContain("codebase:demo");
    expect(bibliography).toContain("@software{codebasedemo");
    expect(bibliography).toContain("author = {Lovelace, Ada}");
    expect(bibliography).toContain("year = {2024}");
    expect(bibliography).toContain("doi = {10.5555/demo.21}");
    expect(mentioned).toMatchObject({ recursive_fetch_performed: false, candidates: [{ url: "https://github.com/example/related-tool" }] });
    expect(dryRunArchitecture.codebases[0]).toMatchObject({ codebase_id: "demo" });
    expect(dryRunArchitecture.codebases[0]?.summary).toContain("no architecture or execution conclusion");
  });

  it("deduplicates canonical repository identities and gives each pinned repository bounded context", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "longwrite-codebase-multi-"));
    tempDirs.push(root);
    const workspace = path.join(root, "workspace");
    const repositories: string[] = [];
    for (const name of ["alpha", "beta"]) {
      const repository = path.join(root, name);
      repositories.push(repository);
      await fs.mkdir(repository, { recursive: true });
      await fs.writeFile(path.join(repository, "README.md"), `# ${name}\n\n${name.toUpperCase()}_UNIQUE_ARCHITECTURE_MARKER describes this repository's independently bounded component and interface contract.\n`, "utf8");
      await command("git", ["init"], repository);
      await command("git", ["config", "user.email", "tests@example.com"], repository);
      await command("git", ["config", "user.name", "LongWrite Tests"], repository);
      await command("git", ["add", "."], repository);
      await command("git", ["commit", "-m", "initial"], repository);
    }
    await fs.mkdir(workspace, { recursive: true });
    const writeConfig = async (sources: string[]) => fs.writeFile(path.join(workspace, "longwrite.yaml"), [
      "version: 1", "project:", "  id: multi", "  artifact_type: research_paper", "  mode: auto_research_agentic",
      "research:", "  paper_profile: repository_study", "  codebases:",
      ...sources.flatMap((source, index) => [ `    - id: repo-${index + 1}`, `      source: ${source}`, "      ref: HEAD", `      role: ${index === 0 ? "primary_artifact" : "supplementary_artifact"}` ]),
      "writing: {}", "publication: {}", "figures: {}", "review: {}", "execution: {}", "",
    ].join("\n"), "utf8");
    await writeConfig(repositories);
    await prepareCodebases(workspace);
    const context = await fs.readFile(path.join(workspace, "evidence", "codebase-context.md"), "utf8");
    expect(context).toContain("ALPHA_UNIQUE_ARCHITECTURE_MARKER");
    expect(context).toContain("BETA_UNIQUE_ARCHITECTURE_MARKER");

    const duplicateWorkspace = path.join(root, "duplicate-workspace");
    await fs.mkdir(duplicateWorkspace);
    const originalWorkspace = workspace;
    // Reuse the writer with a second workspace path while supplying the same
    // repository through path spellings that canonicalize identically.
    await fs.writeFile(path.join(duplicateWorkspace, "longwrite.yaml"), (await fs.readFile(path.join(originalWorkspace, "longwrite.yaml"), "utf8"))
      .replace(repositories[1]!, `${repositories[0]}/`), "utf8");
    await expect(prepareCodebases(duplicateWorkspace)).rejects.toThrow(/duplicate repository source/i);
  });
});

import { describe, it, expect } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import url from "node:url";
import * as citation from "../src/modules/citation/index.js";
import * as evidence from "../src/modules/evidence/index.js";
import * as repository from "../src/modules/repository/index.js";
import * as figures from "../src/modules/manuscript-figures/index.js";
import * as latex from "../src/modules/manuscript-latex/index.js";
import * as publication from "../src/modules/publication/index.js";
import * as handoff from "../src/modules/experiment-handoff/index.js";

/**
 * Phase MM-1: module boundaries.
 *
 * The modules are facades over the existing `src/lib/` implementations — the
 * plan permits "move OR re-export", and re-exporting first means the frozen
 * golden manifests keep passing while the boundary becomes explicit.
 *
 * These tests assert the boundary is REAL: each module exposes a usable
 * surface, the old import paths still work, and every subcommand a module
 * claims to own actually appears in the MM-0.2 command inventory.
 */

const here = path.dirname(url.fileURLToPath(import.meta.url));
const inventoryPath = path.resolve(here, "..", "..", "..", "docs", "internal", "generated-stage-commands.md");

const MODULES = [
  { name: "citation", mod: citation, subcommands: citation.CITATION_SUBCOMMANDS },
  { name: "evidence", mod: evidence, subcommands: evidence.EVIDENCE_SUBCOMMANDS },
  { name: "repository", mod: repository, subcommands: repository.REPOSITORY_SUBCOMMANDS },
  { name: "manuscript-figures", mod: figures, subcommands: figures.FIGURE_SUBCOMMANDS },
  { name: "manuscript-latex", mod: latex, subcommands: latex.LATEX_SUBCOMMANDS },
  { name: "publication", mod: publication, subcommands: publication.PUBLICATION_SUBCOMMANDS },
  { name: "experiment-handoff", mod: handoff, subcommands: handoff.EXPERIMENT_HANDOFF_SUBCOMMANDS },
] as const;

describe("module facades", () => {
  it.each(MODULES.map((m) => [m.name, m.mod] as const))("%s exposes a usable surface", (_name, mod) => {
    const exported = Object.keys(mod).filter((key) => key !== "default");
    expect(exported.length).toBeGreaterThan(0);
    for (const key of exported) {
      expect(mod[key as keyof typeof mod], `${key} is exported but undefined`).toBeDefined();
    }
  });

  it("exposes the functions each module is responsible for", () => {
    // Spot-check the load-bearing entry point of each module rather than
    // asserting a full export list, which would just restate index.ts.
    expect(typeof citation.reconcileWorkspaceSources).toBe("function");
    expect(typeof citation.verifyCitedSourceUrls).toBe("function");
    expect(typeof evidence.buildEvidenceIndex).toBe("function");
    expect(typeof evidence.allocateSectionEvidence).toBe("function");
    expect(typeof evidence.evaluateCorpusGates).toBe("function");
    expect(typeof repository.prepareCodebases).toBe("function");
    expect(typeof figures.sanitizePlacementPlanFile).toBe("function");
    expect(typeof latex.compileLatex).toBe("function");
    expect(typeof publication.packagePublicationWorkspace).toBe("function");
    expect(typeof handoff.importLongExperiment).toBe("function");
  });

  it("keeps the pre-extraction import paths working", async () => {
    // MM-1 requires a deprecation period: existing `src/lib/...` imports must
    // keep resolving to the same implementations.
    const legacyIdentity = await import("../src/lib/research/identity.js");
    const legacyEvidence = await import("../src/lib/research/evidence.js");
    expect(citation.reconcileWorkspaceSources).toBe(legacyIdentity.reconcileWorkspaceSources);
    expect(evidence.buildEvidenceIndex).toBe(legacyEvidence.buildEvidenceIndex);
  });
});

describe("declared subcommands match the generated inventory", () => {
  it("every module subcommand appears in docs/internal/generated-stage-commands.md", async () => {
    // This is the cross-check that makes the boundaries honest: a module can
    // only claim a subcommand the compiled manifests actually invoke.
    const inventory = await fs.readFile(inventoryPath, "utf-8");
    const missing: string[] = [];

    for (const { name, subcommands } of MODULES) {
      for (const [key, tokens] of Object.entries(subcommands)) {
        const rendered = `\`${(tokens as readonly string[]).join(" ")}\``;
        if (!inventory.includes(rendered)) missing.push(`${name}.${key} -> ${rendered}`);
      }
    }

    expect(missing, `subcommands not found in the inventory:\n${missing.join("\n")}`).toEqual([]);
  });

  it("no subcommand is claimed by two modules", () => {
    // Overlapping ownership would make MM-2's compiler split ambiguous.
    const owners = new Map<string, string[]>();
    for (const { name, subcommands } of MODULES) {
      for (const tokens of Object.values(subcommands)) {
        const key = (tokens as readonly string[]).join(" ");
        owners.set(key, [...(owners.get(key) ?? []), name]);
      }
    }
    const contested = [...owners.entries()].filter(([, names]) => names.length > 1);
    expect(contested, `contested subcommands: ${JSON.stringify(contested)}`).toEqual([]);
  });
});

describe("module non-negotiables are documented at the boundary", () => {
  it.each([
    ["evidence", "src/modules/evidence/index.ts", [/[Ee]xact locator/, /SQLite FTS/, /embedding stays optional/i, /seed provider/i]],
    ["repository", "src/modules/repository/index.ts", [/separate from scholarly/i, /immutable/i, /CANDIDATES, not evidence/]],
    ["manuscript-figures", "src/modules/manuscript-figures/index.ts", [/fail-closed/, /render hash/]],
    ["manuscript-latex", "src/modules/manuscript-latex/index.ts", [/[Pp]laceholder PDF/]],
    ["experiment-handoff", "src/modules/experiment-handoff/index.ts", [/research-protocol/]],
  ])("%s states its invariants", async (_name, file, patterns) => {
    // The plan lists these as acceptance criteria. Stating them where the
    // boundary lives is what stops the physical move in a later phase from
    // quietly dropping one.
    const source = await fs.readFile(path.resolve(here, "..", file), "utf-8");
    for (const pattern of patterns as RegExp[]) {
      expect(source, `${file} does not state ${pattern}`).toMatch(pattern);
    }
  });
});

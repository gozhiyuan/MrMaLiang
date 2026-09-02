import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { checkManuscriptReferences, validateFigureWorkspace } from "../src/lib/validation/figures.js";
import { FindingSchema } from "../src/lib/registry/records.js";
import { REGISTRY } from "../src/lib/registry/producers.js";
import { figureManifestSchema } from "../src/lib/writing/figures.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((r) => fs.rm(r, { recursive: true, force: true })));
});

/** A manifest whose figure-1 is placed in section-03 but neither labeled nor
 * embedded there — the defect is visible only in generated TeX, and fixable
 * only in the placement plan. */
async function workspace(): Promise<string> {
  const ws = await fs.mkdtemp(path.join(os.tmpdir(), "longwrite-fig-structured-"));
  roots.push(ws);
  await fs.mkdir(path.join(ws, "figures"), { recursive: true });
  await fs.mkdir(path.join(ws, "paper", "sections"), { recursive: true });
  await fs.writeFile(path.join(ws, "figures", "manifest.json"), JSON.stringify({
    version: 1,
    figures: [{
      id: "figure-1", title: "Overview", caption: "An overview", insight: "",
      path: "figures/figure-1.svg", latex_path: "paper/figures/figure-1.tex",
      placement: { section_id: "section-03", discussion: "introduced in the overview" },
      backend: "deterministic-svg", data: [],
    }],
    tables: [],
  }), "utf-8");
  await fs.writeFile(path.join(ws, "paper", "main.tex"), "\\documentclass{article}\n", "utf-8");
  await fs.writeFile(path.join(ws, "paper", "sections", "section-03.tex"), "Prose with no float.\n", "utf-8");
  return ws;
}

const manifest = async (ws: string) =>
  figureManifestSchema.parse(JSON.parse(await fs.readFile(path.join(ws, "figures", "manifest.json"), "utf-8")));

describe("figures structured output", () => {
  it("is exported and emits schema-valid findings", async () => {
    const ws = await workspace();
    const check = await checkManuscriptReferences(ws, await manifest(ws));
    expect(check.pass).toBe(false);
    expect(check.findings.length).toBeGreaterThan(0);
    for (const finding of check.findings) expect(FindingSchema.safeParse(finding).success).toBe(true);
  });

  it("names the editable producing surface, not the generated TeX", async () => {
    const ws = await workspace();
    const check = await checkManuscriptReferences(ws, await manifest(ws));
    const finding = check.findings.find((f) => f.required_effect === "repair_artifact_placement");
    expect(finding?.artifact.kind).toBe("figure_spec");
    expect(finding?.artifact).toHaveProperty("path", "figures/placement-plan.json");
    expect((finding?.artifact as { artifact_id?: string }).artifact_id).toBe("figure-1");
    // Sending a repair at the .tex would edit a file the next render overwrites.
    expect(finding?.location).toContain("paper/sections/section-03.tex");
  });

  it("emits findings that all resolve to a capability", async () => {
    const ws = await workspace();
    for (const finding of (await checkManuscriptReferences(ws, await manifest(ws))).findings) {
      expect(() => REGISTRY.resolveCapability({
        gate: finding.gate_id, kind: finding.artifact.kind, effect: finding.required_effect,
      })).not.toThrow();
    }
  });

  it("converts every check in the module, not only one", async () => {
    const report = await validateFigureWorkspace(await workspace());
    for (const check of report.checks) {
      expect(Array.isArray(check.findings)).toBe(true);
      for (const finding of check.findings) {
        expect(typeof finding).toBe("object");
        expect(FindingSchema.safeParse(finding).success).toBe(true);
      }
    }
  });

  it("keeps human prose available as a diagnostic", async () => {
    const ws = await workspace();
    const check = await checkManuscriptReferences(ws, await manifest(ws));
    expect(check.findings[0].diagnostic).toMatch(/figure-1/);
  });

  it("leaves no failing check without something to act on", async () => {
    // A failed check with no finding and no diagnosis request stalls the round.
    const report = await validateFigureWorkspace(await workspace());
    for (const check of report.checks.filter((item) => !item.pass)) {
      expect(check.findings.length > 0 || check.requires_diagnosis, String(check.id)).toBeTruthy();
    }
  });
});

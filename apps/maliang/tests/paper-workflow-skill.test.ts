import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { TEMPLATES } from "../src/templates.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const skill = fs.readFileSync(path.join(root, "packages/longwrite/skills/paper-workflow/SKILL.md"), "utf8");

describe("paper-workflow skill", () => {
  it("names only catalogued paper templates and stable public commands", () => {
    const templateIds = ["paper.survey", "paper.empirical", "paper.empirical-import"];
    for (const id of templateIds) expect(TEMPLATES.some((template) => template.id === id)).toBe(true);
    for (const command of ["maliang template list", "maliang init", "maliang preflight", "maliang run", "maliang status", "maliang handoff import", "maliang provenance", "maliang writing workspace archive"]) {
      expect(skill).toContain(command);
    }
  });
});

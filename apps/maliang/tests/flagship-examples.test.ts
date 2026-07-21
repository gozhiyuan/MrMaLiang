import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { describe, expect, it } from "vitest";
import { templateById } from "../src/templates.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const examples = [
  "long-agentic-survey",
  "repository-survey",
  "nanogpt-agentic-empirical-paper",
  "self-play-autonomous-empirical-paper",
] as const;

const expectedAxes = {
  "long-agentic-survey": { paperKind: "survey", evidenceProfile: "literature", experimentSource: "none" },
  "repository-survey": { paperKind: "survey", evidenceProfile: "repository", experimentSource: "none" },
  "nanogpt-agentic-empirical-paper": { paperKind: "empirical", evidenceProfile: "repository", experimentSource: "run", experimentAuthoring: "agentic" },
  "self-play-autonomous-empirical-paper": { paperKind: "empirical", evidenceProfile: "literature", experimentSource: "run", experimentAuthoring: "agentic" },
} as const;

describe("flagship blueprints", () => {
  for (const id of examples) {
    it(`${id} declares a real template and an operator README`, () => {
      const directory = path.join(root, "examples", "flagships", id);
      const blueprintPath = path.join(directory, "blueprint.yaml");
      const blueprint = parse(fs.readFileSync(blueprintPath, "utf8")) as { version?: unknown; id?: unknown; template?: unknown; components?: unknown; experiment_authoring?: unknown };
      expect(blueprint.version).toBe(1);
      expect(blueprint.id).toBe(id);
      expect(typeof blueprint.template).toBe("string");
      expect(() => templateById(blueprint.template as string)).not.toThrow();
      expect(Array.isArray(blueprint.components)).toBe(true);
      expect(fs.existsSync(path.join(directory, "README.md"))).toBe(true);
      const snapshot = path.join(directory, "workspace");
      expect(fs.existsSync(path.join(snapshot, "maliang.yaml.template"))).toBe(true);
      expect(fs.existsSync(path.join(snapshot, "writing", "longwrite.yaml"))).toBe(true);
      expect(fs.existsSync(path.join(snapshot, "writing", ".env.example"))).toBe(true);
      expect(fs.existsSync(path.join(snapshot, "expected-artifacts.md"))).toBe(true);
      const project = parse(fs.readFileSync(path.join(snapshot, "maliang.yaml.template"), "utf8")) as { research?: unknown };
      expect(project.research).toEqual(expectedAxes[id]);
      if (expectedAxes[id].experimentSource === "run") {
        expect(blueprint.experiment_authoring).toBe("agentic");
        expect(fs.existsSync(path.join(snapshot, "experiment", "experiment.yaml"))).toBe(true);
        const experiment = parse(fs.readFileSync(path.join(snapshot, "experiment", "experiment.yaml"), "utf8")) as any;
        expect(experiment.authoring.mode).toBe("agentic");
        expect(experiment.outputs.longwrite_workspace).toBe("../writing");
      }
    });
  }
});

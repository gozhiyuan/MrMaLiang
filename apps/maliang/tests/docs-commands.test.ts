import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { classifyCommand, extractShellCommands } from "../src/doc-commands.js";
import { findContract } from "../src/routing.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const OPERATOR_DOCS = [
  "README.md",
  "docs/quickstart.md",
  "docs/flagship-preflight.md",
  "docs/remote-gpu-modal.md",
  "packages/longwrite/README.md",
  "packages/longwrite/CONTRIBUTING.md",
  "packages/longwrite/dashboard-extension/README.md",
  "packages/longexperiment/README.md",
  "packages/longwrite/skills/longwrite-planner/SKILL.md",
  "docs/flagships/README.md",
  "docs/flagships/long-agentic-survey.md",
  "packages/longwrite/docs/configuration.md",
  "packages/longwrite/docs/research-evidence.md",
  "docs/flagships/repository-survey.md",
  "docs/flagships/nanogpt-agentic-empirical-paper.md",
  "docs/flagships/self-play-autonomous-empirical-paper.md",
  "packages/longwrite/docs/workspace-lifecycle.md",
  "packages/longwrite/docs/architecture.md",
  "packages/longwrite/docs/quickstart.md",
  "examples/flagships/long-agentic-survey/README.md",
  "examples/flagships/repository-survey/README.md",
  "examples/flagships/nanogpt-agentic-empirical-paper/README.md",
  "examples/flagships/self-play-autonomous-empirical-paper/README.md",
];

const native = new Set(["init", "run", "status", "provenance", "preflight", "handoff", "experiment", "template", "writing"]);

describe("operator documentation uses the Maliang public CLI", () => {
  for (const rel of OPERATOR_DOCS) {
    it(`${rel} has no direct component CLI command`, () => {
      const lines = extractShellCommands(fs.readFileSync(path.join(root, rel), "utf8"));
      expect(lines.filter((line) => classifyCommand(line).kind === "component"), rel).toEqual([]);
    });
  }

  it("every documented proxied maliang command maps to a public contract", () => {
    for (const rel of OPERATOR_DOCS) {
      for (const line of extractShellCommands(fs.readFileSync(path.join(root, rel), "utf8"))) {
        const command = classifyCommand(line);
        if (command.kind !== "maliang") continue;
        let tokens = command.tokens.slice(1);
        if (tokens[0] === "experiment" && (tokens[1] === "flagship" || tokens[1] === "validate")) continue;
        if (tokens[0] === "writing" || tokens[0] === "experiment") tokens = tokens.slice(1);
        if (!tokens.length || native.has(tokens[0])) continue;
        const verb = tokens.filter((token) => !token.startsWith("-"));
        if (!verb.length) continue; // global CLI flags such as `maliang --version`
        expect(findContract(verb), `${rel}: ${line}`).not.toBeNull();
      }
    }
  });

  it("uses only the three parameterized public paper template names", () => {
    const retired = /paper\.(?:repository-survey|empirical-prescribed|repository-empirical(?:-prescribed|-import)?)/;
    for (const rel of OPERATOR_DOCS) {
      expect(fs.readFileSync(path.join(root, rel), "utf8"), rel).not.toMatch(retired);
    }
  });
});

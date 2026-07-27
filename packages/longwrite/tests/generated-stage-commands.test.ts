import { describe, it, expect } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import url from "node:url";

/**
 * Phase MM-0.2: inventory every generated stage command.
 *
 * MM-1/MM-2 move `longwriteCommand()` and `longexperimentCommand()` call sites
 * between modules. This inventory is derived from the frozen golden manifests
 * rather than hand-written, so it cannot drift: if a refactor changes which
 * subcommand a stage invokes, this test fails and the doc must be regenerated
 * deliberately.
 *
 * Regenerate with: UPDATE_GOLDEN=1 npx vitest run tests/generated-stage-commands.test.ts
 */

const here = path.dirname(url.fileURLToPath(import.meta.url));
const packageRoot = path.resolve(here, "..");
const repoRoot = path.resolve(packageRoot, "..", "..");
const docPath = path.join(repoRoot, "docs", "internal", "generated-stage-commands.md");
const UPDATE = process.env.UPDATE_GOLDEN === "1";

const SOURCES = [
  { cli: "longwrite", dir: path.join(here, "fixtures", "compiled") },
  { cli: "longexperiment", dir: path.resolve(packageRoot, "..", "longexperiment", "tests", "fixtures", "compiled") },
];

type Invocation = {
  cli: string;
  subcommand: string;
  stages: Set<string>;
  fixtures: Set<string>;
  flags: Set<string>;
};

/** Subcommand tokens are lowercase words. Everything else is a VALUE — a topic,
 *  a numeric limit, a path — and must not fragment the inventory into one row
 *  per fixture. */
const SUBCOMMAND_TOKEN = /^[a-z][a-z0-9-]*$/;

function splitInvocation(rest: string[]): { subcommand: string; flags: string[] } {
  const words: string[] = [];
  for (const token of rest) {
    // Everything after the first flag is a flag or a flag VALUE (a provider
    // name, a limit), never part of the subcommand path.
    if (token.startsWith("--")) break;
    if (token === "." || !SUBCOMMAND_TOKEN.test(token)) continue;
    words.push(token);
  }
  const flags = rest.filter((token) => token.startsWith("--")).sort();
  return { subcommand: words.join(" ") || "(no subcommand)", flags };
}

/** Walk a compiled manifest, pairing each stage id with the command it runs. */
function collect(node: unknown, fixture: string, into: Map<string, Invocation>, stageId = "(root)"): void {
  if (Array.isArray(node)) {
    for (const item of node) collect(item, fixture, into, stageId);
    return;
  }
  if (!node || typeof node !== "object") return;
  const record = node as Record<string, unknown>;
  const currentStage = typeof record.id === "string" ? record.id : stageId;

  const command = record.command as { cmd?: unknown; args?: unknown } | undefined;
  if (command && Array.isArray(command.args)) {
    const args = command.args.filter((a): a is string => typeof a === "string");
    const cliToken = args[0] ?? "";
    const cli = cliToken.includes("longexperiment") ? "longexperiment"
      : cliToken.includes("longwrite") ? "longwrite"
        : String(command.cmd ?? "other");
    const { subcommand, flags } = splitInvocation(args.slice(1));
    const key = `${cli}::${subcommand}`;
    const entry = into.get(key)
      ?? { cli, subcommand, stages: new Set(), fixtures: new Set(), flags: new Set() };
    entry.stages.add(currentStage);
    entry.fixtures.add(fixture);
    for (const flag of flags) entry.flags.add(flag);
    into.set(key, entry);
  }

  for (const value of Object.values(record)) collect(value, fixture, into, currentStage);
}

async function buildInventory(): Promise<Map<string, Invocation>> {
  const inventory = new Map<string, Invocation>();
  for (const source of SOURCES) {
    const files = (await fs.readdir(source.dir)).filter((f) => f.endsWith(".json")).sort();
    for (const file of files) {
      const manifest = JSON.parse(await fs.readFile(path.join(source.dir, file), "utf-8"));
      collect(manifest, file, inventory);
    }
  }
  return inventory;
}

function render(inventory: Map<string, Invocation>): string {
  const rows = [...inventory.values()].sort((a, b) =>
    a.cli === b.cli ? a.subcommand.localeCompare(b.subcommand) : a.cli.localeCompare(b.cli));

  const lines: string[] = [
    "# Generated stage commands",
    "",
    "Every deterministic command the compilers emit into a MalaClaw manifest,",
    "derived from the frozen golden manifests in",
    "`packages/*/tests/fixtures/compiled/`. **Do not edit by hand** — regenerate with:",
    "",
    "```bash",
    "UPDATE_GOLDEN=1 npx vitest run tests/generated-stage-commands.test.ts \\",
    "  --root packages/longwrite",
    "```",
    "",
    "This is the MM-0.2 inventory: MM-1 and MM-2 relocate the `longwriteCommand()`",
    "and `longexperimentCommand()` call sites, and this table is what proves the",
    "resulting manifests still invoke the same subcommands.",
    "",
  ];

  for (const cli of ["longwrite", "longexperiment"]) {
    const forCli = rows.filter((row) => row.cli === cli);
    if (forCli.length === 0) continue;
    lines.push(`## \`${cli}\``, "");
    lines.push("| Subcommand | Flags | Stages |", "| --- | --- | --- |");
    for (const row of forCli) {
      const stages = [...row.stages].sort().map((s) => `\`${s}\``).join(", ");
      const flags = [...row.flags].sort().map((f) => `\`${f}\``).join(" ") || "—";
      lines.push(`| \`${row.subcommand}\` | ${flags} | ${stages} |`);
    }
    lines.push("");
  }

  const other = rows.filter((row) => row.cli !== "longwrite" && row.cli !== "longexperiment");
  if (other.length > 0) {
    lines.push("## Other commands", "");
    lines.push("| Command | Subcommand | Stages |", "| --- | --- | --- |");
    for (const row of other) {
      const stages = [...row.stages].sort().map((s) => `\`${s}\``).join(", ");
      lines.push(`| \`${row.cli}\` | \`${row.subcommand}\` | ${stages} |`);
    }
    lines.push("");
  }

  return lines.join("\n");
}

describe("generated stage command inventory", () => {
  it("matches the committed inventory document", async () => {
    const expected = render(await buildInventory());

    if (UPDATE) {
      await fs.mkdir(path.dirname(docPath), { recursive: true });
      await fs.writeFile(docPath, expected, "utf-8");
    }

    const actual = await fs.readFile(docPath, "utf-8");
    expect(actual, "docs/internal/generated-stage-commands.md is stale; re-run with UPDATE_GOLDEN=1")
      .toBe(expected);
  });

  it("covers both CLIs", async () => {
    const inventory = await buildInventory();
    const clis = new Set([...inventory.values()].map((entry) => entry.cli));
    expect(clis.has("longwrite")).toBe(true);
    expect(clis.has("longexperiment")).toBe(true);
  });

  it("records a non-trivial number of distinct subcommands", async () => {
    // Guards against a collector regression silently emptying the inventory.
    expect((await buildInventory()).size).toBeGreaterThan(10);
  });
});

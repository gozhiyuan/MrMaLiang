import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { readMaliangProject } from "./project.js";

const monorepoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const sha256 = (value: Buffer | string): string => createHash("sha256").update(value).digest("hex");

async function fileChecksum(file: string): Promise<string | undefined> {
  try { return sha256(await fs.readFile(file)); } catch { return undefined; }
}

async function commandOutput(command: string, args: string[], cwd: string): Promise<string | undefined> {
  return await new Promise((resolve) => {
    const child = spawn(command, args, { cwd, stdio: ["ignore", "pipe", "ignore"] });
    let output = "";
    child.stdout.on("data", (chunk) => { output += String(chunk); });
    child.once("error", () => resolve(undefined));
    child.once("exit", (code) => resolve(code === 0 ? output.trim() : undefined));
  });
}

async function packageVersion(relative: string): Promise<string | undefined> {
  try { return (JSON.parse(await fs.readFile(path.join(monorepoRoot, relative, "package.json"), "utf8")) as { version?: string }).version; } catch { return undefined; }
}

async function yamlAt(file: string): Promise<Record<string, unknown> | undefined> {
  try { return parse(await fs.readFile(file, "utf8")) as Record<string, unknown>; } catch { return undefined; }
}

/** Write a content-addressed, immutable provenance record and refresh a small
 * index at reports/run-provenance.json. Secrets are intentionally excluded. */
export async function writeMaliangProvenance(workspace: string, event: string): Promise<string> {
  const project = await readMaliangProject(workspace);
  const writingDir = project.components.writing ? path.join(workspace, project.components.writing.workspace) : undefined;
  const experimentDir = project.components.experiment ? path.join(workspace, project.components.experiment.workspace) : undefined;
  const writingConfig = writingDir ? await yamlAt(path.join(writingDir, "longwrite.yaml")) : undefined;
  const experimentConfig = experimentDir ? await yamlAt(path.join(experimentDir, "experiment.yaml")) : undefined;
  const manifestPath = project.handoff.manifest_path ? path.join(workspace, project.handoff.manifest_path) : undefined;
  const manifest = manifestPath ? await yamlAt(manifestPath) : undefined;
  const outputs = Object.fromEntries((await Promise.all([
    ["maliang_config", path.join(workspace, "maliang.yaml")],
    ["experiment_manifest", manifestPath],
    ["experiment_packet", writingDir ? path.join(writingDir, "evidence", "experiment-packets.json") : undefined],
    ["corpus_chunks", writingDir ? path.join(writingDir, "evidence", "chunks.jsonl") : undefined],
    ["final_pdf", writingDir ? path.join(writingDir, "build", "main.pdf") : undefined],
  ].filter((item): item is [string, string] => Boolean(item[1])).map(async ([id, file]) => [id, await fileChecksum(file)] as const))).filter(([, checksum]) => Boolean(checksum)));
  const record = {
    version: 1,
    kind: "mr-maliang-run-provenance",
    event,
    created_at: new Date().toISOString(),
    project: { id: project.project.id, template: project.project.template, handoff: project.handoff },
    software: {
      mr_maliang: { version: await packageVersion("."), git_revision: await commandOutput("git", ["rev-parse", "HEAD"], monorepoRoot) },
      longwrite: await packageVersion("packages/longwrite"),
      longexperiment: await packageVersion("packages/longexperiment"),
      research_protocol: await packageVersion("packages/research-protocol"),
      malaclaw: await commandOutput("malaclaw", ["--version"], workspace) ?? "unavailable",
    },
    runtime: {
      research_provider: (writingConfig?.research as Record<string, unknown> | undefined)?.provider,
      execution: writingConfig?.execution,
      experiment_runner: (experimentConfig?.runner as Record<string, unknown> | undefined)?.kind,
    },
    experiment: manifest ? {
      source_revision: (manifest.provenance as Record<string, unknown> | undefined)?.source_revision,
      input_revisions: (manifest.provenance as Record<string, unknown> | undefined)?.input_revisions,
      result_sha256: (manifest.provenance as Record<string, unknown> | undefined)?.result_sha256,
    } : undefined,
    checksums: outputs,
  };
  const payload = `${JSON.stringify(record, null, 2)}\n`;
  const id = `${record.created_at.replace(/[:.]/g, "-")}-${sha256(payload).slice(0, 12)}`;
  const directory = path.join(workspace, "reports", "provenance");
  await fs.mkdir(directory, { recursive: true });
  const target = path.join(directory, `${id}.json`);
  await fs.writeFile(target, payload, { encoding: "utf8", flag: "wx" });
  const indexPath = path.join(workspace, "reports", "run-provenance.json");
  type ProvenanceIndex = { version: number; records: Array<{ id: string; path: string; sha256: string; event: string; created_at: string }> };
  const prior: ProvenanceIndex = await fs.readFile(indexPath, "utf8").then((raw) => JSON.parse(raw) as ProvenanceIndex).catch(() => ({ version: 1, records: [] }));
  prior.records.push({ id, path: path.relative(workspace, target), sha256: sha256(payload), event: record.event, created_at: record.created_at });
  await fs.writeFile(indexPath, `${JSON.stringify(prior, null, 2)}\n`, "utf8");
  return path.relative(workspace, target);
}

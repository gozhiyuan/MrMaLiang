import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { canonicalJson } from "./canonical.js";
import type { MetricDefinition } from "./metrics.js";

function sha256(value: string | Buffer): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

/** Identifies the code that produced a measurement. A change of version is a
 * change of measurement even when every input is untouched. */
export function evaluatorDigest(name: string, version: string): string {
  return sha256(canonicalJson({ evaluator: name, version }));
}

/** True only for "this path does not exist". Every other failure — a
 * permission denial, an I/O error — means we could not look, which is not the
 * same as looking and finding nothing. */
function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException)?.code === "ENOENT";
}

/** Reads a dependency, or reports why the measurement cannot be identified.
 * Swallowing every error turned an unreadable file into a trusted digest for
 * content nobody looked at. */
async function readOrFail(target: string): Promise<Buffer | null> {
  try {
    return await fs.readFile(target);
  } catch (error) {
    if (isMissing(error)) return null;
    throw new Error(
      `cannot read dependency ${target}: ${(error as NodeJS.ErrnoException).code ?? String(error)}; ` +
      `an unreadable input cannot be hashed as absent`);
  }
}

async function walk(dir: string, base: string): Promise<string[]> {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch (error) {
    if (isMissing(error)) return [];
    throw new Error(`cannot list dependency directory ${dir}: ${(error as NodeJS.ErrnoException).code ?? String(error)}`);
  }
  const found: string[] = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) found.push(...await walk(full, base));
    else if (entry.isFile()) found.push(path.relative(base, full));
  }
  return found;
}

/** Hashes one declared dependency, which may be a file or a directory prefix.
 *
 * An absent input is marked absent rather than hashed as empty. The two mean
 * very different things — a corpus that was never gathered against one that was
 * gathered and found nothing — and a digest that conflated them would report a
 * measurement as fresh across exactly that change. */
async function digestOfDependency(workspaceDir: string, dependency: string): Promise<string> {
  const target = path.join(workspaceDir, dependency);
  if (dependency.endsWith("/")) {
    const files = (await walk(target, target)).sort();
    if (files.length === 0) {
      return (await fs.stat(target).catch(() => null)) === null ? "absent" : "empty-dir";
    }
    const parts: string[] = [];
    for (const file of files) {
      const content = await readOrFail(path.join(target, file));
      // Listed by the directory walk a moment ago, so a null here means it was
      // removed mid-measurement; that is a real change, recorded as one.
      parts.push(file, content === null ? "absent" : sha256(content));
    }
    return sha256(canonicalJson(parts));
  }
  // Hashed as raw bytes, never decoded first. A PDF read as UTF-8 collapses
  // every invalid sequence to the same replacement character, so two different
  // manuscripts hashed identically and a stale measurement looked fresh.
  const content = await readOrFail(target);
  return content === null ? "absent" : `present:${sha256(content)}`;
}

/** Covers declared dependencies, the registry configuration, and — for a model
 * pipeline — the prompt and model configuration. It includes the evaluation
 * date ONLY when the metric declares itself time-dependent; otherwise every
 * static measurement would invalidate daily. It never covers `raw_output`. */
export async function computeInputDigest(
  workspaceDir: string, definition: MetricDefinition,
  context: {
    asOfDate: string;
    model?: Record<string, unknown>;
    /** Instructions a model measurement was taken under. Model only. */
    promptDigest?: string;
    /** Toolchain and configuration an external measurement ran under. */
    toolchainDigest?: string;
  },
): Promise<string> {
  const parts: unknown[] = [
    definition.metric, definition.evaluator, definition.reducer, definition.scope_kind,
    definition.dependencies, definition.producer ?? null, definition.validator ?? null,
  ];
  for (const dependency of [...definition.dependencies].sort()) {
    parts.push(dependency, await digestOfDependency(workspaceDir, dependency));
  }
  if (definition.time_dependent) parts.push({ as_of_date: context.asOfDate });
  // Each measurement kind is identified by what it actually depends on.
  // Instructions belong to a model; a LaTeX build has no prompt, and demanding
  // one there would have been a fiction the caller had to invent.
  if (definition.measurement_kind === "model") {
    // Wire contract §B11: instructions are an input. Holding the model fixed
    // while rewriting the review prompt produced the same digest, so a
    // judgment taken under the old instructions was reused as if fresh.
    if (!context.promptDigest) {
      throw new Error(
        `${definition.metric} is a model measurement and needs a prompt digest; ` +
        `its identity depends on the instructions it was taken under`);
    }
    parts.push({ model: context.model ?? null, prompt: context.promptDigest });
  }
  if (definition.measurement_kind === "external") {
    if (!context.toolchainDigest) {
      throw new Error(
        `${definition.metric} is an external measurement and needs a toolchain digest; ` +
        `its identity depends on the toolchain and configuration it ran under`);
    }
    parts.push({ toolchain: context.toolchainDigest });
  }
  return sha256(canonicalJson(parts));
}

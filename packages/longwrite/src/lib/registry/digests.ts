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

async function walk(dir: string, base: string): Promise<string[]> {
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => null);
  if (entries === null) return [];
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
      parts.push(file, sha256(await fs.readFile(path.join(target, file)).catch(() => Buffer.alloc(0))));
    }
    return sha256(canonicalJson(parts));
  }
  // Hashed as raw bytes, never decoded first. A PDF read as UTF-8 collapses
  // every invalid sequence to the same replacement character, so two different
  // manuscripts hashed identically and a stale measurement looked fresh.
  const content = await fs.readFile(target).catch(() => null);
  return content === null ? "absent" : `present:${sha256(content)}`;
}

/** Covers declared dependencies, the registry configuration, and — for a model
 * pipeline — the prompt and model configuration. It includes the evaluation
 * date ONLY when the metric declares itself time-dependent; otherwise every
 * static measurement would invalidate daily. It never covers `raw_output`. */
export async function computeInputDigest(
  workspaceDir: string, definition: MetricDefinition,
  context: { asOfDate: string; model?: Record<string, unknown>; promptDigest?: string },
): Promise<string> {
  const parts: unknown[] = [
    definition.metric, definition.evaluator, definition.reducer, definition.scope_kind,
    definition.dependencies, definition.producer ?? null, definition.validator ?? null,
  ];
  for (const dependency of [...definition.dependencies].sort()) {
    parts.push(dependency, await digestOfDependency(workspaceDir, dependency));
  }
  if (definition.time_dependent) parts.push({ as_of_date: context.asOfDate });
  if (definition.measurement_kind !== "script") {
    // Wire contract §B11: instructions are an input. Holding the model fixed
    // while rewriting the review prompt produced the same digest, so a
    // judgment taken under the old instructions was reused as if fresh.
    if (!context.promptDigest) {
      throw new Error(
        `${definition.metric} is a ${definition.measurement_kind} measurement and needs a prompt digest; ` +
        `its identity depends on the instructions it was taken under`);
    }
    parts.push({ model: context.model ?? null, prompt: context.promptDigest });
  }
  return sha256(canonicalJson(parts));
}

import fs from "node:fs/promises";
import path from "node:path";

/**
 * A controlled vocabulary for the axes sources are compared along.
 *
 * Two fields in the same evidence file, written by the same model in the same
 * extraction stage, behave completely differently. On a real flagship corpus:
 *
 *   taxonomy_cells          5 configured -> 5 used, zero drift, reuse 4-18x
 *   comparison_dimensions   no registry  -> 113 strings, 111 distinct
 *
 * The difference is not the difficulty of the judgment. It is that one field
 * has a registry and the other does not: given a vocabulary the model reuses
 * it, and without one it writes a fresh phrase per claim. Free-text dimensions
 * cannot be clustered — exact matching finds nothing and term overlap recovers
 * only topic words — so nothing downstream can tell that two sources are on the
 * same axis, which is exactly what a comparison table needs to exist.
 *
 * So dimensions get what taxonomy already has. The agent still decides which
 * axes a paper is on and what each claim says; only the *label* is disciplined.
 * A new axis is proposed explicitly rather than invented silently, and is
 * promoted once enough independent sources ask for it — a deterministic,
 * script-owned rule, so vocabulary growth stays inspectable instead of drifting
 * one claim at a time.
 */
export type RegistryEntry = {
  id: string;
  label: string;
  /** Source ids whose validated claims used this axis. */
  sources: string[];
};

export type ComparisonRegistry = {
  version: 1;
  dimensions: RegistryEntry[];
  /** Proposed labels that have not yet met the promotion rule. */
  proposed: Array<{ label: string; sources: string[] }>;
};

/** Independent sources that must name an axis before it becomes vocabulary. */
export const PROMOTION_THRESHOLD = 2;

const REGISTRY_PATH = path.join("evidence", "comparison-dimensions.json");

/** A label is normalized only to derive its stable id; the human-readable form
 * is preserved as written, because the registry is meant to be read. */
export function dimensionId(label: string): string {
  return label.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60);
}

export const EMPTY_REGISTRY: ComparisonRegistry = { version: 1, dimensions: [], proposed: [] };

export async function loadComparisonRegistry(workspaceDir: string): Promise<ComparisonRegistry> {
  try {
    const parsed = JSON.parse(await fs.readFile(path.join(workspaceDir, REGISTRY_PATH), "utf-8")) as Partial<ComparisonRegistry>;
    return {
      version: 1,
      dimensions: Array.isArray(parsed.dimensions) ? parsed.dimensions : [],
      proposed: Array.isArray(parsed.proposed) ? parsed.proposed : [],
    };
  } catch {
    return { ...EMPTY_REGISTRY, dimensions: [], proposed: [] };
  }
}

type Observation = { label: string; sourceId: string };

/**
 * Fold observed labels into the registry.
 *
 * A label already in the vocabulary records its new source. A label that is not
 * accumulates as a proposal, and is promoted once `PROMOTION_THRESHOLD`
 * independent sources have named it. One source naming an axis is that source's
 * own framing; several converging on it is a shared axis, which is the only
 * kind worth a column in a comparison.
 */
export function foldObservations(registry: ComparisonRegistry, observations: Observation[]): ComparisonRegistry {
  const dimensions = registry.dimensions.map((entry) => ({ ...entry, sources: [...entry.sources] }));
  const proposed = registry.proposed.map((entry) => ({ ...entry, sources: [...entry.sources] }));
  const byId = new Map(dimensions.map((entry) => [entry.id, entry]));

  for (const { label, sourceId } of observations) {
    const trimmed = label.trim();
    if (trimmed.length === 0) continue;
    const id = dimensionId(trimmed);
    if (id.length === 0) continue;
    const existing = byId.get(id);
    if (existing) {
      if (!existing.sources.includes(sourceId)) existing.sources.push(sourceId);
      continue;
    }
    const pending = proposed.find((entry) => dimensionId(entry.label) === id);
    if (pending) {
      if (!pending.sources.includes(sourceId)) pending.sources.push(sourceId);
      continue;
    }
    proposed.push({ label: trimmed, sources: [sourceId] });
  }

  const promoted = proposed.filter((entry) => entry.sources.length >= PROMOTION_THRESHOLD);
  for (const entry of promoted) {
    dimensions.push({ id: dimensionId(entry.label), label: entry.label, sources: [...entry.sources] });
  }
  const stillProposed = proposed.filter((entry) => entry.sources.length < PROMOTION_THRESHOLD);
  dimensions.sort((left, right) => right.sources.length - left.sources.length || left.id.localeCompare(right.id));
  return { version: 1, dimensions, proposed: stillProposed };
}

type PacketFile = {
  packets?: Array<{ source_id?: unknown; claims?: Array<{ comparison_dimensions?: unknown }> }>;
};

export function observationsFromPackets(file: PacketFile): Observation[] {
  return (file.packets ?? []).flatMap((packet) => {
    const sourceId = typeof packet.source_id === "string" ? packet.source_id : undefined;
    if (!sourceId) return [];
    return (packet.claims ?? []).flatMap((claim) =>
      (Array.isArray(claim.comparison_dimensions) ? claim.comparison_dimensions : [])
        .filter((label): label is string => typeof label === "string")
        .map((label) => ({ label, sourceId })));
  });
}

async function readJson<T>(workspaceDir: string, rel: string): Promise<T | null> {
  try {
    return JSON.parse(await fs.readFile(path.join(workspaceDir, rel), "utf-8")) as T;
  } catch {
    return null;
  }
}

function markdown(registry: ComparisonRegistry): string {
  const lines = [
    "# Comparison dimensions",
    "",
    "The vocabulary for axes sources are compared along. Reuse a label from this",
    "list whenever it fits; a shared label is what lets two sources be recognized",
    "as comparable, and an axis only one source names is that source's framing",
    "rather than a comparison. Propose a new label when none fits — it is",
    `recorded immediately and joins the vocabulary once ${PROMOTION_THRESHOLD} independent sources`,
    "have named it.",
    "",
  ];
  if (registry.dimensions.length === 0) {
    lines.push("No dimension has been promoted yet.", "");
  } else {
    lines.push("| Dimension | Sources |", "| --- | ---: |");
    for (const entry of registry.dimensions) lines.push(`| ${entry.label} | ${entry.sources.length} |`);
    lines.push("");
  }
  if (registry.proposed.length > 0) {
    lines.push(`## Proposed (below the ${PROMOTION_THRESHOLD}-source threshold)`, "");
    for (const entry of registry.proposed) lines.push(`- ${entry.label} (${entry.sources.length})`);
    lines.push("");
  }
  return lines.join("\n");
}

/**
 * Rebuild the registry from the evidence that exists.
 *
 * This doubles as the migration for a workspace whose corpus predates the
 * registry: folding its existing packets produces the initial vocabulary
 * without an LLM pass, because the promotion rule already does the only
 * judgment that matters — whether several sources converged on an axis.
 */
export async function refreshComparisonRegistry(workspaceDir: string): Promise<{ registry: ComparisonRegistry; written: string[] }> {
  const registry = await loadComparisonRegistry(workspaceDir);
  const observations: Observation[] = [];
  for (const rel of [
    path.join("evidence", "active-validated-source-evidence.json"),
    path.join("evidence", "validated-source-evidence.json"),
  ]) {
    const file = await readJson<{ entries?: Array<{ packet?: PacketFile["packets"] extends undefined ? never : { source_id?: unknown; claims?: Array<{ comparison_dimensions?: unknown }> } }> }>(workspaceDir, rel);
    for (const entry of file?.entries ?? []) {
      if (entry.packet) observations.push(...observationsFromPackets({ packets: [entry.packet] }));
    }
  }
  const packets = await readJson<PacketFile>(workspaceDir, path.join("evidence", "source-packets.json"));
  if (packets) observations.push(...observationsFromPackets(packets));

  const next = foldObservations(registry, observations);
  await fs.mkdir(path.join(workspaceDir, "evidence"), { recursive: true });
  await fs.writeFile(path.join(workspaceDir, REGISTRY_PATH), `${JSON.stringify(next, null, 2)}\n`, "utf-8");
  await fs.mkdir(path.join(workspaceDir, "reports"), { recursive: true });
  await fs.writeFile(path.join(workspaceDir, "reports", "comparison-dimensions.md"), markdown(next), "utf-8");
  return { registry: next, written: ["evidence/comparison-dimensions.json", "reports/comparison-dimensions.md"] };
}

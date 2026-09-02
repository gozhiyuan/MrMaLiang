import fs from "node:fs/promises";
import path from "node:path";
import { figureManifestSchema, type FigureManifest } from "../../writing/figures.js";
import { GLOBAL_SCOPE } from "../scope.js";
import { MeasurementUnavailable, type EvaluatorContext, type EvaluatorFn, type ScopedValue } from "./corpus.js";

const global = (value: number): ScopedValue[] => [{ scope_key: GLOBAL_SCOPE, value }];

/** Absent means the figure pipeline has not run. Reporting zero figures would
 * be a claim that it ran and produced none, which a repair would answer by
 * drawing figures rather than by running the pipeline. */
async function manifest(ctx: EvaluatorContext): Promise<FigureManifest> {
  const rel = "figures/manifest.json";
  const raw = await fs.readFile(path.join(ctx.workspaceDir, rel), "utf-8").catch(() => null);
  if (raw === null) throw new MeasurementUnavailable(`${rel} is missing`);
  try {
    return figureManifestSchema.parse(JSON.parse(raw));
  } catch (error) {
    throw new Error(`${rel} is not a valid figure manifest: ${error instanceof Error ? error.message.split("\n")[0] : String(error)}`);
  }
}

/** Counts nodes that participate in at least one edge, over all declared
 * nodes. A diagram of stranded boxes is connected 0.0 however many boxes it
 * has, which is the property a reader actually notices. */
function connectivity(mermaid: string): number {
  const nodes = new Set<string>();
  const connected = new Set<string>();
  for (const line of mermaid.split("\n")) {
    const text = line.trim();
    if (text === "" || /^(graph|flowchart|subgraph|end|classDef|class|style)\b/.test(text)) continue;
    const edge = text.match(/^([A-Za-z0-9_]+)\s*(?:\[[^\]]*\]|\([^)]*\)|\{[^}]*\})?\s*-{1,2}[->|.=]*>?\s*(?:\|[^|]*\|)?\s*([A-Za-z0-9_]+)/);
    if (edge) {
      for (const id of [edge[1], edge[2]]) { nodes.add(id); connected.add(id); }
      continue;
    }
    const node = text.match(/^([A-Za-z0-9_]+)\s*(?:\[[^\]]*\]|\([^)]*\)|\{[^}]*\})/);
    if (node) nodes.add(node[1]);
  }
  return nodes.size === 0 ? 0 : connected.size / nodes.size;
}

export const ARTIFACT_EVALUATORS: Record<string, EvaluatorFn> = {
  figures: async (ctx) => global((await manifest(ctx)).figures.length),

  tables: async (ctx) => global((await manifest(ctx)).tables.length),

  comparative_tables: async (ctx) =>
    global((await manifest(ctx)).tables.filter((table) => table.comparative).length),

  /** A plot counts as verified only when its data carries recorded
   * provenance. An unsourced chart is exactly the artifact this metric exists
   * to keep out of a release. */
  verified_metadata_plots: async (ctx) =>
    global((await manifest(ctx)).figures.filter((figure) => figure.provenance !== undefined).length),

  diagram_connectivity: async (ctx) => {
    const diagrams: string[] = [];
    for (const rel of ["figures/concept-map.mmd", "figures/workflow.mmd"]) {
      const raw = await fs.readFile(path.join(ctx.workspaceDir, rel), "utf-8").catch(() => null);
      if (raw !== null) diagrams.push(raw);
    }
    if (diagrams.length === 0) throw new MeasurementUnavailable("no mermaid diagram has been generated");
    const scores = diagrams.map(connectivity);
    return global(scores.reduce((sum, score) => sum + score, 0) / scores.length);
  },

  empirical_trials: async (ctx) => {
    const rel = "evidence/experiment-packets.json";
    const raw = await fs.readFile(path.join(ctx.workspaceDir, rel), "utf-8").catch(() => null);
    if (raw === null) throw new MeasurementUnavailable(`${rel} is missing`);
    const packet = JSON.parse(raw) as { trials?: unknown[] };
    return global(Array.isArray(packet.trials) ? packet.trials.length : 0);
  },
};

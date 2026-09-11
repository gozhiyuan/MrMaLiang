import { METRIC_REGISTRY, PLANNER_SELECTABLE, metricDefinition } from "./metrics.js";
import { REGISTRY } from "./producers.js";
import { CAPABILITY_TEMPLATES } from "./capabilities.js";

/** Prompts are GENERATED from the registries, never written beside them.
 *
 * A prompt that restates policy a registry already encodes is a second copy,
 * and the two drift the moment either changes. The old mitigation was a test
 * comparing them; generation removes the possibility instead of policing it. */

/** The metrics a planner may select, with the direction and operator each one
 * takes. A metric the planner may not select is not offered at all: listing it
 * invites a criterion the kernel would then refuse. */
export function renderMetricVocabulary(): string {
  const lines = [...PLANNER_SELECTABLE]
    .map(String)
    .sort()
    .map((metric) => {
      const definition = metricDefinition(METRIC_REGISTRY.get(metric as never)!.metric);
      const operator = definition.direction === "minimize" ? "at_most" : "at_least";
      const scope = definition.scope_kind === "global" ? "global" : `scoped by ${definition.scope_kind}`;
      return `- ${metric} (${definition.target_type}, ${definition.direction}, use ${operator}, ${scope})`;
    });
  return ["Selectable acceptance metrics:", ...lines].join("\n");
}

/** Which capability repairs which (gate, artifact kind, effect) triple.
 *
 * Rendered from the routing table itself, so an added route appears here
 * without anyone remembering to mention it. */
export function renderRoutingPolicy(): string {
  const lines: string[] = [];
  for (const gate of REGISTRY.gatesOfClass("manuscript")) {
    for (const triple of REGISTRY.legalTriples(gate)) {
      const capability = String(REGISTRY.resolveCapability({
        gate, kind: triple.kind, effect: triple.effect,
      }));
      lines.push(`- ${String(gate)} / ${triple.kind} / ${triple.effect} -> ${capability}`);
    }
  }
  return [
    "Routing (gate / artifact kind / required effect -> capability):",
    ...lines.sort(),
    "",
    "Routing fails closed: a triple with no declared route goes to diagnosis. " +
    "There is no default capability, and no capability may be chosen because it seemed closest.",
    "",
    "Capability envelopes (the maximum each may ever touch):",
    ...[...CAPABILITY_TEMPLATES.values()]
      .sort((a, b) => String(a.id).localeCompare(String(b.id)))
      .map((template) => `- ${String(template.id)} owns ${template.owns.join(", ")}`),
  ].join("\n");
}

/** The planner instruction block, assembled from the registries.
 *
 * Everything a registry knows is generated; only genuinely editorial guidance
 * — how to choose between two legal routes — is written by hand. */
export function renderPlannerInstructions(): string[] {
  return [
    renderMetricVocabulary(),
    renderRoutingPolicy(),
    "Every action names at least one finding id and at least one measurable acceptance criterion. " +
    "A finding whose defect no registered metric tracks takes a verification criterion instead: " +
    "the gate that emitted it must run again and come back clean.",
    "Select the smallest sufficient set. Do not invent commands, paths, tool ids, metric names, or model settings.",
  ];
}

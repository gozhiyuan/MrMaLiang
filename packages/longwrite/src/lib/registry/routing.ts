import { gateFamily, type ArtifactKind, type CapabilityId, type GateClass, type GateId, type MetricId, type RequiredEffect } from "./ids.js";
import type { ProducerDefinition } from "./producer-types.js";

export type RouteKey = { gate: GateId; kind: ArtifactKind; effect: RequiredEffect };
export type Triple = { kind: ArtifactKind; effect: RequiredEffect };

export class UnroutedFindingError extends Error {
  constructor(readonly key: RouteKey) {
    super(`no capability owns (${key.gate}, ${key.kind}, ${key.effect}); add a route or reclassify the gate`);
    this.name = "UnroutedFindingError";
  }
}

export type Registry = {
  GATE_CLASS_TABLE: ReadonlyMap<GateId, GateClass>;
  gateClass(id: GateId): GateClass;
  gatesOfClass(cls: GateClass): GateId[];
  legalTriples(gate: GateId): readonly Triple[];
  routedTripleKeys(): Set<string>;
  resolveCapability(key: RouteKey): CapabilityId;
  /** The acceptance metric a triple moves, or null when it moves none. */
  acceptanceMetric(gate: GateId, kind: ArtifactKind, effect: RequiredEffect): MetricId | null;
  producerOf(gate: GateId): string;
  capabilities(): Set<CapabilityId>;
};

function tripleKey(gate: GateId, kind: ArtifactKind, effect: RequiredEffect): string {
  return `${gate} ${kind} ${effect}`;
}

/** Folds typed producer declarations into the class table, the legal triples
 * and the routes.
 *
 * Nothing here is authored by hand: a gate cannot acquire a legal triple
 * without acquiring its route in the same declaration, so the two cannot
 * drift. */
export function registerProducers(definitions: readonly ProducerDefinition[]): Registry {
  const classes = new Map<GateId, GateClass>();
  const triples = new Map<GateId, Triple[]>();
  const routes = new Map<string, CapabilityId>();
  const metrics = new Map<string, MetricId | null>();
  const owners = new Map<GateId, string>();

  const modules = new Set<string>();
  for (const producer of definitions) {
    if (modules.has(producer.module)) {
      throw new Error(`producer module ${producer.module} is registered more than once`);
    }
    modules.add(producer.module);
    for (const gate of producer.gates) {
      const held = owners.get(gate.id);
      if (held !== undefined) {
        // Two modules may legitimately emit one gate — `target_length` is a
        // hard gate in the research validator and an advisory check in the
        // long-form one. What must never differ is what it means, so an
        // identical re-declaration is accepted and a conflicting one is not.
        const first = { class: classes.get(gate.id), triples: triples.get(gate.id) ?? [] };
        // Capability and acceptance metric are part of what a gate MEANS.
        // Comparing only class and triples accepted two modules routing one
        // triple to different capabilities, and silently kept whichever
        // registered first — so which repair ran depended on import order.
        const declared = gate.findings.map((f) => ({
          kind: f.kind, effect: f.effect, capability: String(f.capability),
          acceptance_metric: f.acceptance_metric === null ? null : String(f.acceptance_metric),
        }));
        const held_ = (triples.get(gate.id) ?? []).map((triple) => ({
          kind: triple.kind, effect: triple.effect,
          capability: String(routes.get(tripleKey(gate.id, triple.kind, triple.effect))),
          acceptance_metric: (() => {
            const metric = metrics.get(tripleKey(gate.id, triple.kind, triple.effect));
            return metric === null || metric === undefined ? null : String(metric);
          })(),
        }));
        const same = first.class === gate.class
          && JSON.stringify(held_) === JSON.stringify(declared);
        if (!same) {
          throw new Error(
            `gate ${gate.id} is declared differently by ${held} and ${producer.module}; ` +
            `a gate means one thing or it is two gates`);
        }
        continue;
      }
      owners.set(gate.id, producer.module);
      classes.set(gate.id, gate.class);
      if (gate.findings.length > 0) {
        triples.set(gate.id, gate.findings.map((finding) => ({ kind: finding.kind, effect: finding.effect })));
        for (const finding of gate.findings) {
          routes.set(tripleKey(gate.id, finding.kind, finding.effect), finding.capability);
          metrics.set(tripleKey(gate.id, finding.kind, finding.effect), finding.acceptance_metric);
        }
      }
    }
  }

  function gateClass(id: GateId): GateClass {
    const found = classes.get(gateFamily(id));
    if (!found) throw new Error(`unclassified gate: ${id}. Declare it on its producer.`);
    return found;
  }

  return {
    GATE_CLASS_TABLE: classes,
    gateClass,
    gatesOfClass: (cls) => [...classes.entries()].filter(([, value]) => value === cls).map(([key]) => key),
    legalTriples: (gate) => triples.get(gateFamily(gate)) ?? [],
    routedTripleKeys: () => new Set(routes.keys()),
    /** No default. An unresolved triple escalates to diagnosis; a gate added
     * later cannot silently land on prose revision. */
    resolveCapability: (key) => {
      const found = routes.get(tripleKey(gateFamily(key.gate), key.kind, key.effect));
      if (!found) throw new UnroutedFindingError(key);
      return found;
    },
    producerOf: (gate) => {
      const found = owners.get(gateFamily(gate));
      if (!found) throw new Error(`unclassified gate: ${gate}. Declare it on its producer.`);
      return found;
    },
    acceptanceMetric: (gate, kind, effect) => {
      const key = tripleKey(gateFamily(gate), kind, effect);
      if (!metrics.has(key)) throw new UnroutedFindingError({ gate, kind, effect });
      return metrics.get(key) ?? null;
    },
    capabilities: () => new Set(routes.values()),
  };
}

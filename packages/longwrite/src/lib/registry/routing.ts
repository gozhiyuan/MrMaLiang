import { gateFamily, type ArtifactKind, type CapabilityId, type GateClass, type GateId, type MetricId, type RequiredEffect } from "./ids.js";
import type { GateDefinition, ProducerDefinition } from "./producer-types.js";

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
  /** Every acceptance metric this gate may attach to that triple.
   *
   * A set, not a value. One triple can serve several objectives: a corpus that
   * is too small, too old and too preprint-heavy all repair through
   * `corpus / upgrade_source_quality`, but they are three different
   * objectives. Returning a single metric forced every such failure onto
   * whichever one happened to be declared first. */
  acceptanceMetrics(gate: GateId, kind: ArtifactKind, effect: RequiredEffect): ReadonlySet<MetricId | null>;
  producerOf(gate: GateId): string;
  capabilities(): Set<CapabilityId>;
};

function tripleKey(gate: GateId, kind: ArtifactKind, effect: RequiredEffect): string {
  return `${gate} ${kind} ${effect}`;
}

/** Everything that makes a gate declaration mean what it means: its class and
 * every four-tuple it can emit. Two modules may emit one gate, but only if
 * they agree on all of this. */
function declarationOf(gate: GateDefinition): string {
  const findings = gate.findings
    .map((finding) => `${finding.kind}|${finding.effect}|${String(finding.capability)}|${finding.acceptance_metric ?? "null"}`)
    .sort();
  return JSON.stringify({ class: gate.class, findings });
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
  const metrics = new Map<string, Set<MetricId | null>>();
  const owners = new Map<GateId, string>();
  const declarations = new Map<GateId, string>();

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
        // Capability and acceptance metric are part of what a gate MEANS.
        // Comparing only class and triples accepted two modules routing one
        // triple to different capabilities, and silently kept whichever
        // registered first — so which repair ran depended on import order.
        const same = declarations.get(gate.id) === declarationOf(gate);
        if (!same) {
          throw new Error(
            `gate ${gate.id} is declared differently by ${held} and ${producer.module}; ` +
            `a gate means one thing or it is two gates`);
        }
        continue;
      }
      owners.set(gate.id, producer.module);
      declarations.set(gate.id, declarationOf(gate));
      classes.set(gate.id, gate.class);
      if (gate.findings.length > 0) {
        const seen = new Set<string>();
        triples.set(gate.id, gate.findings
          .map((finding) => ({ kind: finding.kind, effect: finding.effect }))
          .filter((triple) => {
            const key = `${triple.kind} ${triple.effect}`;
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
          }));
        for (const finding of gate.findings) {
          const key = tripleKey(gate.id, finding.kind, finding.effect);
          const owner = routes.get(key);
          if (owner !== undefined && owner !== finding.capability) {
            throw new Error(
              `gate ${gate.id} routes (${finding.kind}, ${finding.effect}) to both ${owner} and ` +
              `${finding.capability}; one triple has one owner`);
          }
          routes.set(key, finding.capability);
          metrics.set(key, (metrics.get(key) ?? new Set()).add(finding.acceptance_metric));
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
    acceptanceMetrics: (gate, kind, effect) => {
      const found = metrics.get(tripleKey(gateFamily(gate), kind, effect));
      if (!found) throw new UnroutedFindingError({ gate, kind, effect });
      return found;
    },
    capabilities: () => new Set(routes.values()),
  };
}

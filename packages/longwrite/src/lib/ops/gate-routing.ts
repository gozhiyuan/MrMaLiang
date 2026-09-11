import { REGISTRY } from "../registry/producers.js";
import { gateFamily, gateId } from "../registry/ids.js";

/** Which capabilities the REGISTRY says may repair a gate's findings.
 *
 * This replaces a hand-maintained table that answered the same question a
 * second time. The table's real defect was not duplication but its default: an
 * unknown gate routed to prose revision, so a gate nobody had classified was
 * silently handed to a chapter editor — including evidence-acquisition and
 * build defects it cannot touch. Here an unrouted gate resolves to nothing, and
 * the caller has to say what that means. */
export function capabilitiesForGate(id: string): Set<string> {
  const gate = gateId(gateFamily(gateId(id)));
  const owners = new Set<string>();
  for (const triple of REGISTRY.legalTriples(gate)) {
    owners.add(String(REGISTRY.resolveCapability({ gate, kind: triple.kind, effect: triple.effect })));
  }
  return owners;
}

/** The capability the registry says owns most of a gate's declared repairs.
 *
 * Retained only for the ownership assertions below. It is NOT a routing
 * decision: a gate that legally routes to several capabilities is
 * disambiguated by the FINDING — its artifact kind and required effect resolve
 * exactly one — and a gate-level preference is a guess standing in for a
 * finding the caller does not have yet. */
export function preferredCapabilityForGate(id: string): string | null {
  const gate = gateId(gateFamily(gateId(id)));
  const counts = new Map<string, number>();
  for (const triple of REGISTRY.legalTriples(gate)) {
    const capability = String(REGISTRY.resolveCapability({ gate, kind: triple.kind, effect: triple.effect }));
    counts.set(capability, (counts.get(capability) ?? 0) + 1);
  }
  const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  return ranked[0]?.[0] ?? null;
}

/** Is this capability allowed to repair this gate's findings?
 *
 * Ownership only. There is deliberately no `preferred` here: a gate that
 * legally routes to several capabilities is disambiguated by the FINDING —
 * its artifact kind and required effect resolve exactly one — and a
 * gate-level preference is a guess standing in for a finding the caller does
 * not yet have. See the retirement note in docs for what has to land before
 * the last gate-level callers can go. */
export function gateOwnedByCapability(id: string, capability: string): boolean {
  return capabilitiesForGate(id).has(capability);
}

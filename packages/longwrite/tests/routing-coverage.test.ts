import { afterAll, describe, expect, it } from "vitest";
import { PRODUCERS, REGISTRY } from "../src/lib/registry/producers.js";
import { gateFamily, gateId } from "../src/lib/registry/ids.js";
import { cleanupProbeWorkspaces, probeProducer } from "./helpers/producer-probe.js";

afterAll(cleanupProbeWorkspaces);

describe("routing coverage", () => {
  it("routes every legal triple of every manuscript gate", () => {
    const routed = REGISTRY.routedTripleKeys();
    const unrouted: string[] = [];
    for (const gate of REGISTRY.gatesOfClass("manuscript")) {
      const triples = REGISTRY.legalTriples(gate);
      if (triples.length === 0) { unrouted.push(`${gate} (no findings declared)`); continue; }
      for (const triple of triples) {
        if (!routed.has(`${gate} ${triple.kind} ${triple.effect}`)) {
          unrouted.push(`${gate}/${triple.kind}/${triple.effect}`);
        }
      }
    }
    expect(unrouted.sort(), `unrouted: ${unrouted.join(", ")}`).toEqual([]);
  });

  it("declares no findings for a non-manuscript gate", () => {
    for (const cls of ["environment", "measurement"] as const) {
      for (const gate of REGISTRY.gatesOfClass(cls)) {
        expect(REGISTRY.legalTriples(gate), String(gate)).toEqual([]);
      }
    }
  });

  it("emits only gate ids its producer declared", async () => {
    for (const producer of PRODUCERS) {
      const emitted = await probeProducer(producer.module);
      const declared = new Set(producer.gates.map((gate) => String(gate.id)));
      const undeclared = [...new Set(emitted.gateIds.map((id) => String(gateFamily(gateId(id)))))]
        .filter((family) => !declared.has(family)).sort();
      expect(undeclared, `${producer.module} emits undeclared gates: ${undeclared.join(", ")}`).toEqual([]);
    }
  });

  it("emits only findings its producer declared", async () => {
    for (const producer of PRODUCERS) {
      const emitted = await probeProducer(producer.module);
      const undeclared: string[] = [];
      for (const finding of emitted.findings) {
        const gate = gateId(String(finding.gate_id));
        const artifact = finding.artifact as { kind?: string } | undefined;
        const legal = REGISTRY.legalTriples(gate);
        if (!legal.some((t) => t.kind === artifact?.kind && t.effect === finding.required_effect)) {
          undeclared.push(`${gate}/${artifact?.kind}/${String(finding.required_effect)}`);
        }
      }
      expect(undeclared.sort(), `${producer.module}: ${undeclared.join(", ")}`).toEqual([]);
    }
  });

  it("resolves a capability for every finding a producer actually emits", async () => {
    for (const producer of PRODUCERS) {
      for (const finding of (await probeProducer(producer.module)).findings) {
        const artifact = finding.artifact as { kind: never };
        expect(() => REGISTRY.resolveCapability({
          gate: gateId(String(finding.gate_id)),
          kind: artifact.kind,
          effect: finding.required_effect as never,
        }), `${producer.module}/${String(finding.id)}`).not.toThrow();
      }
    }
  });

  it("drives EVERY producer, so no producer is silently unexercised", async () => {
    // Requiring one producer globally was too weak: research, survey-contract
    // and preflight each threw and emitted nothing while this passed, leaving
    // the largest producer entirely unchecked.
    const silent: string[] = [];
    for (const producer of PRODUCERS) {
      const emitted = await probeProducer(producer.module);
      if (emitted.gateIds.length === 0) {
        silent.push(`${producer.module}${emitted.error ? ` (threw: ${emitted.error})` : " (emitted nothing)"}`);
      }
    }
    expect(silent, `producers not exercised by the probe:\n  ${silent.join("\n  ")}`).toEqual([]);
  });

  it("reports a producer that could not run at all", async () => {
    const failed: string[] = [];
    for (const producer of PRODUCERS) {
      const emitted = await probeProducer(producer.module);
      if (emitted.error) failed.push(`${producer.module}: ${emitted.error}`);
    }
    expect(failed, `producers that threw:\n  ${failed.join("\n  ")}`).toEqual([]);
  });

  it("emits an acceptance metric on every finding, matching what was declared", async () => {
    for (const producer of PRODUCERS) {
      for (const finding of (await probeProducer(producer.module)).findings) {
        const artifact = finding.artifact as { kind: never };
        expect(finding, `${producer.module}/${String(finding.id)}`).toHaveProperty("acceptance_metric");
        // Must be one the producer declared for this exact triple, not merely
        // some metric: a compound gate declares several.
        expect([...REGISTRY.acceptanceMetrics(gateId(String(finding.gate_id)), artifact.kind, finding.required_effect as never)],
          `${producer.module}/${String(finding.id)}`).toContain(finding.acceptance_metric ?? null);
      }
    }
  });
});

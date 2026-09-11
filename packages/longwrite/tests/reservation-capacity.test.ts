import { describe, expect, it } from "vitest";
import {
  planCapacity, assertAccounting, applyExclusions, CapacityInfeasible, ReservationViolation,
} from "../src/lib/research/reservation.js";
import { TargetRecord } from "../src/lib/research/targets.js";

describe("capacity planning", () => {
  it("reserves every target when capacity allows", () => {
    const plan = planCapacity({ selector: "semantic_screen", reserved: ["s1", "s2"], capacity: 5 });
    expect(plan.reserved).toEqual(["s1", "s2"]);
    expect(plan.free_slots).toBe(3);
    expect(plan.infeasible).toBe(false);
  });

  it("leaves no free slots when reservations exactly fill capacity", () => {
    expect(planCapacity({ selector: "semantic_screen", reserved: ["s1", "s2"], capacity: 2 }).free_slots).toBe(0);
  });

  it("reports infeasibility rather than silently truncating", () => {
    // The existing taxonomy reserve is guarded by `selected.size < max`, so
    // over-subscribed reserves vanish. That is the same disappearance the
    // reservation invariant exists to prevent, one layer up.
    const plan = planCapacity({ selector: "semantic_screen", reserved: ["s1", "s2", "s3"], capacity: 2 });
    expect(plan.infeasible).toBe(true);
    expect(plan.detail).toMatch(/3 reserved targets exceed capacity 2/);
  });

  it("names the selector and the shortfall so the pause is actionable", () => {
    const plan = planCapacity({ selector: "fulltext_ingest", reserved: ["a", "b", "c"], capacity: 1 });
    expect(plan.detail).toMatch(/fulltext_ingest/);
  });

  it("throws CapacityInfeasible before any work when asked to enforce", () => {
    expect(() => planCapacity({ selector: "semantic_screen", reserved: ["s1", "s2", "s3"], capacity: 2, enforce: true }))
      .toThrow(CapacityInfeasible);
  });
});

describe("reservation accounting", () => {
  const base = { selector: "semantic_screen", reservedIn: ["s1", "s2", "s3"] };

  it("passes when every reserved target is selected", () => {
    expect(() => assertAccounting({ ...base, selected: ["s1", "s2", "s3"], excluded: [] })).not.toThrow();
  });

  it("passes when the remainder is explicitly excluded with a reason", () => {
    expect(() => assertAccounting({
      ...base, selected: ["s1"],
      excluded: [
        { source_id: "s2", reason: "fulltext_unavailable", detail: "no open access copy" },
        { source_id: "s3", reason: "duplicate_canonical_target", detail: "same DOI as s1" },
      ],
    })).not.toThrow();
  });

  it("fails when a reserved target is silently dropped", () => {
    expect(() => assertAccounting({ ...base, selected: ["s1"], excluded: [] }))
      .toThrow(ReservationViolation);
  });

  it("names the vanished targets", () => {
    try {
      assertAccounting({ ...base, selected: ["s1"], excluded: [] });
    } catch (error) {
      expect((error as Error).message).toMatch(/s2/);
      expect((error as Error).message).toMatch(/s3/);
    }
  });

  it("fails when a target is both selected and excluded", () => {
    expect(() => assertAccounting({
      ...base, selected: ["s1", "s2", "s3"],
      excluded: [{ source_id: "s2", reason: "policy_rejection", detail: "out of scope" }],
    })).toThrow(/both selected and excluded/);
  });

  it("ignores unreserved targets entirely", () => {
    expect(() => assertAccounting({
      selector: "semantic_screen", reservedIn: [], selected: ["x1"], excluded: [],
    })).not.toThrow();
  });
});

describe("applying exclusions to the ledger", () => {
  const record = (target_key: string, source_id: string | null) => TargetRecord.parse({
    target_key, source_id, status: "retrieved", reserved: true, history: [],
  });

  it("records the typed reason on the matching target", () => {
    const [updated] = applyExclusions([record("landmark:bert", "s1")],
      [{ source_id: "s1", reason: "fulltext_unavailable", detail: "paywalled" }]);
    expect(updated.exclusion?.reason).toBe("fulltext_unavailable");
    expect(updated.exclusion?.detail).toBe("paywalled");
  });

  it("leaves an unresolved target alone rather than matching it by accident", () => {
    // An unresolved target has no source id; matching it against an exclusion
    // keyed by source id would exclude an arbitrary pending target.
    const [updated] = applyExclusions([record("landmark:bert", null)],
      [{ source_id: "s1", reason: "policy_rejection", detail: "out of scope" }]);
    expect(updated.exclusion).toBeUndefined();
  });
});

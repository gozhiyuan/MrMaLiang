import { describe, expect, it } from "vitest";
import { connectedComponents, isFullyConnected } from "../src/lib/research/diagram-connectivity.js";

describe("connectedComponents", () => {
  it("reports one component for a fully connected loop", () => {
    const spec = {
      nodes: [{ id: "a", label: "A" }, { id: "b", label: "B" }, { id: "c", label: "C" }],
      edges: [{ from: "a", to: "b" }, { from: "b", to: "c" }, { from: "c", to: "a" }],
    };
    expect(connectedComponents(spec)).toHaveLength(1);
    expect(isFullyConnected(spec)).toBe(true);
  });

  it("reports two components for the real short-rsi-survey Figure 1 shape: two disconnected pairs", () => {
    const spec = {
      nodes: [
        { id: "artifact", label: "Artifact / procedure" },
        { id: "iteration", label: "Iteration / state" },
        { id: "evaluation", label: "Evaluation / selection" },
        { id: "later_use", label: "Documented later use" },
      ],
      edges: [
        { from: "artifact", to: "evaluation" },
        { from: "iteration", to: "later_use" },
      ],
    };
    const components = connectedComponents(spec);
    expect(components).toHaveLength(2);
    expect(isFullyConnected(spec)).toBe(false);
  });

  it("treats an isolated node with no edges as its own component", () => {
    const spec = { nodes: [{ id: "a", label: "A" }, { id: "b", label: "B" }], edges: [] };
    expect(connectedComponents(spec)).toHaveLength(2);
  });
});

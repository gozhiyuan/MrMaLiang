import { describe, expect, it } from "vitest";
import { validateTeamRoster } from "../src/lib/teams.js";
describe("self-organizing research rosters", () => {
  it("accepts bounded, catalog-bound roles and rejects an unbounded tool request", () => {
    const roster = { version: 1, objective: "Challenge the proposed cache optimization mechanism.", rationale: "Separate evidence gathering from adversarial review.", roles: [
      { id: "researcher", responsibility: "Collect implementation and benchmark evidence.", max_instances: 2, allowed_actions: ["search"] },
      { id: "critic", responsibility: "Identify confounds and falsification tests.", max_instances: 1, allowed_actions: ["review"] },
    ] };
    expect(validateTeamRoster(roster, ["search", "review"])).toMatchObject({ version: 1 });
    expect(() => validateTeamRoster({ ...roster, roles: [...roster.roles, { id: "operator", responsibility: "Run arbitrary commands beyond the envelope.", max_instances: 1, allowed_actions: ["shell"] }] }, ["search", "review"])).toThrow(/undeclared action/);
  });
});

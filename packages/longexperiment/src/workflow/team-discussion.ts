/** A bounded proposal discussion. It produces plans/critique artifacts only;
 * compute stays outside this loop and remains subject to normal approvals. */
export function teamDiscussionStages(): Array<Record<string, unknown>> {
  return [{
    id: "form_research_team", title: "Form a bounded research discussion roster", owner: "experiment-lead",
    inputs: ["experiment.yaml"], outputs: ["runs/research-team.json"], validators: ["required_output_exists"],
    instructions: ["Write a schema-valid finite roster with a critic. Do not launch workers or modify candidate code."],
  }, {
    id: "research_team_discussion", title: "Generate and critique bounded proposals", owner: "experiment-lead",
    inputs: ["runs/research-team.json", "runs/lineage.json"], outputs: ["runs/proposals.json", "runs/proposal-critiques.json"], validators: ["required_output_exists"],
    instructions: ["Each proposal needs a non-author critique. This stage may create no candidates and schedule no compute."],
  }];
}

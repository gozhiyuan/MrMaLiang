/** Claim extraction is an authoring step only. Deterministic reconciliation
 * rejects any anchor quote that is absent from the selected paper text before
 * a claim can reach compute. */
export function claimExtractionStages(command: (args: string[]) => { cmd: string; args: string[] }): Array<Record<string, unknown>> {
  return [
    {
      id: "extract_claims",
      title: "Extract anchored reproduction claims from the selected paper",
      owner: "experiment-lead",
      inputs: ["paper/source.json", "paper/text.txt"],
      instructions: [
        "Write ONLY reproduction/claims-candidates.json. Every claim must quote an exact passage from paper/text.txt and identify its section/page/figure/table when available.",
        "Use the ReproductionClaim schema. Do not import claims from related papers, code READMEs, reviews, or memory; uncertain claims must be marked unknown or blocked.",
      ],
      outputs: ["reproduction/claims-candidates.json"],
      validators: ["required_output_exists"],
    },
    {
      id: "reconcile_claims",
      title: "Reject unanchored or cross-paper reproduction claims",
      owner: "result-auditor",
      inputs: ["paper/text.txt", "reproduction/claims-candidates.json"],
      outputs: ["reproduction/claims.json"],
      runtime: "script",
      command: command(["stage", "reconcile-claims", "."]),
      validators: ["required_output_exists"],
    },
  ];
}

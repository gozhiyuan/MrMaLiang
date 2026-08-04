import { longwriteCommand, type AgenticContext, type StageRecord, type Workflow } from "./base.js";
import { agentStage, foreachStage, loopStage, scriptStage } from "malaclaw/sdk";

/**
 * The metadata → full-text → validated-evidence bridge.
 *
 * Retrieval alone produces citations with no support behind them. This module
 * inserts the screening/extraction/finalization chain that turns candidate
 * metadata into evidence-backed A/B depth, plus a bounded recovery loop that
 * runs when the deterministic corpus gates fail.
 *
 * Non-negotiable: an excerpt is an exact contiguous run copied from locally
 * retrieved full text. Depth is finalized by a script, never by the model that
 * proposed it.
 */

/** Insert screening after classify and the evidence chain after evidence_index. */
export function insertSemanticEvidenceBridge(next: Workflow, ctx: AgenticContext): void {
  const policy = ctx.policy!;
  const classifyIndex = next.stages.findIndex((stage) => stage.id === "classify");
  const evidenceIndex = next.stages.findIndex((stage) => stage.id === "evidence_index");
  if (classifyIndex < 0 || evidenceIndex < 0) throw new Error("auto_research_agentic requires classify and evidence_index stages for semantic screening");
  const semanticStages: StageRecord[] = [
    scriptStage({
      id: "semantic_candidate_select",
      title: "Select bounded abstract-screening candidates",
      owner: "analyst",
      inputs: ["sources/classified_sources.jsonl", "sources/search-plan.json"],
      outputs: ["sources/semantic-screening-candidates.json", "sources/metadata-classified_sources.jsonl"],
      validators: ["required_output_exists"], runtime: "script",
      command: longwriteCommand(["research", "select-semantic-candidates", "."]),
    }),
    agentStage({
      id: "semantic_screen",
      title: "Screen bounded candidates from titles and abstracts",
      owner: "analyst",
      inputs: ["sources/semantic-screening-candidates.json"],
      skills: ["sources/semantic-screening-candidates.json"],
      instructions: [
        "Read only the bounded candidate metadata in sources/semantic-screening-candidates.json. Write ONLY sources/semantic-screening.json as {version:1,screenings:[{source_id,taxonomy_cells,chapter_role,semantic_relevance,rationale,recommended_depth,fulltext_priority}]}.",
        "This is abstract-level semantic triage, not a claim-evidence judgment. Assess every candidate; source_id and taxonomy_cells must come from the supplied artifact/configuration. Do not invent findings, quotes, pages, venues, acceptance status, or source IDs.",
        "Use these exact enums: chapter_role is protagonist, comparison, background, or exclude; semantic_relevance is high, medium, or low; recommended_depth is A, B, C, or D (use D—not none—for excluded material); fulltext_priority is the JSON boolean true or false (never high, medium, low, null, or a string). An excluded source must set fulltext_priority false. Use A/B only when the abstract indicates a central/comparative role; final A/B still requires validated full-text evidence.",
      ],
      outputs: ["sources/semantic-screening.json", "reports/semantic-screen-repair.md"], validators: ["required_output_exists"],
      validator_commands: [longwriteCommand(["research", "repair-semantic-screen", "."])],
      retry: { max_attempts: 2 },
    }),
  ];
  next.stages.splice(classifyIndex + 1, 0, ...semanticStages);
  // Core-source count is meaningful only after provisional metadata A/B has
  // been reconciled with the evidence packet contract. Keep all broad
  // retrieval stages ahead of screening, but measure corpus gates on the
  // final classification that the manuscript will actually use.
  const corpusGateIndex = next.stages.findIndex((stage) => stage.id === "corpus_gates");
  const corpusGate = corpusGateIndex >= 0 ? next.stages.splice(corpusGateIndex, 1)[0] : undefined;
  const refreshedEvidenceIndex = next.stages.findIndex((stage) => stage.id === "evidence_index");
  next.stages.splice(refreshedEvidenceIndex + 1, 0,
    scriptStage({
      id: "source_evidence_candidate_select",
      title: "Select approved full-text sources for claim extraction",
      owner: "source-curator", inputs: ["sources/semantic-screening.json", "fulltext/manifest.json", "sources/classified_sources.jsonl"],
      outputs: ["sources/source-evidence-candidates.json"], validators: ["required_output_exists"], runtime: "script",
      command: longwriteCommand(["research", "select-source-evidence-candidates", "."]),
    }),
    agentStage({
      id: "source_evidence_extract",
      title: "Extract source-level evidence from retrieved full text",
      owner: "analyst",
      inputs: ["sources/source-evidence-candidates.json", "evidence/chunks.jsonl"],
      optional_inputs: ["fulltext/*.md"],
      skills: ["sources/source-evidence-candidates.json", "evidence/chunks.jsonl", "fulltext/*.md"],
      instructions: [
        "Read only the approved candidates and their retrieved full-text evidence. Write ONLY evidence/source-packets.json as {version:1,packets:[{source_id,recommended_depth,claims:[{claim,supporting_excerpt,locator,comparison_dimensions,limitations}]}]}. comparison_dimensions must reuse a label from evidence/comparison-dimensions.json whenever one fits: a shared label is what lets two sources be recognized as being on the same axis, and an axis only one source names is that source's framing rather than a comparison. Write a new label only when none fits; it is recorded as a proposal and joins the vocabulary once a second source independently names it. Do not restate a claim as a dimension — a dimension is the axis, not the finding.",
        "Create packets only for sources listed in sources/source-evidence-candidates.json. supporting_excerpt must copy an exact contiguous run of at least four normalized words from the local retrieved full text; locator identifies its section/paragraph. Faithfully summarize supported claims, comparison dimensions, and limitations. Do not invent findings, quotes, page numbers, experiments, or sources.",
        "A-level recommendation needs at least two independently useful supported claims; B needs at least one. Omit a source rather than fabricate support. The validator checks every excerpt against the retrieved text before accepting this attempt and controls final A/B depth.",
      ],
      outputs: ["evidence/source-packets.json", "evidence/validated-source-evidence.json", "reports/source-evidence-repair.md"], validators: ["required_output_exists"],
      validator_commands: [longwriteCommand(["research", "repair-source-evidence", "."])], retry: { max_attempts: 2 },
    }),
    scriptStage({
      id: "finalize_evidence_depth",
      title: "Finalize citation depth from semantic and full-text evidence",
      owner: "analyst", inputs: ["sources/metadata-classified_sources.jsonl", "sources/semantic-screening.json", "evidence/source-packets.json", "evidence/validated-source-evidence.json"],
      outputs: ["sources/classified_sources.jsonl", "sources/bibliography.bib", "sources/citation_plan.jsonl", "evidence/active-validated-source-evidence.json", "reports/evidence-depth-finalization.md"],
      validators: ["required_output_exists", "jsonl_parseable"], runtime: "script",
      command: longwriteCommand(["research", "finalize-evidence-depth", "."]),
    }),
    scriptStage({
      id: "corpus_gate_assessment",
      title: "Measure final evidence-backed corpus coverage before recovery",
      owner: "source-curator", inputs: ["sources/classified_sources.jsonl", "sources/search-plan.json"],
      outputs: ["reports/corpus-gates.json", "reports/corpus-gates.md", "reports/metrics.json"], validators: ["required_output_exists"], runtime: "script",
      command: longwriteCommand(["research", "corpus-gates", ".", "--advisory"]),
    }),
    loopStage({
        id: "corpus_evidence_recovery_loop",
      title: "Recover missing validated core evidence before outlining",
      max_rounds: 2,
      stop_when: "corpus_gate_pass >= 1",
      on_exhaustion: "fail",
      stages: [
        {
          id: "corpus_recovery_plan",
          title: "Plan one bounded evidence recovery from failed corpus gates",
          owner: "analyst", when: "corpus_gate_pass < 1",
          inputs: ["reports/corpus-gates.json", "reports/corpus-gates.md", "sources/semantic-screening.json", "fulltext/manifest.json", "reports/evidence-depth-finalization.md"],
          skills: ["reports/corpus-gates.md", "sources/semantic-screening.json", "sources/source-evidence-candidates.json", "fulltext/manifest.json", "reports/evidence-depth-finalization.md"],
          instructions: [
            "Read the failed deterministic corpus-gate report and the current semantic/full-text evidence records. Write ONLY reports/corpus-recovery-plan.json as an AgenticActionPlan object: {version:1,findings:[{id,severity,summary}],actions:[{id,tool,finding_ids,rationale,acceptance_criteria:[{metric,target,scope?}]}]}.",
            "Select exactly one action: tool=targeted_research_expansion. Its finding_ids may name only failed IDs from reports/corpus-gates.json. It must include core_sources with target at least the configured gate. Diagnose why potential A/B sources failed to become evidence-backed (taxonomy coverage, semantic triage, open full-text availability, or insufficient support), and name focused retrieval terms/venues/source types in the finding summary so the bounded deterministic expansion can derive queries.",
            "Do not lower any gate, widen scope into generic bibliography growth, invent sources/claims/URLs, or select outline/prose/visual actions. This is a two-round evidence recovery, not a request to draft the paper.",
          ],
          outputs: ["reports/corpus-recovery-plan.json"], validators: ["required_output_exists"],
          validator_commands: [longwriteCommand(["research", "repair-corpus-recovery-plan", "."])], retry: { max_attempts: 2 },
        },
        {
          id: "corpus_recovery_expand",
          title: "Expand research through the validated recovery plan",
          owner: "source-curator", when: "corpus_gate_pass < 1",
          inputs: ["reports/corpus-recovery-plan.json"], outputs: ["reports/research-expansion.md", "sources/semantic-screening-candidates.json"], validators: ["required_output_exists"], runtime: "script",
          command: longwriteCommand(["research", "expand", ".", "--action-plan", "reports/corpus-recovery-plan.json"]),
        },
        {
          id: "corpus_recovery_semantic_screen",
          title: "Re-screen expanded candidates for evidence recovery",
          owner: "analyst", when: "corpus_gate_pass < 1",
          inputs: ["sources/semantic-screening-candidates.json"], skills: ["sources/semantic-screening-candidates.json", "reports/corpus-gates.md"],
          instructions: [
            "Read only the bounded candidate metadata and current corpus-gate report. Write ONLY sources/semantic-screening.json as {version:1,screenings:[{source_id,taxonomy_cells,chapter_role,semantic_relevance,rationale,recommended_depth,fulltext_priority}]}. Reassess every supplied candidate using title/abstract evidence.",
            "Use exactly: chapter_role protagonist|comparison|background|exclude; semantic_relevance high|medium|low; recommended_depth A|B|C|D; fulltext_priority true|false. Prioritize open, directly relevant sources that can close the named gate, but do not promote a source without abstract support. Final A/B still requires validated full-text evidence.",
          ],
          outputs: ["sources/semantic-screening.json", "reports/semantic-screen-repair.md"], validators: ["required_output_exists"],
          validator_commands: [longwriteCommand(["research", "repair-semantic-screen", "."])], retry: { max_attempts: 2 },
        },
        {
          id: "corpus_recovery_fulltext",
          title: "Ingest full text selected by recovered semantic screening",
          owner: "source-curator", when: "corpus_gate_pass < 1",
          inputs: ["sources/semantic-screening.json", "sources/classified_sources.jsonl"], outputs: ["fulltext/manifest.json"], validators: ["required_output_exists"], runtime: "script",
          command: longwriteCommand(["research", "fulltext", ".", "--max-sources", String(policy.fulltextMaxSources), ...(policy.allowPdfDownload === false ? ["--no-pdf-download"] : [])]),
        },
        {
          id: "corpus_recovery_evidence_index",
          title: "Rebuild the evidence index after corpus recovery",
          owner: "source-curator", when: "corpus_gate_pass < 1",
          inputs: ["fulltext/manifest.json"], outputs: ["evidence/chunks.jsonl", "evidence/index.sqlite"], validators: ["required_output_exists"], runtime: "script",
          command: longwriteCommand(["evidence", "index", "."]),
        },
        {
          id: "corpus_recovery_source_candidate_select",
          title: "Select recovered full-text sources for claim extraction",
          owner: "source-curator", when: "corpus_gate_pass < 1",
          inputs: ["sources/semantic-screening.json", "fulltext/manifest.json", "sources/classified_sources.jsonl"], outputs: ["sources/source-evidence-candidates.json"], validators: ["required_output_exists"], runtime: "script",
          command: longwriteCommand(["research", "select-source-evidence-candidates", "."]),
        },
        {
          id: "corpus_recovery_source_evidence_extract",
          title: "Extract validated evidence from recovered full text",
          owner: "analyst", when: "corpus_gate_pass < 1",
          inputs: ["sources/source-evidence-candidates.json", "evidence/chunks.jsonl"], optional_inputs: ["fulltext/*.md"], skills: ["sources/source-evidence-candidates.json", "evidence/chunks.jsonl", "fulltext/*.md"],
          instructions: [
            "Write ONLY evidence/source-packets.json as {version:1,packets:[{source_id,recommended_depth,claims:[{claim,supporting_excerpt,locator,comparison_dimensions,limitations}]}]}. Use only supplied candidate IDs and exact contiguous excerpts of at least four normalized words from local retrieved full text. Omit unsupported sources; do not invent claims, pages, results, or citations. comparison_dimensions must reuse a label from evidence/comparison-dimensions.json whenever one fits: a shared label is what lets two sources be recognized as being on the same axis, and an axis only one source names is that source's framing rather than a comparison. Write a new label only when none fits; it is recorded as a proposal and joins the vocabulary once a second source independently names it. Do not restate a claim as a dimension — a dimension is the axis, not the finding.",
            "A-level recommendation needs at least two independently useful supported claims; B needs at least one. Explain comparison dimensions and limitations faithfully so the deterministic validator can finalize citation depth.",
          ],
          outputs: ["evidence/source-packets.json", "evidence/validated-source-evidence.json", "reports/source-evidence-repair.md"], validators: ["required_output_exists"],
          validator_commands: [longwriteCommand(["research", "repair-source-evidence", "."])], retry: { max_attempts: 2 },
        },
        {
          id: "corpus_recovery_finalize_evidence_depth",
          title: "Finalize recovered citation depth from validated evidence",
          owner: "analyst", when: "corpus_gate_pass < 1",
          inputs: ["sources/metadata-classified_sources.jsonl", "sources/semantic-screening.json", "evidence/source-packets.json", "evidence/validated-source-evidence.json"],
          outputs: ["sources/classified_sources.jsonl", "sources/bibliography.bib", "sources/citation_plan.jsonl", "evidence/active-validated-source-evidence.json", "reports/evidence-depth-finalization.md"], validators: ["required_output_exists", "jsonl_parseable"], runtime: "script",
          command: longwriteCommand(["research", "finalize-evidence-depth", "."]),
        },
        {
          id: "corpus_recovery_assessment",
          title: "Re-measure corpus gates after evidence recovery",
          owner: "source-curator", inputs: ["sources/classified_sources.jsonl", "sources/search-plan.json"],
          outputs: ["reports/corpus-gates.json", "reports/corpus-gates.md", "reports/metrics.json"], validators: ["required_output_exists"], runtime: "script",
          command: longwriteCommand(["research", "corpus-gates", ".", "--advisory"]),
        },
      ],
    }),
    ...(corpusGate ? [corpusGate] : []),
  );
}

/**
 * Replay the evidence bridge inside a quality round.
 *
 * A selected expansion changes the candidate corpus after the initial
 * semantic/full-text bridge has completed. Every stage is gated on
 * `research_expansion_dispatched` so the runtime SKIPS the block when no
 * expansion ran — instead of asking a model to "preserve" an unchanged declared
 * output, which the freshness check rejects as stale and which wastes a full
 * model turn per round before self-healing on retry.
 */
export function buildEvidenceRefreshStages(ctx: AgenticContext): StageRecord[] {
  const policy = ctx.policy;
  return (ctx.semanticBridgeEnabled ? [
    agentStage({
      id: "quality_semantic_screen",
      title: "Refresh abstract screening after a selected evidence expansion",
      owner: "analyst",
      inputs: ["reports/action-dispatch-research.json", "sources/semantic-screening-candidates.json"],
      optional_inputs: ["sources/semantic-screening.json", "reports/research-expansion.md"],
      skills: ["reports/action-dispatch-research.json", "sources/semantic-screening-candidates.json", "sources/semantic-screening.json", "reports/research-expansion.md"],
      instructions: [
        "A targeted_research_expansion was dispatched this round (this stage runs only then). Re-screen every current bounded candidate from titles and abstracts and write ONLY sources/semantic-screening.json as {version:1,screenings:[{source_id,taxonomy_cells,chapter_role,semantic_relevance,rationale,recommended_depth,fulltext_priority}]}.",
        "This is abstract-level semantic triage, not a claim-evidence judgment. Assess only supplied candidate source IDs and configured taxonomy cells. Do not invent claims, quotations, pages, venues, acceptance status, or source IDs. Use exactly: chapter_role protagonist|comparison|background|exclude; semantic_relevance high|medium|low; recommended_depth A|B|C|D (D, never none); and fulltext_priority true|false as a JSON boolean. Final A/B depth still requires retrieved full text and validated source evidence.",
      ],
      outputs: ["sources/semantic-screening.json", "reports/semantic-screen-repair.md"], validators: ["required_output_exists"],
      validator_commands: [longwriteCommand(["research", "repair-semantic-screen", "."])],
      retry: { max_attempts: 2 },
    }),
    scriptStage({
      id: "quality_fulltext_refresh",
      title: "Ingest full text selected by refreshed semantic screening",
      owner: "source-curator", inputs: ["sources/semantic-screening.json", "sources/classified_sources.jsonl"],
      outputs: ["fulltext/manifest.json"], validators: ["required_output_exists"], runtime: "script",
      command: longwriteCommand(["research", "fulltext", ".", "--max-sources", String(policy!.fulltextMaxSources), ...(policy!.allowPdfDownload === false ? ["--no-pdf-download"] : [])]),
    }),
    scriptStage({
      id: "quality_evidence_index_refresh",
      title: "Rebuild local evidence index from refreshed full text",
      owner: "source-curator", inputs: ["fulltext/manifest.json"],
      outputs: ["evidence/chunks.jsonl", "evidence/index.sqlite"], validators: ["required_output_exists"], runtime: "script",
      command: longwriteCommand(["evidence", "index", "."]),
    }),
    scriptStage({
      id: "quality_source_evidence_candidate_select",
      title: "Select refreshed full-text sources for claim extraction",
      owner: "source-curator", inputs: ["sources/semantic-screening.json", "fulltext/manifest.json", "sources/classified_sources.jsonl"],
      outputs: ["sources/source-evidence-candidates.json"], validators: ["required_output_exists"], runtime: "script",
      command: longwriteCommand(["research", "select-source-evidence-candidates", "."]),
    }),
    agentStage({
      id: "quality_source_evidence_extract",
      title: "Refresh source-level evidence packets after an expansion",
      owner: "analyst",
      inputs: ["reports/action-dispatch-research.json", "sources/source-evidence-candidates.json", "evidence/chunks.jsonl"],
      optional_inputs: ["evidence/source-packets.json", "fulltext/*.md"],
      skills: ["reports/action-dispatch-research.json", "sources/source-evidence-candidates.json", "evidence/chunks.jsonl", "evidence/source-packets.json", "fulltext/*.md"],
      instructions: [
        "A targeted_research_expansion was dispatched this round (this stage runs only then). Write ONLY evidence/source-packets.json as {version:1,packets:[{source_id,recommended_depth,claims:[{claim,supporting_excerpt,locator,comparison_dimensions,limitations}]}]} for the current approved full-text candidates. comparison_dimensions must reuse a label from evidence/comparison-dimensions.json whenever one fits: a shared label is what lets two sources be recognized as being on the same axis, and an axis only one source names is that source's framing rather than a comparison. Write a new label only when none fits; it is recorded as a proposal and joins the vocabulary once a second source independently names it. Do not restate a claim as a dimension — a dimension is the axis, not the finding.",
        "Every supporting_excerpt must be an exact contiguous excerpt of at least four normalized words from local retrieved full text. Create packets only for the supplied candidate IDs, faithfully state limitations, and omit unsupported sources rather than fabricating support. A-level recommendation needs at least two independently useful claims; B needs at least one.",
      ],
      outputs: ["evidence/source-packets.json", "evidence/validated-source-evidence.json", "reports/source-evidence-repair.md"], validators: ["required_output_exists"],
      validator_commands: [longwriteCommand(["research", "repair-source-evidence", "."])], retry: { max_attempts: 2 },
    }),
    scriptStage({
      id: "quality_finalize_evidence_depth",
      title: "Finalize refreshed citation depth from source evidence",
      owner: "analyst", inputs: ["sources/metadata-classified_sources.jsonl", "sources/semantic-screening.json", "evidence/source-packets.json", "evidence/validated-source-evidence.json"],
      outputs: ["sources/classified_sources.jsonl", "sources/bibliography.bib", "sources/citation_plan.jsonl", "evidence/active-validated-source-evidence.json", "reports/evidence-depth-finalization.md"], validators: ["required_output_exists", "jsonl_parseable"], runtime: "script",
      command: longwriteCommand(["research", "finalize-evidence-depth", "."]),
    }),
    scriptStage({
      id: "quality_corpus_gates",
      title: "Re-evaluate corpus gates on refreshed citation depth",
      owner: "source-curator", inputs: ["sources/classified_sources.jsonl", "sources/search-plan.json"],
      outputs: ["reports/corpus-gates.json", "reports/corpus-gates.md"], validators: ["required_output_exists"], runtime: "script",
      command: longwriteCommand(["research", "corpus-gates", "."]),
    }),
    scriptStage({
      id: "quality_allocate_evidence",
      title: "Reallocate section evidence from refreshed corpus",
      owner: "source-curator", inputs: ["outline.json", "evidence/chunks.jsonl", "sources/classified_sources.jsonl"],
      outputs: ["evidence/coverage.json"], validators: ["required_output_exists"], runtime: "script",
      command: longwriteCommand(["evidence", "allocate", "."]),
    }),
  ] : []).map((stage) => ({ ...stage, when: "research_expansion_dispatched >= 1" }));
}

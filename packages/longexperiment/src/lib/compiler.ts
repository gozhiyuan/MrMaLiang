import { stringify } from "yaml";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ExperimentConfig } from "./schema.js";
import { suiteLevels } from "./stages.js";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

function shellQuote(value: string): string { return `'${value.replace(/'/g, "'\\\"'\\\"'")}'`; }
function longexperimentCommand(args: string[]): { cmd: string; args: string[] } { return { cmd: process.execPath, args: [path.join(packageRoot, "dist", "cli.js"), ...args] }; }
function remoteAdapterCommand(command: string, studyId: string): { cmd: string; args: string[] } {
  return { cmd: "sh", args: ["-lc", `LONGEXPERIMENT_STUDY_ID=${shellQuote(studyId)} LONGEXPERIMENT_WORKSPACE=. ${command}`] };
}

function studyExecution(config: ExperimentConfig): Record<string, unknown> {
  if (config.authoring.mode === "agentic") {
    return {
      runtime: "script",
      command: longexperimentCommand(["stage", "run-agentic-study", ".", "{{item.id}}"]),
      instructions: [
        "Execute only the schema-validated candidate entrypoint materialized under agent/candidate/project. Bind the approved study, conditions, seeds, metric, immutable inputs, and budget from experiment.yaml.",
        "A candidate process may report measurements and workspace-relative artifacts only; it cannot certify statistics or publication eligibility.",
      ],
    };
  }
  if (config.runner.kind === "modal") {
    return {
      runtime: "remote-job",
      command: remoteAdapterCommand(config.runner.adapter_command, "{{item.id}}"),
      instructions: [
        "Run only through the configured Modal adapter. The adapter receives a JSON submit/status/collect/cancel request on stdin and must write the declared study raw-results artifact only after remote outputs are collected.",
        "Do not alter the pinned inputs, GPU class, environment, or study id.",
      ],
    };
  }
  return {
    runtime: "script",
    command: longexperimentCommand(["stage", "run-study", ".", "{{item.id}}"]),
    instructions: [
      "Run the configured runner for this one study only. The runner receives LONGEXPERIMENT_STUDY_ID, LONGEXPERIMENT_SEEDS, LONGEXPERIMENT_CONDITIONS, immutable input locks, and a required raw-result output path.",
      "Never fabricate result JSON. A nonzero runner exit or missing raw-results artifact fails this study.",
    ],
  };
}

/** Compile the declared study graph into dependency levels. Each level is a
 * real MalaClaw foreach fan-out; an item's audit must pass before any
 * dependent level starts. Optional studies appear only when explicitly enabled
 * in experiment.yaml. */
export function compileExperimentToManifest(config: ExperimentConfig): Record<string, unknown> {
  const levels = suiteLevels(config);
  const suiteOutputs = ["runs/suite-plan.json", ...levels.map((_, index) => `runs/study-level-${index + 1}.json`)];
  const stages: Array<Record<string, unknown>> = [
    {
      id: "pin_inputs", title: "Materialize immutable inputs", owner: "methodologist",
      inputs: ["experiment.yaml"], outputs: ["inputs/locks.json"], runtime: "script", command: longexperimentCommand(["stage", "pin-inputs", "."]), validators: ["required_output_exists"],
      instructions: ["Resolve only configured immutable revisions. Do not accept tags, branches, HEAD, or operator placeholders as research evidence."],
    },
  ];

  if (config.authoring.mode === "agentic") {
    stages.push(
      {
        id: "experiment_search_plan", title: "Plan pre-experiment literature recall", owner: "experiment-lead",
        inputs: ["experiment.yaml", "experiment_brief.md", "inputs/locks.json"], optional_inputs: ["../writing/project_brief.md"],
        skills: ["experiment.yaml", "experiment_brief.md", "../writing/project_brief.md"],
        instructions: [
          "Write ONLY agent/search-plan.json. Design bounded scholarly queries that identify prior methods, controls, benchmarks, negative results, and evaluation risks relevant to this experiment objective.",
          "Schema: {version:1,topic,query_variants:[...],exclusion_terms:[],venue_priorities:[],source_types:[paper|preprint|survey|benchmark|blog],taxonomy_cells:[],rationale}. Use 6-12 distinct query_variants and never invent search results.",
        ],
        outputs: ["agent/search-plan.json"], validators: ["required_output_exists"], retry: { max_attempts: 2 },
      },
      {
        id: "experiment_research_context", title: "Recall and normalize experiment literature", owner: "source-curator",
        inputs: ["agent/search-plan.json", "inputs/locks.json"], outputs: ["agent/literature-context.json", "agent/code-context.md"],
        runtime: "script", command: longexperimentCommand(["stage", "research-context", "."]), validators: ["required_output_exists"],
        instructions: ["Execute the LLM-authored search plan through LongWrite's deterministic providers and expose a bounded abstract/code dossier. Do not promote repository text into experimental results."],
      },
      {
        type: "loop", id: "experiment_proposal_loop", title: "Propose and validate the experiment", max_rounds: 2,
        stop_when: "proposal_readiness >= 1", on_exhaustion: "fail",
        stages: [
          {
            id: "propose", title: "Author a literature-grounded experiment proposal", owner: "experiment-lead",
            inputs: ["experiment.yaml", "experiment_brief.md", "agent/literature-context.json", "agent/code-context.md"], optional_inputs: ["agent/proposal-validation.json"],
            skills: ["experiment.yaml", "agent/literature-context.json", "agent/code-context.md", "agent/proposal-validation.json"],
            instructions: [
              "Write ONLY agent/experiment-proposal.json. Use source ids only from agent/literature-context.json. The approved evaluation metric, direction, baseline, control, seeds, and configured treatment condition names are immutable guardrails; design the hypothesis, method, implementation, and stopping rule within them.",
              "Schema: {version:1,research_question,hypothesis,rationale,literature_source_ids:[...],primary_metric,direction,baseline_condition,treatment_conditions:[...],control,seeds:[...],implementation_plan:[...],stopping_rule,risks:[...]}. Do not claim results, write code, or increase the budget.",
            ],
            outputs: ["agent/experiment-proposal.json"], validators: ["required_output_exists"], retry: { max_attempts: 2 },
          },
          {
            id: "validate", title: "Validate proposal against the research envelope", owner: "result-auditor",
            inputs: ["agent/experiment-proposal.json", "agent/literature-context.json", "experiment.yaml"],
            outputs: ["agent/proposal-validation.json", "reports/experiment-design.md", "runs/trial-plan.json", "reports/metrics.json"],
            runtime: "script", command: longexperimentCommand(["stage", "validate-proposal", "."]), validators: ["required_output_exists"],
          },
        ],
      },
      {
        id: "design_approval", title: "Approve experiment design before code authoring", owner: "experiment-lead",
        inputs: ["agent/validated-proposal.json", "reports/experiment-design.md", "runs/trial-plan.json"], outputs: ["reports/design-approval.md"],
        requires_human_approval: config.execution.requires_design_approval, runtime: "script", command: longexperimentCommand(["stage", "approval", ".", "design"]), validators: ["required_output_exists"],
      },
      {
        type: "loop", id: "candidate_revision_loop", title: "Author, test, and smoke the candidate", max_rounds: config.authoring.max_revision_rounds,
        stop_when: "experiment_readiness >= 1", on_exhaustion: "fail",
        stages: [
          {
            id: "author_candidate", title: "Author or revise isolated experiment code", owner: "methodologist",
            inputs: ["agent/validated-proposal.json", "agent/code-context.md", "experiment.yaml"],
            optional_inputs: ["agent/candidate-bundle.json", "agent/candidate-test.json", "agent/smoke-results.json", "reports/candidate-materialization.md", "reports/agentic-readiness.md"],
            skills: ["agent/validated-proposal.json", "agent/code-context.md", "agent/candidate-test.json", "agent/smoke-results.json", "reports/agentic-readiness.md"],
            instructions: [
              `Write ONLY agent/candidate-bundle.json. It must contain the complete current overlay as {version:1,entrypoint:${JSON.stringify(config.authoring.entrypoint)},summary,files:[{path,role,content}]}. role is source, test, config, or documentation.`,
              "The entrypoint reads LONGEXPERIMENT_CONDITION, LONGEXPERIMENT_SEED, LONGEXPERIMENT_SMOKE, LONGEXPERIMENT_ARTIFACT_DIR, and LONGEXPERIMENT_PRIMARY_METRIC; its final stdout line must be JSON {metric:<finite number>,artifacts:[workspace-relative paths]}. Include at least one test_*.py unittest. Use prior diagnostics to repair failures without weakening controls or fabricating measurements.",
              "Do not write outside the JSON bundle, use network credentials, change the pinned evaluation split/metric/seeds, or embed claimed results.",
            ],
            outputs: ["agent/candidate-bundle.json"], validators: ["required_output_exists"], retry: { max_attempts: 2 },
          },
          {
            id: "materialize_candidate", title: "Validate and materialize the candidate bundle", owner: "methodologist",
            inputs: ["agent/candidate-bundle.json", "inputs/locks.json"], outputs: ["agent/candidate/manifest.json", "reports/candidate-materialization.md"],
            runtime: "script", command: longexperimentCommand(["stage", "materialize-candidate", "."]), validators: ["required_output_exists"],
          },
          {
            id: "candidate_execution_approval", title: "Approve generated code before execution", owner: "methodologist",
            inputs: ["agent/candidate/manifest.json", "reports/candidate-materialization.md"], outputs: ["reports/candidate-approval.md"],
            requires_human_approval: config.execution.requires_revision_approval, runtime: "script", command: longexperimentCommand(["stage", "approval", ".", "candidate"]), validators: ["required_output_exists"],
            instructions: ["Review every generated file and execute it only on a dedicated worker or container with no unrelated credentials or data. Path confinement is not an operating-system sandbox."],
          },
          {
            id: "test_candidate", title: "Run bounded candidate tests", owner: "methodologist",
            inputs: ["agent/candidate/manifest.json"], outputs: ["agent/candidate-test.json", "logs/agent-candidate-tests.log"],
            runtime: "script", command: longexperimentCommand(["stage", "test-candidate", "."]), validators: ["required_output_exists"],
          },
          {
            id: "smoke_candidate", title: "Run and audit the one-seed smoke comparison", owner: "result-auditor",
            inputs: ["agent/candidate-test.json", "agent/validated-proposal.json"], outputs: ["agent/smoke-results.json", "reports/agentic-readiness.md", "reports/metrics.json"],
            runtime: "script", command: longexperimentCommand(["stage", "smoke-candidate", "."]), validators: ["required_output_exists"],
          },
        ],
      },
      {
        id: "revision_approval", title: "Approve candidate before full trials", owner: "methodologist",
        inputs: ["agent/candidate/manifest.json", "agent/smoke-results.json", "reports/agentic-readiness.md"], outputs: ["reports/revision-approval.md"],
        requires_human_approval: config.execution.requires_revision_approval, runtime: "script", command: longexperimentCommand(["stage", "approval", ".", "revision"]), validators: ["required_output_exists"],
      },
    );
  } else {
    stages.push(
      {
        id: "design", title: "Design experiment", owner: "experiment-lead",
        inputs: ["experiment.yaml", "experiment_brief.md"], outputs: ["reports/experiment-design.md", "runs/trial-plan.json"],
        requires_human_approval: config.execution.requires_design_approval, runtime: "script", command: longexperimentCommand(["stage", "design", "."]), validators: ["required_output_exists"],
      },
      {
        id: "prepare_worktrees", title: "Prepare isolated candidate worktrees", owner: "methodologist",
        inputs: ["experiment.yaml", "inputs/locks.json"], outputs: ["worktrees/manifest.json"], runtime: "script", command: longexperimentCommand(["stage", "worktrees", "."]), validators: ["required_output_exists"],
      },
    );
  }
  stages.push({
    id: "suite_plan", title: "Materialize approved suite and trial matrix", owner: "methodologist",
    inputs: ["reports/experiment-design.md", "inputs/locks.json", ...(config.authoring.mode === "agentic" ? ["agent/candidate/manifest.json"] : ["worktrees/manifest.json"])],
    outputs: suiteOutputs, runtime: "script", command: longexperimentCommand(["stage", "suite-plan", "."]), validators: ["required_output_exists"],
  });

  for (const [index] of levels.entries()) {
    const execution = studyExecution(config);
    stages.push({
      type: "foreach", id: `study_level_${index + 1}`, title: `Execute and audit dependency level ${index + 1}`,
      foreach: `runs/study-level-${index + 1}.items`, item_name: "study", max_parallel: config.execution.max_parallel_trials,
      steps: [
        {
          id: "execute", owner: "methodologist", inputs: ["runs/suite-plan.json", "inputs/locks.json", config.authoring.mode === "agentic" ? "agent/candidate/manifest.json" : "worktrees/manifest.json"],
          outputs: ["results/studies/{{item.id}}/raw-results.json", "logs/studies/{{item.id}}/runner.log"], validators: ["required_output_exists"], ...execution,
        },
        {
          id: "audit", owner: "result-auditor", inputs: ["results/studies/{{item.id}}/raw-results.json", "inputs/locks.json"], outputs: ["results/studies/{{item.id}}/audit.json"],
          runtime: "script", command: longexperimentCommand(["stage", "audit-study", ".", "{{item.id}}"]), validators: ["required_output_exists"],
          instructions: ["Verify every required condition/seed trial, source pin, and referenced artifact before allowing a dependent study to start."],
        },
      ],
    });
  }
  stages.push(
    {
      id: "aggregate_results", title: "Aggregate paired study results", owner: "result-auditor", inputs: ["runs/suite-plan.json", "inputs/locks.json", "results/studies/*/audit.json"],
      outputs: ["results/raw-results.json"], runtime: "script", command: longexperimentCommand(["stage", "aggregate", "."]), validators: ["required_output_exists"],
      instructions: ["Compute result comparisons only from completed, audited trial records. The aggregate performs a deterministic paired bootstrap; it never accepts a runner-supplied statistical conclusion."],
    },
    {
      id: "audit_results", title: "Certify result provenance", owner: "result-auditor", inputs: ["results/raw-results.json", "inputs/locks.json"],
      outputs: ["results/experiment-manifest.json", "reports/result-audit.md"], runtime: "script", command: longexperimentCommand(["stage", "audit", "."]), validators: ["required_output_exists"],
    },
  );
  if (config.authoring.mode === "agentic") stages.push(
    {
      id: "interpret_results", title: "Interpret audited comparisons", owner: "experiment-lead",
      inputs: ["results/raw-results.json", "results/experiment-manifest.json", "agent/validated-proposal.json"], skills: ["results/raw-results.json", "agent/validated-proposal.json"],
      instructions: [
        "Write ONLY agent/result-interpretation.json as {version:1,conclusion,comparison_ids:[...],summary,limitations:[...],follow_up}. conclusion is supported, not_supported, or inconclusive.",
        "Use only comparison ids and confidence intervals in results/raw-results.json. Respect the configured metric direction. Do not turn a noisy interval, failed control, or untested follow-up into a positive result.",
      ],
      outputs: ["agent/result-interpretation.json"], validators: ["required_output_exists"], retry: { max_attempts: 2 },
    },
    {
      id: "validate_result_interpretation", title: "Validate conclusions against confidence intervals", owner: "result-auditor",
      inputs: ["agent/result-interpretation.json", "results/raw-results.json"], outputs: ["agent/result-interpretation-validation.json", "reports/result-interpretation.md"],
      runtime: "script", command: longexperimentCommand(["stage", "validate-result-interpretation", "."]), validators: ["required_output_exists"],
    },
  );
  stages.push(
    {
      id: "report", title: "Package result hand-off", owner: "experiment-reporter", inputs: ["results/experiment-manifest.json", "reports/result-audit.md"],
      outputs: ["reports/experiment-report.md"], runtime: "script", command: longexperimentCommand(["stage", "report", "."]), validators: ["required_output_exists"],
    },
  );
  return {
    version: 1, project: { id: config.project.id, description: `LongExperiment: ${config.hypothesis}` },
    agents: ["experiment-lead", "methodologist", "result-auditor", "experiment-reporter"], packs: [{ id: "experiment-workflow" }], runtime: config.authoring.mode === "agentic" ? "codex" : "script",
    workflow: {
      external_inputs: ["experiment.yaml", "experiment_brief.md"], max_parallel: config.execution.max_parallel_trials,
      run_limits: { max_active_run_minutes: config.execution.max_active_run_minutes, ...(config.execution.max_recorded_tokens ? { max_recorded_tokens: config.execution.max_recorded_tokens } : {}), on_limit: "pause" },
      stages,
    },
  };
}

export function manifestYaml(config: ExperimentConfig): string { return stringify(compileExperimentToManifest(config)); }

import { z } from "zod";
import { ExperimentManifest, TrialRecord } from "@mr-maliang/research-protocol";

export { ExperimentManifest, TrialRecord } from "@mr-maliang/research-protocol";

const ProjectId = z.string().min(1).regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/, "must be a slug-like id");
export const ExperimentProfile = z.enum(["existing_code", "public_benchmark", "from_scratch"]);
export const ExperimentAuthoringMode = z.enum(["prescribed", "agentic"]);
export const StudyKind = z.enum(["inference_comparison", "exact_simulation", "training_ablation", "horizon_extension", "parameter_ablation", "heldout_evaluation"]);

const PinnedInput = z.object({
  id: z.string().min(1).regex(/^[a-z][a-z0-9_-]*$/),
  source: z.string().url(),
  revision: z.string().min(1),
  checksum: z.string().min(8).optional(),
  license: z.string().min(1).optional(),
  /** Git inputs are materialized and verified before a run. External inputs
   * (for example an immutable model hub revision) stay declared but are still
   * bound into the result provenance. */
  materialize: z.enum(["git", "external"]).default("git"),
}).strict();

const EvaluationContract = z.object({
  primary_metric: z.string().min(1),
  direction: z.enum(["maximize", "minimize"]),
  baseline_id: z.string().min(1),
  control: z.string().min(1),
  seeds: z.array(z.number().int().nonnegative()).min(2),
  statistical_test: z.string().min(1),
  heldout_split: z.string().min(1).optional(),
}).strict();

const SuiteStudy = z.object({
  id: z.string().min(1).regex(/^[a-z][a-z0-9_-]*$/),
  kind: StudyKind,
  depends_on: z.array(z.string().min(1)).default([]),
  optional_action: z.enum(["extend_horizon", "replicate_condition", "run_parameter_ablation"]).optional(),
  acceptance_criteria: z.array(z.string().min(1)).min(1),
  /** A study may declare multiple named conditions. The runner receives these
   * through LONGEXPERIMENT_CONDITIONS and must emit a record per seed/condition. */
  conditions: z.array(z.string().min(1).max(80)).min(1).max(20).default(["candidate"]),
}).strict();

const ExperimentSuite = z.object({
  id: z.string().min(1).regex(/^[a-z][a-z0-9_-]*$/),
  max_rounds: z.number().int().min(1).max(12).default(3),
  studies: z.array(SuiteStudy).min(1).max(20),
}).strict().superRefine((suite, ctx) => {
  const ids = new Set(suite.studies.map((study) => study.id));
  suite.studies.forEach((study, index) => study.depends_on.forEach((dependency) => {
    if (!ids.has(dependency)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["studies", index, "depends_on"], message: `unknown suite study dependency ${dependency}` });
  }));
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const byId = new Map(suite.studies.map((study) => [study.id, study]));
  const visit = (id: string): void => {
    if (visited.has(id) || !byId.has(id)) return;
    if (visiting.has(id)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["studies"], message: `suite dependency cycle includes ${id}` });
      return;
    }
    visiting.add(id);
    for (const dependency of byId.get(id)!.depends_on) visit(dependency);
    visiting.delete(id); visited.add(id);
  };
  suite.studies.forEach((study) => visit(study.id));
});

export const CommandRunner = z.object({
  kind: z.literal("command"),
  /** Shell command run inside the experiment workspace. */
  command: z.string().min(1).optional(),
  workdir: z.string().min(1).optional(),
}).strict();

/** AutoScientists remains an independently installed application. The adapter
 * starts its documented task launcher and only consumes its declared output
 * artifacts; it does not attempt to schedule AutoScientists' internal agents. */
export const AutoScientistsRunner = z.object({
  kind: z.literal("autoscientists"),
  repo_path: z.string().min(1),
  task: z.string().min(1),
  launch_command: z.string().min(1).optional(),
}).strict();

/** Modal uses a workspace-owned adapter command; credentials stay in the
 * environment and are never serialized into a result or paper artifact. */
export const ModalRunner = z.object({
  kind: z.literal("modal"),
  app_path: z.string().min(1),
  function_ref: z.string().min(1),
  gpu: z.string().min(1),
  max_gpu_hours: z.number().positive(),
  environment: z.string().min(1).optional(),
  /** Workspace-owned adapter implementing MalaClaw's submit/status/collect/
   * cancel JSON protocol. It is explicit so provider credentials and command
   * semantics never leak into the paper or generic runtime. */
  adapter_command: z.string().min(1),
}).strict();

const CandidateWorktree = z.object({
  id: z.string().min(1).regex(/^[a-z][a-z0-9_-]*$/),
  input_id: z.string().min(1),
  revision: z.string().min(7),
  role: z.enum(["baseline", "candidate"]).default("candidate"),
}).strict();

const PrescribedAuthoring = z.object({
  mode: z.literal("prescribed"),
}).strict();

const AgenticAuthoring = z.object({
  mode: z.literal("agentic"),
  /** Optional pinned code input used as the immutable base for a generated
   * candidate worktree. Omit for a from-scratch project. */
  base_input_id: z.string().regex(/^[a-z][a-z0-9_-]*$/).optional(),
  language: z.literal("python").default("python"),
  entrypoint: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._/-]*\.py$/).default("maliang_runner.py"),
  max_revision_rounds: z.number().int().min(1).max(5).default(3),
  max_files: z.number().int().min(2).max(80).default(30),
  max_file_bytes: z.number().int().min(256).max(200_000).default(80_000),
  require_tests: z.boolean().default(true),
  require_literature_context: z.boolean().default(true),
}).strict();

export const ExperimentConfig = z.object({
  version: z.literal(1),
    project: z.object({
    id: ProjectId,
    name: z.string().min(1).optional(),
    mode: z.literal("computational_experiment").default("computational_experiment"),
  }).strict(),
  profile: ExperimentProfile.default("existing_code"),
  authoring: z.discriminatedUnion("mode", [PrescribedAuthoring, AgenticAuthoring]).default({ mode: "prescribed" }),
  hypothesis: z.string().min(1),
  research_question: z.string().min(1).optional(),
  inputs: z.object({ code: z.array(PinnedInput).default([]), benchmarks: z.array(PinnedInput).default([]), models: z.array(PinnedInput).default([]) }).strict().default({ code: [], benchmarks: [], models: [] }),
  evaluation: EvaluationContract.optional(),
  suite: ExperimentSuite.optional(),
  runner: z.discriminatedUnion("kind", [CommandRunner, AutoScientistsRunner, ModalRunner]).default({ kind: "command" }),
  execution: z.object({
    max_trials: z.number().int().positive().default(10),
    max_active_run_minutes: z.number().positive().default(480),
    max_recorded_tokens: z.number().int().positive().optional(),
    max_parallel_trials: z.number().int().positive().max(32).default(2),
    requires_design_approval: z.boolean().default(true),
    requires_revision_approval: z.boolean().default(true),
    /** Explicit candidate revisions are isolated in Git worktrees below
     * worktrees/. A runner receives LONGEXPERIMENT_WORKTREE for its study. */
    candidate_worktrees: z.array(CandidateWorktree).max(20).default([]),
    /** Optional studies never run merely because they are declared. */
    enabled_optional_actions: z.array(z.enum(["extend_horizon", "replicate_condition", "run_parameter_ablation"])).max(3).default([]),
  }).strict().default({ max_trials: 10, max_active_run_minutes: 480, max_parallel_trials: 2, requires_design_approval: true, requires_revision_approval: true, candidate_worktrees: [], enabled_optional_actions: [] }),
  outputs: z.object({
    longwrite_workspace: z.string().min(1).optional(),
  }).strict().default({}),
}).strict().superRefine((config, ctx) => {
  if (config.authoring.mode !== "agentic") return;
  const baseInputId = config.authoring.base_input_id;
  if (!config.evaluation) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["evaluation"], message: "agentic authoring requires a fixed evaluation guardrail" });
  if (!config.suite) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["suite"], message: "agentic authoring requires a bounded suite envelope" });
  if (!config.execution.requires_design_approval || !config.execution.requires_revision_approval) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["execution"], message: "agentic authoring requires design and revision approval guardrails" });
  }
  if (config.profile === "from_scratch" && baseInputId) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["authoring", "base_input_id"], message: "from_scratch authoring cannot name a base code input" });
  if (config.profile === "existing_code" && config.inputs.code.length > 0 && !baseInputId) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["authoring", "base_input_id"], message: "existing_code agentic authoring requires a base code input" });
  if (baseInputId && !config.inputs.code.some((input) => input.id === baseInputId)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["authoring", "base_input_id"], message: "base_input_id must match a pinned code input" });
  }
});

export type ExperimentConfig = z.infer<typeof ExperimentConfig>;

export const StudyRawResults = z.object({
  version: z.literal(1),
  study_id: z.string().min(1),
  status: z.enum(["completed", "failed", "inconclusive"]),
  trials: z.array(TrialRecord).default([]),
  runner_version: z.string().min(1),
  /** Every configured input id must be present and equal to its configured
   * immutable revision. */
  input_revisions: z.record(z.string().min(1)),
  environment: z.record(z.string().min(1)).default({}),
  artifacts: z.object({ tables: z.array(z.string()).default([]), figures: z.array(z.string()).default([]), logs: z.array(z.string()).default([]) }).strict().default({ tables: [], figures: [], logs: [] }),
}).strict();

export type StudyRawResults = z.infer<typeof StudyRawResults>;

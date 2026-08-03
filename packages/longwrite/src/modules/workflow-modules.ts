import { z } from "zod";
import { defineModule } from "malaclaw/sdk";

/**
 * Reusable MalaClaw workflow modules for LongWrite's domain fragments (MM-4.2).
 *
 * ## Why these are additive rather than a retrofit
 *
 * `createModuleContext` namespaces every stage id it builds
 * (`ctx.id("audit")` → `"citation_audit_audit"`). That namespacing is the
 * property that lets one module be used twice in a workflow without colliding —
 * it is not optional, and there is no escape hatch.
 *
 * Retrofitting these onto the *existing* compiled pipeline would therefore
 * rename every stage id, which breaks three commitments at once:
 *
 *  - MM-2.1 "Preserve all existing stage IDs."
 *  - MM-4.1 "Do not change emitted IR."
 *  - MM-4.4 "No migration proceeds unless old compiler and SDK compiler emit
 *    structurally identical IR for all MM-0 fixtures."
 *
 * It is also not merely cosmetic: a stage id is the durable unit key in
 * `state.units[...]`, the prompt and log filename, and the approval id. Renaming
 * one orphans the durable state of every in-flight run.
 *
 * So these modules are the composition surface for **new** workflows. The
 * existing compiler keeps its stage ids and its golden parity, and a workflow
 * that wants these fragments composes them here instead of hand-rolling them
 * again. Migrating the existing pipeline onto them is a deliberate
 * reopen/reset decision, not a refactor.
 */

/** `longwrite` lives beside the compiled workflow; callers inject the binary. */
const CommandConfig = z.object({
  /** Executable that runs LongWrite subcommands, e.g. `node dist/cli.js`. */
  cli: z.object({ cmd: z.string().min(1), args: z.array(z.string()).default([]) }).strict(),
  workspace: z.string().min(1).default("."),
});
/** Structural, not `z.infer`: each module extends CommandConfig, and the
 *  extended schema's inferred type is not assignable to the base one. */
type CommandLike = { cli: { cmd: string; args?: readonly string[] }; workspace?: string };

function run(config: CommandLike, subcommand: readonly string[], extra: readonly string[] = []) {
  return { cmd: config.cli.cmd, args: [...(config.cli.args ?? []), ...subcommand, config.workspace ?? ".", ...extra] };
}

export const citationAuditModule = defineModule({
  id: "citation-audit",
  version: "1.0.0",
  config: CommandConfig.extend({
    requireExactLocators: z.boolean().default(true),
    minimumSupportRate: z.number().min(0).max(1).default(0.9),
  }),
  inputs: ["chapters/*.md", "evidence/source-packets.json", "evidence/active-validated-source-evidence.json"],
  outputs: ["evidence/citation-ledger.jsonl", "reports/evidence-audit.md"],
  requiredCapabilities: ["script"],
  stages: (ctx, config) => [
    ctx.script({
      id: "reconcile-identities", title: "Reconcile duplicate source identities",
      command: run(config, ["research", "reconcile-identities"]),
      outputs: ["sources/identities.json"], validators: ["required_output_exists"],
    }),
    ctx.script({
      id: "verify", title: "Verify cited source URLs are live",
      command: run(config, ["research", "verify"]),
      outputs: ["reports/source-verification.md"], validators: ["required_output_exists"],
    }),
    ctx.script({
      id: "build-ledger", title: "Build the citation ledger from chapter markers",
      command: run(config, ["evidence", "consolidate"]),
      outputs: ["evidence/citation-ledger.jsonl"], validators: ["required_output_exists"],
    }),
    ctx.script({
      id: "audit", title: "Score claim support against the ledger",
      command: run(config, ["evidence", "audit"], config.requireExactLocators ? ["--require-locators"] : []),
      outputs: ["reports/evidence-audit.md", "reports/metrics.json"], validators: ["required_output_exists"],
    }),
  ],
});

export const evidenceRetrievalModule = defineModule({
  id: "evidence-retrieval",
  version: "1.0.0",
  config: CommandConfig.extend({ allocate: z.boolean().default(true) }),
  inputs: ["sources/search-plan.json"],
  outputs: ["evidence/chunks.jsonl", "evidence/coverage.json"],
  requiredCapabilities: ["script"],
  stages: (ctx, config) => [
    ctx.script({ id: "fulltext", title: "Fetch full text for screened sources", command: run(config, ["research", "fulltext"]), outputs: ["sources/fulltext.json"], validators: ["required_output_exists"] }),
    ctx.script({ id: "index", title: "Build the evidence chunk index", command: run(config, ["evidence", "index"]), outputs: ["evidence/chunks.jsonl"], validators: ["required_output_exists"] }),
    ...(config.allocate
      ? [ctx.script({ id: "allocate", title: "Allocate evidence to outline sections", command: run(config, ["evidence", "allocate"]), outputs: ["evidence/coverage.json"], validators: ["required_output_exists"] })]
      : []),
  ],
});

export const repositoryStudyModule = defineModule({
  id: "repository-study",
  version: "1.0.0",
  config: CommandConfig.extend({ compare: z.boolean().default(false) }),
  inputs: ["longwrite.yaml"],
  outputs: ["evidence/codebase-analysis.json"],
  requiredCapabilities: ["script"],
  stages: (ctx, config) => [
    ctx.script({ id: "snapshot", title: "Pin the repository to an immutable revision", command: run(config, ["research", "codebase-prepare"]), outputs: ["evidence/codebase-context.md"], validators: ["required_output_exists"] }),
    ctx.script({ id: "analyze", title: "Analyze the pinned snapshot", command: run(config, ["research", "codebase-analysis"]), outputs: ["evidence/codebase-analysis.json"], validators: ["required_output_exists"] }),
    ...(config.compare
      ? [ctx.script({ id: "compare", title: "Compare against the declared baseline repository", command: run(config, ["research", "codebase-comparison"]), outputs: ["evidence/codebase-comparison.json"], validators: ["required_output_exists"] })]
      : []),
  ],
});

export const reviewedOutlineModule = defineModule({
  id: "reviewed-outline",
  version: "1.0.0",
  config: CommandConfig.extend({ requiresHumanApproval: z.boolean().default(true) }),
  inputs: ["evidence/coverage.json"],
  outputs: ["outline/outline.json", "reports/outline-readiness.md"],
  requiredCapabilities: ["script"],
  stages: (ctx, config) => [
    ctx.script({ id: "contract", title: "Derive the survey structure contract", command: run(config, ["outline", "survey-contract"]), outputs: ["reports/survey-contract.json"], validators: ["required_output_exists"] }),
    ctx.script({ id: "readiness", title: "Score outline readiness deterministically", command: run(config, ["outline", "readiness"]), outputs: ["reports/outline-readiness.md", "reports/metrics.json"], validators: ["required_output_exists"] }),
    // A human gate stays a declared stage so the pause is durable, not implicit.
    ...(config.requiresHumanApproval
      ? [ctx.humanReview({ id: "approve", title: "Approve the outline before drafting", inputs: ["outline/outline.json", "reports/outline-readiness.md"], outputs: ["reports/outline-approval.md"] })]
      : []),
  ],
});

export const reviewReviseBuildModule = defineModule({
  id: "review-revise-build",
  version: "1.0.0",
  config: CommandConfig.extend({ maxRounds: z.number().int().min(1).max(12).default(3), targetScore: z.number().min(0).max(10).default(8) }),
  inputs: ["chapters/*.md"],
  outputs: ["reviews/scorecard.json", "build/paper.pdf"],
  requiredCapabilities: ["script"],
  stages: (ctx, config) => [
    // Bounded by construction: an unbounded quality loop would spend without a
    // ceiling, which the engine refuses to compile.
    ctx.loop({
      id: "quality", title: "Review, revise, and rebuild until the score target",
      max_rounds: config.maxRounds ?? 3, stop_when: `review_score >= ${config.targetScore ?? 8}`, on_exhaustion: "fail",
      stages: [
        ctx.script({ id: "review", title: "Score the manuscript against the rubric", command: run(config, ["review", "score"]), outputs: ["reviews/scorecard.json", "reports/metrics.json"], validators: ["required_output_exists"] }),
        ctx.script({ id: "build", title: "Rebuild the manuscript artifacts", command: run(config, ["build", "manuscript"]), outputs: ["build/paper.pdf"], validators: ["required_output_exists"] }),
      ],
    }),
  ],
});

export const latexPublicationModule = defineModule({
  id: "latex-publication",
  version: "1.0.0",
  config: CommandConfig.extend({ anonymous: z.boolean().default(false) }),
  inputs: ["chapters/*.md", "evidence/citation-ledger.jsonl"],
  outputs: ["build/paper.pdf", "reports/longwrite-validation.json"],
  requiredCapabilities: ["script"],
  stages: (ctx, config) => [
    ctx.script({ id: "render", title: "Render LaTeX from validated chapters", command: run(config, ["publication", "latex"], config.anonymous ? ["--anonymous"] : []), outputs: ["build/paper.tex"], validators: ["required_output_exists"] }),
    ctx.script({ id: "compile", title: "Compile the PDF", command: run(config, ["publication", "compile"]), outputs: ["build/paper.pdf"], validators: ["required_output_exists"] }),
    ctx.script({ id: "validate", title: "Run the deterministic release validation", command: run(config, ["publication", "validate"]), outputs: ["reports/longwrite-validation.json"], validators: ["required_output_exists"] }),
  ],
});

export const experimentEvidenceImportModule = defineModule({
  id: "experiment-evidence-import",
  version: "1.0.0",
  config: CommandConfig.extend({ manifestPath: z.string().min(1).default("../experiment/results/experiment-manifest.json") }),
  inputs: ["longwrite.yaml"],
  outputs: ["evidence/experiment-packets.json"],
  requiredCapabilities: ["script"],
  stages: (ctx, config) => [
    ctx.script({ id: "import", title: "Import an audited experiment manifest", command: run(config, ["experiment", "import"], [config.manifestPath ?? "../experiment/results/experiment-manifest.json"]), outputs: ["evidence/experiment-packets.json"], validators: ["required_output_exists"] }),
    // Import and verification are separate stages on purpose: an unverified
    // packet must never be usable as paper evidence.
    ctx.script({ id: "verify", title: "Verify imported experiment checksums", command: run(config, ["experiment", "verify"]), outputs: ["reports/experiment-verification.md"], validators: ["required_output_exists"] }),
  ],
});

export const controlledExperimentSuiteModule = defineModule({
  id: "controlled-experiment-suite",
  version: "1.0.0",
  config: CommandConfig.extend({ maxParallel: z.number().int().min(1).max(16).default(2) }),
  inputs: ["experiment.yaml"],
  outputs: ["results/experiment-manifest.json"],
  requiredCapabilities: ["script"],
  stages: (ctx, config) => [
    ctx.script({ id: "plan", title: "Materialize the trial matrix", command: run(config, ["stage", "suite-plan"]), outputs: ["runs/suite-plan.json"], validators: ["required_output_exists"] }),
    ctx.foreach({
      id: "execute", title: "Execute and audit each study",
      foreach: "runs/study-level-1.items", item_name: "study", max_parallel: config.maxParallel ?? 2,
      steps: [
        { id: "run", owner: "methodologist", runtime: "script", command: run(config, ["stage", "run-study"], ["{{study.id}}"]), outputs: ["results/studies/{{study.id}}/raw-results.json"], validators: ["required_output_exists"] },
        { id: "audit", owner: "result-auditor", runtime: "script", command: run(config, ["stage", "audit-study"], ["{{study.id}}"]), outputs: ["results/studies/{{study.id}}/audit.json"], validators: ["required_output_exists"] },
      ],
    }),
    ctx.script({ id: "certify", title: "Certify the experiment manifest", command: run(config, ["stage", "audit"]), outputs: ["results/experiment-manifest.json"], validators: ["required_output_exists"] }),
  ],
});

/** Every module MM-4.2 names, in one registry for discovery and testing. */
export const LONGWRITE_WORKFLOW_MODULES = [
  citationAuditModule,
  evidenceRetrievalModule,
  repositoryStudyModule,
  reviewedOutlineModule,
  reviewReviseBuildModule,
  latexPublicationModule,
  experimentEvidenceImportModule,
  controlledExperimentSuiteModule,
] as const;

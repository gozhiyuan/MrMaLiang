#!/usr/bin/env node
import path from "node:path";
import { Command } from "commander";
import { loadWorkspaceEnv } from "./lib/workspace-env.js";
import { PAPER_PROFILE_IDS } from "./lib/paper-profiles.js";

// Flow script commands run with the workspace as their current directory.
// Loading here lets `malaclaw flow run` use the same workspace-local .env.
await loadWorkspaceEnv(path.resolve());

const program = new Command();

program
  .name("longwrite")
  .description("Long-form writing agent workflows on the MalaClaw flow engine")
  .version("0.2.0");

const mode = program.command("mode").description("Inspect bundled writing modes");

mode
  .command("list")
  .description("List bundled writing modes")
  .action(async () => {
    const { runModeList } = await import("./commands/mode.js");
    await runModeList();
  });

mode
  .command("show <id>")
  .description("Show a bundled writing mode")
  .action(async (id) => {
    const { runModeShow } = await import("./commands/mode.js");
    await runModeShow(id);
  });

const runtimeProfile = program.command("runtime-profile").description("Inspect bundled runtime strategies");

runtimeProfile
  .command("list")
  .description("List bundled runtime profiles")
  .action(async () => {
    const { runRuntimeProfileList } = await import("./commands/runtime-profile.js");
    await runRuntimeProfileList();
  });

const environment = program.command("env").description("Manage workspace-local, non-secret environment templates");

environment
  .command("init <workspace>")
  .description("Add .env.example and ignore .env without changing the flow manifest")
  .action(async (workspace) => {
    const { runEnvInit } = await import("./commands/env.js");
    await runEnvInit(workspace);
  });

runtimeProfile
  .command("show <id>")
  .description("Show a bundled runtime profile")
  .action(async (id) => {
    const { runRuntimeProfileShow } = await import("./commands/runtime-profile.js");
    await runRuntimeProfileShow(id);
  });

program
  .command("init <dir>")
  .description("Scaffold a LongWrite workspace (interactive when no --topic is given)")
  .option("-i, --interactive", "Force the interactive wizard even when flags are set")
  .option("--mode <id>", "Writing mode (default: auto_research_agentic)")
  .option("--id <id>", "Project id")
  .option("--name <name>", "Project name")
  .option("--author <name...>", "Author/writer name(s); repeat values before the next option")
  .option("--email <email...>", "Optional author email(s), paired by position with --author")
  .option("--topic <topic>", "Writing topic")
  .option("--research-provider <id>", "Research provider: seed, arxiv, semantic_scholar, dblp, crossref, openalex, or multi (agentic default: multi)")
  .option("--research-paper-kind <kind>", "Research quality rubric: survey or empirical (default: survey)")
  .option("--research-paper-profile <id>", `Research argument: ${PAPER_PROFILE_IDS.join(" or ")} (default: literature_survey)`)
  .option("--repository <source...>", "Pinned GitHub/Git URL or local Git path; required by codebase-centered profiles and repeatable")
  .option("--discover-repositories", "Search GitHub for bounded, LLM-selected supplementary software evidence")
  .option("--repository-query-budget <n>", "Maximum GitHub search queries (1-20; default: 10)")
  .option("--repository-max-candidates <n>", "Maximum GitHub repository candidates retained (1-100; default: 40)")
  .option("--repository-max-readmes <n>", "Maximum candidate READMEs fetched (0-40; default: 12)")
  .option("--repository-max-selected <n>", "Maximum discovered repositories pinned (1-10; default: 8)")
  .option("--repository-language <language...>", "Optional GitHub language filters")
  .option("--include-archived-repositories", "Allow archived GitHub repositories in discovery")
  .option("--allow-unlicensed-repositories", "Allow discovery candidates without a detected license")
  .option("--research-workflow-profile <id>", "Research breadth: fast, standard, or deep (agentic default: deep)")
  .option("--research-target-candidates <n>", "Target total source candidates across query variants (default: 100)")
  .option("--research-query-budget <n>", "Maximum planned search queries to execute (default: 24)")
  .option("--research-writing-strategy <id>", "Research drafting: scaffold_then_revise or llm_sections (agentic default: llm_sections)")
  .option("--taxonomy <term...>", "Taxonomy cells or coverage themes for research planning")
  .option("--review-cadence <mode>", "When to check pending approval gates: manual, daily, or interval (default: manual)")
  .option("--review-time <HH:MM>", "Daily review agenda time for --review-cadence daily (default: 08:00)")
  .option("--review-interval-hours <n>", "Review agenda interval for --review-cadence interval (default: 4)")
  .option("--batch-approvals", "Prefer batch approval for pending review gates")
  .option("--target-length-words <n>", "Target manuscript length in words")
  .option("--genre <genre>", "Optional genre/category, e.g. \"technical survey\", \"implementation guide\", \"speculative mystery\"")
  .option("--audience <audience>", "Optional reader profile, e.g. \"agent researchers\", \"platform engineers\", \"adult mystery readers\"")
  .option("--style <instructions>", "Style instructions for writing and review")
  .option("--reference-instructions <instructions>", "How LLM writers should use supplied reference links/files")
  .option("--runtime-profile <id>", "Runtime strategy: default, codex_first, or claude_first (claude_advisor_sonnet remains a legacy alias)")
  .option("--language <lang>", "Output language (e.g. en, zh, 中文); auto-detected from a CJK topic when omitted")
  .option("--reference-link <url...>", "Reference URL(s) or style/source links")
  .option("--reference-file <path...>", "Local reference file path(s), such as PDFs or notes")
  .option("--output-format <format...>", "Output format(s): markdown, pdf (default: markdown)")
  .option("--citation-style <style>", "Citation style: numeric or author_year (default follows workflow profile)")
  .option("--submission-target <id>", "Publication target: arxiv (default) or custom")
  .option("--anonymous", "Render author metadata as Anonymous for a blind custom submission")
  .option("--page-limit <n>", "Optional submission page limit, checked during packaging")
  .option("--required-section <title...>", "Required section title(s) for the selected submission target")
  .option("--submission-template-dir <path>", "Workspace-relative folder with a custom venue .cls/.sty/.bst bundle")
  .option("--document-class <name>", "Custom LaTeX class name without .cls")
  .option("--document-class-option <option...>", "Custom LaTeX document-class option(s)")
  .option("--max-unit-minutes <n>", "Per-unit timeout in minutes (full mode default: 30)")
  .option("--max-active-run-minutes <n>", "Total active worker-time budget in minutes (full mode default: 1440)")
  .option("--max-recorded-tokens <n>", "Optional telemetry token budget; not a provider billing limit")
  .action(async (dir, opts) => {
    const { runInit } = await import("./commands/init.js");
    const { shouldRunWizard, runInitWizard } = await import("./commands/init-wizard.js");
    const finalOpts = shouldRunWizard(opts) ? await runInitWizard(dir, opts) : opts;
    await runInit(dir, finalOpts);
  });

program
  .command("status <workspace>")
  .description("Summarize LongWrite and MalaClaw workspace status")
  .action(async (workspace) => {
    const { runStatus } = await import("./commands/status.js");
    await runStatus(workspace);
  });

program
  .command("preflight <workspace>")
  .description("Check a generated workspace and local release capabilities without invoking an LLM")
  .option("--runtime <id>", "Optionally probe one MalaClaw worker runtime, e.g. codex")
  .action(async (workspace, opts) => {
    const { runPreflight } = await import("./commands/preflight.js");
    await runPreflight(workspace, opts);
  });

program
  .command("sync <workspace>")
  .description("Regenerate project_brief.md and malaclaw.yaml from longwrite.yaml")
  .action(async (workspace) => {
    const { runSync } = await import("./commands/sync.js");
    await runSync(workspace);
  });

const workspace = program.command("workspace").description("Preserve, archive, and safely prune LongWrite workspace artifacts");

workspace
  .command("provenance <workspace>")
  .description("Write an append-only run provenance record without reading workspace secrets")
  .option("--runtime <id>", "Runtime used for this completed run")
  .action(async (workspaceDir, opts) => {
    const { writeRunProvenance } = await import("./lib/ops/workspace-lifecycle.js");
    console.log(`Recorded run provenance: ${await writeRunProvenance(workspaceDir, opts)}`);
  });

workspace
  .command("keep <workspace>")
  .description("Record that the workspace should retain its audit and evidence artifacts")
  .option("--note <text>", "Optional retention note")
  .action(async (workspaceDir, opts) => {
    const { markWorkspaceKeep } = await import("./lib/ops/workspace-lifecycle.js");
    console.log(`Retention policy: ${await markWorkspaceKeep(workspaceDir, opts.note)}`);
  });

workspace
  .command("archive <workspace>")
  .description("Create a checksummed archive of canonical evidence, review, flow, and final-paper artifacts")
  .action(async (workspaceDir) => {
    const { archiveWorkspace } = await import("./lib/ops/workspace-lifecycle.js");
    const result = await archiveWorkspace(workspaceDir);
    console.log(`Verified archive: ${result.archive}`);
    console.log(`Archive manifest: ${result.manifest}`);
  });

workspace
  .command("prune <workspace>")
  .description("Preview removal of rebuildable caches and TeX intermediates; use --execute only after archiving")
  .option("--execute", "Delete the displayed rebuildable artifacts after archive verification")
  .option("--archive <path>", "Workspace-relative archive path to verify before deletion")
  .action(async (workspaceDir, opts) => {
    const { pruneWorkspace } = await import("./lib/ops/workspace-lifecycle.js");
    const result = await pruneWorkspace(workspaceDir, opts);
    console.log(`${result.dryRun ? "Prune preview" : "Pruned"}: ${result.candidates.length} rebuildable artifact(s)`);
    for (const file of result.candidates) console.log(`  ${result.dryRun ? "would remove" : "removed"} ${file}`);
    if (result.dryRun) console.log("No files were deleted. Run again with --execute after `longwrite workspace archive <workspace>`.");
    console.log(`Prune report: ${result.report}`);
  });

const publication = program.command("publication").description("Validate and package a research-paper submission source bundle");

publication
  .command("validate <workspace>")
  .description("Check the selected arXiv/custom publication target without changing files")
  .action(async (workspace) => {
    const { runValidatePublication } = await import("./commands/package.js");
    await runValidatePublication(workspace);
  });

publication
  .command("package <workspace>")
  .description("Create build/submission/<target>/ after the publication checks pass")
  .action(async (workspace) => {
    const { runPackagePublication } = await import("./commands/package.js");
    await runPackagePublication(workspace);
  });

program
  .command("run <workspace>")
  .description("Validate and run a LongWrite workflow through MalaClaw")
  .option("--runtime <id>", "MalaClaw worker runtime, e.g. dry-run, script, codex, claude-code")
  .option("--reset", "Reset existing MalaClaw flow state before running")
  .option("--skip-validate", "Skip malaclaw validate before running")
  .action(async (workspace, opts) => {
    const { runWorkflow } = await import("./commands/run.js");
    await runWorkflow(workspace, opts);
  });

program
  .command("retry <workspace>")
  .description("Reset failed units to pending while preserving completed workflow work")
  .action(async (workspace) => {
    const { retryWorkflow } = await import("./commands/retry.js");
    await retryWorkflow(workspace);
  });

program
  .command("supervise <workspace>")
  .description("Resume a workspace through MalaClaw's long-lived supervisor")
  .option("--runtime <id>", "MalaClaw worker runtime, e.g. codex or claude-code")
  .option("--retry-minutes <n>", "Maximum retry backoff in minutes")
  .option("--max-hours <n>", "Calendar deadline in hours")
  .option("--detach", "Detach the supervisor after it starts")
  .action(async (workspace, opts) => {
    const { runSupervise } = await import("./commands/supervise.js");
    await runSupervise(workspace, opts);
  });

const outline = program.command("outline").description("Review and revise the research-paper outline");

outline
  .command("revise <workspace>")
  .description("Record outline feedback and reopen outline plus downstream stages")
  .requiredOption("--message <text>", "Specific requested outline changes")
  .action(async (workspace, opts) => {
    const { requestOutlineRevision } = await import("./commands/outline.js");
    await requestOutlineRevision(workspace, opts);
  });

program
  .command("approve <workspace> [approvalId]")
  .description("Approve pending MalaClaw gates for a LongWrite workspace")
  .option("--batch", "Batch-review all pending approvals")
  .action(async (workspace, approvalId, opts) => {
    const { runApprove } = await import("./commands/approve.js");
    await runApprove(workspace, approvalId, opts);
  });

program
  .command("runtimes <workspace>")
  .description("Check MalaClaw worker runtime availability")
  .option("--runtime <id>", "Only check one runtime")
  .action(async (workspace, opts) => {
    const { runRuntimes } = await import("./commands/runtimes.js");
    await runRuntimes(workspace, opts);
  });

program
  .command("dashboard")
  .description("Register the LongWrite dashboard extension and start the MalaClaw dashboard")
  .option("--port <port>", "Dashboard server port")
  .option("--host <host>", "Dashboard bind host")
  .option("--auth-token <token>", "Bearer token for dashboard API authentication")
  .option("--install-only", "Only register the LongWrite dashboard extension; do not start the server")
  .action(async (opts) => {
    const { runDashboard } = await import("./commands/dashboard.js");
    await runDashboard(opts);
  });

const feedback = program.command("feedback").description("Record feedback for follow-up revision workflows");

feedback
  .command("add <workspace>")
  .description("Append user feedback to feedback/user-feedback.md")
  .option("--message <text>", "Feedback text")
  .option("--file <path>", "Read feedback text from a local file")
  .action(async (workspace, opts) => {
    const { runFeedbackAdd } = await import("./commands/feedback.js");
    await runFeedbackAdd(workspace, opts);
  });

const metrics = program.command("metrics").description("Compute LongWrite workspace metrics");

metrics
  .command("words <workspace>")
  .description("Count manuscript/chapter words and write reports/word-metrics.*")
  .action(async (workspace) => {
    const { runMetricsWords } = await import("./commands/metrics.js");
    await runMetricsWords(workspace);
  });

const report = program.command("report").description("Write LongWrite operational reports");

report
  .command("daily <workspace>")
  .description("Write a daily workspace digest")
  .action(async (workspace) => {
    const { runReportDaily } = await import("./commands/report.js");
    await runReportDaily(workspace);
  });

report
  .command("schedule <workspace>")
  .description("Write scheduler setup snippets")
  .action(async (workspace) => {
    const { runReportSchedule } = await import("./commands/report.js");
    await runReportSchedule(workspace);
  });

report
  .command("packet <workspace>")
  .description("Write a human review packet with flow, validation, scorecard, routing, artifacts, and next action")
  .action(async (workspace) => {
    const { runReportPacket } = await import("./commands/report.js");
    await runReportPacket(workspace);
  });

const review = program.command("review").description("Inspect and manage review agenda");

review
  .command("agenda <workspace>")
  .description("Print pending review agenda")
  .action(async (workspace) => {
    const { runReviewAgenda } = await import("./commands/review.js");
    await runReviewAgenda(workspace);
  });

review
  .command("score <workspace>")
  .description("Compute the official review score from reviews/scorecard.json (median of personas, anti-inflation caps) and write reports/metrics.json")
  .action(async (workspace) => {
    const { runReviewScore } = await import("./commands/review.js");
    await runReviewScore(workspace);
  });

review
  .command("repair-claims <workspace>")
  .description("Normalize a safe JSON-array/object envelope into valid claim-judgment JSONL; fail visibly on malformed judgment rows")
  .action(async (workspace) => {
    const { repairClaimJudgments } = await import("./lib/ops/claim-gate.js");
    const result = await repairClaimJudgments(workspace);
    console.log(`claim judgments: ${result.judgments} valid row(s); envelope normalized: ${result.normalized ? "yes" : "no"}`);
  });

review
  .command("repair-action-plan <workspace>")
  .description("Normalize a fenced JSON action plan and validate its bounded finding/action contract")
  .action(async (workspace) => {
    const { repairAgenticActionPlan } = await import("./lib/ops/action-plan.js");
    const result = await repairAgenticActionPlan(workspace);
    console.log(`action plan: envelope normalized: ${result.normalized ? "yes" : "no"}; duplicate tools merged: ${result.merged.length ? result.merged.join(", ") : "none"}`);
  });

review
  .command("split-action-plan <workspace>")
  .description("Split a validated agentic action plan into research, structural, and revision dispatch phases")
  .option("--action-plan <path>", "Workspace-relative action plan", "reviews/action-plan.json")
  .action(async (workspace, opts) => {
    const { splitAgenticActionPlan } = await import("./lib/ops/action-plan.js");
    const result = await splitAgenticActionPlan(workspace, opts.actionPlan);
    for (const rel of result.written) console.log(`  + ${rel}`);
  });

review
  .command("repair-artifact-plan <workspace>")
  .description("Normalize and validate the LLM-authored, source-grounded artifact strategy")
  .action(async (workspace) => {
    const { repairAgenticArtifactPlan } = await import("./lib/ops/artifact-plan.js");
    const result = await repairAgenticArtifactPlan(workspace);
    console.log(`artifact plan: envelope normalized: ${result.normalized ? "yes" : "no"}`);
  });

review
  .command("repair-outline-review <workspace>")
  .description("Normalize and validate the evidence-aware outline critique before revision")
  .action(async (workspace) => {
    const { repairOutlineReview } = await import("./lib/ops/outline-review.js");
    const result = await repairOutlineReview(workspace);
    console.log(`outline review: envelope normalized: ${result.normalized ? "yes" : "no"}`);
  });

review
  .command("score-outline-readiness <workspace>")
  .description("Compute the deterministic outline_readiness loop metric from audits and review findings")
  .action(async (workspace) => {
    const { scoreOutlineReadiness } = await import("./lib/ops/outline-review.js");
    const result = await scoreOutlineReadiness(workspace);
    console.log(`outline readiness: ${result.ready ? "ready" : "revision required"}`);
  });

review
  .command("outline-approval <workspace>")
  .description("Write the human outline-approval brief after the deterministic readiness gate passes")
  .action(async (workspace) => {
    const { writeOutlineApprovalBrief } = await import("./lib/ops/outline-review.js");
    console.log(`outline approval brief: ${await writeOutlineApprovalBrief(workspace)}`);
  });

review
  .command("validate-outline-reopen <workspace>")
  .description("Validate the deterministic survey and structure contracts after an allowlisted outline reopening")
  .option("--action-plan <path>", "Workspace-relative action plan", "reviews/action-plan.json")
  .action(async (workspace, opts) => {
    const { validateOutlineReopen } = await import("./lib/ops/outline-review.js");
    const result = await validateOutlineReopen(workspace, opts.actionPlan);
    console.log(`outline reopen: ${result.selected ? (result.ready ? "validated" : "blocked") : "not requested"}`);
  });

review
  .command("request-clarification <workspace>")
  .description("Write an inspectable operator question from a validated agentic action plan")
  .option("--action-plan <path>", "Workspace-relative action plan", "reviews/action-plan.json")
  .action(async (workspace, opts) => {
    const { writeOperatorClarificationRequest } = await import("./lib/ops/action-plan.js");
    const written = await writeOperatorClarificationRequest(workspace, opts.actionPlan);
    console.log(`operator clarification request: ${written}`);
  });

review
  .command("claims <workspace>")
  .description("Score reviews/claim-judgments.jsonl into claim_support_rate in reports/metrics.json (deterministic; gate loops on it via stop_when)")
  .action(async (workspace) => {
    const { scoreClaimGate } = await import("./lib/ops/claim-gate.js");
    const result = await scoreClaimGate(workspace);
    console.log(`claim_support_rate: ${result.supportRate} (${result.entailed} entailed / ${result.partial} partial / ${result.unsupported} unsupported of ${result.judged})`);
    for (const finding of result.findings) console.error(`  ! ${finding}`);
  });

review
  .command("route <workspace>")
  .description("Map reviewer weaknesses to the workflow stages that fix them; writes reports/routing.md")
  .action(async (workspace) => {
    const { runReviewRoute } = await import("./commands/review.js");
    await runReviewRoute(workspace);
  });

review
  .command("structure <workspace>")
  .description("Audit survey outline structure and write review artifacts")
  .action(async (workspace) => {
    const { auditSurveyStructure } = await import("./lib/ops/structure-audit.js");
    const result = await auditSurveyStructure(workspace);
    console.log(`Survey structure audit: ${result.pass ? "pass" : "review required"}`);
    for (const file of result.written) console.log(`  + ${file}`);
  });

const research = program.command("research").description("Prepare research artifacts");

research
  .command("import-experiment <workspace>")
  .description("Import a publication-eligible LongExperiment suite manifest for an empirical paper")
  .requiredOption("--manifest <path>", "Path to LongExperiment results/experiment-manifest.json")
  .action(async (workspace, opts) => {
    const { importExperimentManifest } = await import("./commands/research.js");
    console.log(`Imported experiment manifest: ${await importExperimentManifest(workspace, opts.manifest)}`);
  });

research
  .command("prepare-experiment <workspace>")
  .description("Verify an imported LongExperiment manifest and build bounded empirical evidence packets")
  .action(async (workspace) => {
    const { prepareImportedExperiment } = await import("./commands/research.js");
    for (const rel of await prepareImportedExperiment(workspace)) console.log(`Prepared empirical evidence: ${rel}`);
  });

const evidence = program.command("evidence").description("Build and query the per-workspace research evidence index");

evidence
  .command("index <workspace>")
  .description("Chunk cached full text and rebuild evidence/index.sqlite")
  .action(async (workspace) => {
    const { runEvidenceIndex } = await import("./commands/evidence.js");
    await runEvidenceIndex(workspace);
  });

evidence
  .command("search <workspace>")
  .description("Search evidence/index.sqlite with lexical full-text retrieval")
  .requiredOption("--query <text>", "Question, section title, or evidence need")
  .option("--limit <n>", "Maximum chunks to return", "12")
  .action(async (workspace, opts) => {
    const { runEvidenceSearch } = await import("./commands/evidence.js");
    await runEvidenceSearch(workspace, opts);
  });

evidence
  .command("allocate <workspace>")
  .description("Create outline-section evidence packets and taxonomy coverage report")
  .action(async (workspace) => {
    const { runEvidenceAllocate } = await import("./commands/evidence.js");
    await runEvidenceAllocate(workspace);
  });

evidence
  .command("consolidate <workspace>")
  .description("Build citation-ledger.jsonl from drafted chapters and evidence packets")
  .action(async (workspace) => {
    const { runEvidenceConsolidate } = await import("./commands/evidence.js");
    await runEvidenceConsolidate(workspace);
  });

evidence
  .command("audit <workspace>")
  .description("Summarize citation-evidence defects for the next review/revision pass")
  .action(async (workspace) => {
    const { runEvidenceAudit } = await import("./commands/evidence.js");
    await runEvidenceAudit(workspace);
  });

research
  .command("prepare <workspace>")
  .description("Prepare research artifacts for a workspace")
  .requiredOption("--topic <topic>", "Research topic")
  .option("--provider <id>", "Research provider: seed, arxiv, semantic_scholar, dblp, crossref, openalex, or multi", "seed")
  .option("--limit <n>", "Number of sources", "8")
  .option("--count <n>", "Deprecated alias for --limit")
  .option("--allow-seed-fallback", "Explicitly use deterministic seed sources when a live provider fails (development only)")
  .action(async (workspace, opts) => {
    const { runResearchPrepare } = await import("./commands/research.js");
    await runResearchPrepare(workspace, opts);
  });

research
  .command("codebases <workspace>")
  .description("Snapshot configured Git/local repositories as pinned codebase evidence (without executing them)")
  .action(async (workspace) => {
    const { runResearchPrepareCodebases } = await import("./commands/research.js");
    await runResearchPrepareCodebases(workspace);
  });

research
  .command("repair-codebase-analysis <workspace>")
  .description("Validate an LLM-authored repository architecture dossier against exact pinned-code locators")
  .action(async (workspace) => {
    const { runResearchRepairCodebaseAnalysis } = await import("./commands/research.js");
    await runResearchRepairCodebaseAnalysis(workspace);
  });

research
  .command("repair-codebase-comparison <workspace>")
  .description("Validate repository comparison rows and cross-repository synthesis against exact code locators")
  .action(async (workspace) => {
    const { runResearchRepairCodebaseComparison } = await import("./commands/research.js");
    await runResearchRepairCodebaseComparison(workspace);
  });

research
  .command("github-codebase-recall <workspace>")
  .description("Search GitHub API for bounded codebase candidates from the approved search plan")
  .action(async (workspace) => {
    const { runResearchGithubCodebaseRecall } = await import("./commands/research.js");
    await runResearchGithubCodebaseRecall(workspace);
  });

research
  .command("repair-github-codebase-selection <workspace>")
  .description("Validate LLM-selected GitHub software artifacts before Git snapshotting")
  .action(async (workspace) => {
    const { runResearchRepairGithubCodebaseSelection } = await import("./commands/research.js");
    await runResearchRepairGithubCodebaseSelection(workspace);
  });

research
  .command("assess <workspace>")
  .description("Compute literature quality, citation verification, and source-upgrade reports")
  .action(async (workspace) => {
    const { runResearchAssess } = await import("./commands/research.js");
    await runResearchAssess(workspace);
  });

research
  .command("recall <workspace>")
  .description("Stage 1/3: query providers, write raw + deduped sources with provenance")
  .requiredOption("--topic <topic>", "Research topic")
  .option("--provider <id>", "Research provider: seed, arxiv, semantic_scholar, dblp, crossref, openalex, multi", "seed")
  .option("--limit <n>", "Number of sources", "8")
  .option("--target-candidates <n>", "Target total candidates across query variants")
  .option("--query-budget <n>", "Maximum search-plan query variants to execute")
  .option("--allow-seed-fallback", "Explicitly use deterministic seed sources when a live provider fails (development only)")
  .action(async (workspace, opts) => {
    const { runResearchRecall } = await import("./commands/research.js");
    await runResearchRecall(workspace, opts);
  });

research
  .command("score <workspace>")
  .description("Stage 2/3: read deduped sources, write scored sources")
  .action(async (workspace) => {
    const { runResearchScore } = await import("./commands/research.js");
    await runResearchScore(workspace);
  });

research
  .command("snowball <workspace>")
  .description("Expand a bounded citation network through Semantic Scholar reference lists")
  .action(async (workspace) => {
    const { runResearchSnowball } = await import("./commands/research.js");
    await runResearchSnowball(workspace);
  });

research
  .command("venue-upgrade <workspace>")
  .description("Upgrade incomplete venue/DOI metadata and write a venue-upgrade report")
  .action(async (workspace) => {
    const { runResearchVenueUpgrade } = await import("./commands/research.js");
    await runResearchVenueUpgrade(workspace);
  });

research
  .command("enrich <workspace>")
  .description("Upgrade deduped source metadata from Crossref title matches")
  .option("--max-sources <n>", "Maximum incomplete source records to query", "20")
  .option("--disabled", "Write a skipped enrichment report without network calls")
  .action(async (workspace, opts) => {
    const { runResearchEnrich } = await import("./commands/research.js");
    await runResearchEnrich(workspace, { maxSources: opts.maxSources, enabled: opts.disabled ? false : undefined });
  });

research
  .command("classify <workspace>")
  .description("Stage 3/3: read scored sources, write classification, BibTeX, and citation plan")
  .option("--topic <topic>", "Research topic (for the tooling report)")
  .action(async (workspace, opts) => {
    const { runResearchClassify } = await import("./commands/research.js");
    await runResearchClassify(workspace, opts);
  });

research
  .command("select-semantic-candidates <workspace>")
  .description("Select a bounded metadata-ranked and taxonomy-reserved subset for LLM abstract screening")
  .action(async (workspace) => {
    const { runResearchSelectSemanticCandidates } = await import("./commands/research.js");
    await runResearchSelectSemanticCandidates(workspace);
  });

research
  .command("repair-semantic-screen <workspace>")
  .description("Validate bounded LLM abstract-screen decisions against source and taxonomy contracts")
  .action(async (workspace) => {
    const { runResearchRepairSemanticScreen } = await import("./commands/research.js");
    await runResearchRepairSemanticScreen(workspace);
  });

research
  .command("select-source-evidence-candidates <workspace>")
  .description("Select semantically approved, ingested sources for source-level evidence extraction")
  .action(async (workspace) => {
    const { runResearchSelectSourceEvidenceCandidates } = await import("./commands/research.js");
    await runResearchSelectSourceEvidenceCandidates(workspace);
  });

research
  .command("repair-source-evidence <workspace>")
  .description("Validate LLM source evidence packets against local retrieved full text")
  .action(async (workspace) => {
    const { runResearchRepairSourceEvidence } = await import("./commands/research.js");
    await runResearchRepairSourceEvidence(workspace);
  });

research
  .command("finalize-evidence-depth <workspace>")
  .description("Require validated semantic and full-text evidence before final A/B citation depth")
  .action(async (workspace) => {
    const { runResearchFinalizeEvidenceDepth } = await import("./commands/research.js");
    await runResearchFinalizeEvidenceDepth(workspace);
  });

research
  .command("expand <workspace>")
  .description("Apply targeted research/evidence remediation from a fixed or agentic plan")
  .option("--action-plan <path>", "Workspace-relative agentic action plan (defaults to reports/remediation-plan.json)")
  .action(async (workspace, opts) => {
    const { runResearchExpand } = await import("./commands/research.js");
    await runResearchExpand(workspace, { actionPlan: opts.actionPlan });
  });

research
  .command("fulltext <workspace>")
  .description("Download and extract full text for core sources (arXiv HTML, keyless); reports ingested vs skipped")
  .option("--max-sources <n>", "Maximum A/B-depth sources to ingest")
  .option("--no-pdf-download", "Do not fetch open-access PDF fallbacks")
  .option("--refresh", "Re-fetch instead of reusing cached source documents")
  .action(async (workspace, opts) => {
    const { runResearchFulltext } = await import("./commands/research.js");
    await runResearchFulltext(workspace, opts);
  });

research
  .command("verify <workspace>")
  .description("Verify URLs for cited sources and write a reproducible verification report")
  .option("--max-sources <n>", "Maximum cited source URLs to verify", "30")
  .action(async (workspace, opts) => {
    const { runResearchVerify } = await import("./commands/research.js");
    await runResearchVerify(workspace, opts);
  });

research
  .command("corpus-gates <workspace>")
  .description("Fail closed when full-mode retrieval breadth, core-source, freshness, diversity, or taxonomy gates are not met")
  .action(async (workspace) => {
    const { runResearchCorpusGates } = await import("./commands/research.js");
    await runResearchCorpusGates(workspace);
  });

research
  .command("reconcile-identities <workspace>")
  .description("Write source identity/provenance records across DOI, arXiv, S2, DBLP, OpenAlex, and canonical URLs")
  .action(async (workspace) => {
    const { runResearchReconcileIdentities } = await import("./commands/research.js");
    await runResearchReconcileIdentities(workspace);
  });

research
  .command("survey-contract <workspace>")
  .description("Check full survey outline structure and write the related-work comparison matrix")
  .action(async (workspace) => {
    const { runResearchSurveyContract } = await import("./commands/research.js");
    await runResearchSurveyContract(workspace);
  });

research
  .command("refresh <workspace>")
  .description("Snapshot the old corpus, refresh retrieval, and write a literature-refresh delta/reopen report")
  .action(async (workspace) => {
    const { runResearchRefresh } = await import("./commands/research.js");
    await runResearchRefresh(workspace);
  });

const validate = program.command("validate").description("Run LongWrite domain validators");

validate
  .command("config <workspace>")
  .description("Validate longwrite.yaml against the project config schema")
  .action(async (workspace) => {
    const { runValidateConfig } = await import("./commands/validate.js");
    await runValidateConfig(workspace);
  });

validate
  .command("research <workspace>")
  .description("Validate a research-writing workspace")
  .action(async (workspace) => {
    const { runValidateResearch } = await import("./commands/validate.js");
    await runValidateResearch(workspace);
  });

validate
  .command("latex <workspace>")
  .description("Validate generated LaTeX manuscript sources and build artifacts")
  .action(async (workspace) => {
    const { runValidateLatex } = await import("./commands/validate.js");
    await runValidateLatex(workspace);
  });

validate
  .command("figures <workspace>")
  .description("Validate generated research figures, tables, data files, and manuscript references")
  .action(async (workspace) => {
    const { runValidateFigures } = await import("./commands/validate.js");
    await runValidateFigures(workspace);
  });

validate
  .command("search-plan <workspace>")
  .description("Validate sources/search-plan.json against the planner schema")
  .action(async (workspace) => {
    const { runValidateSearchPlan } = await import("./commands/validate.js");
    await runValidateSearchPlan(workspace);
  });

validate
  .command("scorecard <workspace>")
  .description("Validate reviews/scorecard.json against the multi-persona schema")
  .action(async (workspace) => {
    const { runValidateScorecard } = await import("./commands/validate.js");
    await runValidateScorecard(workspace);
  });

validate
  .command("novel <workspace>")
  .description("Validate a novel workspace: bibles, chapter arcs, continuity, style, and manuscript")
  .action(async (workspace) => {
    const { runValidateNovel } = await import("./commands/validate.js");
    await runValidateNovel(workspace);
  });

validate
  .command("technical-book <workspace>")
  .description("Validate a technical-book workspace: TOC contracts, examples, code syntax, and manuscript")
  .action(async (workspace) => {
    const { runValidateTechnicalBook } = await import("./commands/validate.js");
    await runValidateTechnicalBook(workspace);
  });

const draft = program.command("draft").description("Internal LongWrite drafting helpers");

draft
  .command("section <workspace>")
  .description("Draft one section from MalaClaw stage context")
  .action(async (workspace) => {
    const { runDraftSection } = await import("./commands/draft.js");
    await runDraftSection(workspace);
  });

draft
  .command("novel <workspace>")
  .description("Draft or update one novel-stage artifact from MalaClaw stage context")
  .action(async (workspace) => {
    const { runDraftNovel } = await import("./commands/draft.js");
    await runDraftNovel(workspace);
  });

draft
  .command("technical-book <workspace>")
  .description("Draft or update one technical-book artifact from MalaClaw stage context")
  .action(async (workspace) => {
    const { runDraftTechnicalBook } = await import("./commands/draft.js");
    await runDraftTechnicalBook(workspace);
  });

const build = program.command("build").description("Build LongWrite manuscript artifacts");

build
  .command("figures <workspace>")
  .description("Build deterministic research figures, tables, and source data")
  .action(async (workspace) => {
    const { runBuildFigures } = await import("./commands/build.js");
    await runBuildFigures(workspace);
  });

build
  .command("latex <workspace>")
  .description("Build LaTeX manuscript sources and build/manuscript.pdf")
  .action(async (workspace) => {
    const { runBuildLatex } = await import("./commands/build.js");
    await runBuildLatex(workspace);
  });

build
  .command("research <workspace>")
  .description("Build full research-paper artifacts: figures, tables, LaTeX, and build/manuscript.pdf")
  .action(async (workspace) => {
    const { runBuildResearch } = await import("./commands/build.js");
    await runBuildResearch(workspace);
  });

program.parseAsync(process.argv).catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});

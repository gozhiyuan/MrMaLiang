import path from "node:path";
import { loadMode } from "../lib/modes.js";
import { scaffoldWorkspace } from "../lib/scaffold.js";
import type { ResearchProviderId } from "../lib/research/providers.js";
import { listRuntimeProfileIds } from "../lib/runtime-profiles.js";
import { RESEARCH_WORKFLOW_PROFILES, type ResearchWorkflowProfile } from "../lib/research/workflow-profiles.js";
import { PAPER_PROFILE_IDS, paperProfile, type PaperProfileId } from "../lib/paper-profiles.js";
import { DEFAULT_GITHUB_CODEBASE_DISCOVERY, type CodebaseConfig, type GithubCodebaseDiscoveryConfig } from "../lib/research/codebase-contract.js";

export type InitCommandOptions = {
  mode?: string;
  id?: string;
  name?: string;
  author?: string[];
  email?: string[];
  topic?: string;
  researchProvider?: string;
  researchPaperKind?: string;
  researchPaperProfile?: string;
  repository?: string[];
  discoverRepositories?: boolean;
  repositoryQueryBudget?: string;
  repositoryMaxCandidates?: string;
  repositoryMaxReadmes?: string;
  repositoryMaxSelected?: string;
  repositoryLanguage?: string[];
  includeArchivedRepositories?: boolean;
  allowUnlicensedRepositories?: boolean;
  researchWorkflowProfile?: string;
  researchTargetCandidates?: string;
  researchQueryBudget?: string;
  researchWritingStrategy?: string;
  taxonomy?: string[];
  reviewCadence?: string;
  reviewTime?: string;
  reviewIntervalHours?: string;
  batchApprovals?: boolean;
  targetLengthWords?: string;
  genre?: string;
  audience?: string;
  style?: string;
  referenceInstructions?: string;
  language?: string;
  referenceLink?: string[];
  referenceFile?: string[];
  outputFormat?: string[];
  citationStyle?: string;
  runtimeProfile?: string;
  maxRecordedTokens?: string;
  maxUnitMinutes?: string;
  maxActiveRunMinutes?: string;
  submissionTarget?: string;
  anonymous?: boolean;
  pageLimit?: string;
  requiredSection?: string[];
  submissionTemplateDir?: string;
  documentClass?: string;
  documentClassOption?: string[];
};

const researchProviders = new Set<ResearchProviderId>(["seed", "arxiv", "semantic_scholar", "dblp", "crossref", "openalex", "multi"]);
const researchPaperKinds = new Set(["survey", "empirical"]);
const researchPaperProfiles = new Set<string>(PAPER_PROFILE_IDS);
const reviewCadences = new Set(["manual", "daily", "interval"]);
const outputFormats = new Set(["markdown", "pdf"]);

/** The flagship agentic research mode uses the expensive, release-grade
 * evidence contract. Keep the classification explicit so future modes cannot
 * accidentally inherit starter-workspace defaults. */
function isFullResearchMode(modeId: string): boolean {
  return modeId === "auto_research_agentic";
}

function authorRecords(names: string[] = [], emails: string[] = []): Array<{ name: string; email?: string }> {
  return names
    .map((name, index) => ({
      name: name.trim(),
      ...(emails[index]?.trim() ? { email: emails[index].trim() } : {}),
    }))
    .filter((author) => author.name.length > 0);
}

function slugFromDir(targetDir: string): string {
  const base = path.basename(path.resolve(targetDir));
  return base.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "") || "longwrite-project";
}

function repositoryInputs(values: string[] = []): CodebaseConfig[] {
  const used = new Set<string>();
  return values.map((value, index) => {
    const input = value.trim();
    if (!input) throw new Error("--repository cannot be empty");
    const source = /^(https?:\/\/|git@|ssh:\/\/)/i.test(input) ? input : path.resolve(input);
    const rawName = input.replace(/\/$/, "").split("/").pop()?.replace(/\.git$/i, "") || `repository-${index + 1}`;
    const base = rawName.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "") || `repository-${index + 1}`;
    let id = `repo-${base}`;
    let suffix = 2;
    while (used.has(id)) id = `repo-${base}-${suffix++}`;
    used.add(id);
    return { id, source, ref: "HEAD", title: rawName, role: index === 0 ? "primary_artifact" : "supplementary_artifact" };
  });
}

function positiveIntegerOption(value: string | undefined, option: string): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`${option} must be a positive integer`);
  return parsed;
}

function boundedIntegerOption(value: string | undefined, option: string, min: number, max: number): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) throw new Error(`${option} must be an integer from ${min} to ${max}`);
  return parsed;
}

export async function runInit(targetDir: string, opts: InitCommandOptions): Promise<void> {
  const mode = await loadMode(opts.mode ?? "auto_research_agentic");
  const runtimeProfile = opts.runtimeProfile;
  const runtimeProfiles = await listRuntimeProfileIds();
  if (runtimeProfile && runtimeProfile !== "default" && !runtimeProfiles.includes(runtimeProfile)) {
    throw new Error(`--runtime-profile must be one of: default, ${runtimeProfiles.join(", ")}`);
  }
  const projectId = opts.id ?? slugFromDir(targetDir);
  const researchProvider = opts.researchProvider ?? (isFullResearchMode(mode.id) ? "multi" : "seed");
  if (!researchProviders.has(researchProvider as ResearchProviderId)) {
    throw new Error("--research-provider must be one of: seed, arxiv, semantic_scholar, dblp, crossref, openalex, multi");
  }
  const researchPaperKind = opts.researchPaperKind ?? "survey";
  if (!researchPaperKinds.has(researchPaperKind)) {
    throw new Error("--research-paper-kind must be survey or empirical");
  }
  const researchPaperProfile = opts.researchPaperProfile ?? "literature_survey";
  if (!researchPaperProfiles.has(researchPaperProfile)) {
    throw new Error(`--research-paper-profile must be one of: ${PAPER_PROFILE_IDS.join(", ")}`);
  }
  const profile = paperProfile(researchPaperProfile as PaperProfileId);
  const codebases = repositoryInputs(opts.repository);
  const discoveryEnabled = opts.discoverRepositories ?? false;
  if (profile.requiresCodebase && codebases.length === 0 && !discoveryEnabled) {
    throw new Error(`--research-paper-profile ${profile.id} requires at least one --repository or --discover-repositories`);
  }
  if (discoveryEnabled && researchPaperProfile !== "repository_study") throw new Error("--discover-repositories requires --research-paper-profile repository_study");
  const codebaseDiscovery: GithubCodebaseDiscoveryConfig = {
    ...DEFAULT_GITHUB_CODEBASE_DISCOVERY,
    enabled: discoveryEnabled,
    query_budget: boundedIntegerOption(opts.repositoryQueryBudget, "--repository-query-budget", 1, 20) ?? DEFAULT_GITHUB_CODEBASE_DISCOVERY.query_budget,
    max_candidates: boundedIntegerOption(opts.repositoryMaxCandidates, "--repository-max-candidates", 1, 100) ?? DEFAULT_GITHUB_CODEBASE_DISCOVERY.max_candidates,
    max_readme_fetches: boundedIntegerOption(opts.repositoryMaxReadmes, "--repository-max-readmes", 0, 40) ?? DEFAULT_GITHUB_CODEBASE_DISCOVERY.max_readme_fetches,
    max_selected: boundedIntegerOption(opts.repositoryMaxSelected, "--repository-max-selected", 1, 10) ?? DEFAULT_GITHUB_CODEBASE_DISCOVERY.max_selected,
    languages: (opts.repositoryLanguage ?? []).map((value) => value.trim()).filter(Boolean),
    include_archived: opts.includeArchivedRepositories ?? false,
    require_license: !(opts.allowUnlicensedRepositories ?? false),
  };
  const researchWorkflowProfile = opts.researchWorkflowProfile ?? (isFullResearchMode(mode.id) ? profile.defaultWorkflowProfile : "standard");
  if (!(RESEARCH_WORKFLOW_PROFILES as readonly string[]).includes(researchWorkflowProfile)) {
    throw new Error("--research-workflow-profile must be fast, standard, or deep");
  }
  const reviewCadence = opts.reviewCadence ?? "manual";
  if (!reviewCadences.has(reviewCadence)) {
    throw new Error("--review-cadence must be one of: manual, daily, interval");
  }
  const reviewIntervalHours = opts.reviewIntervalHours ? Number.parseInt(opts.reviewIntervalHours, 10) : 4;
  if (!Number.isInteger(reviewIntervalHours) || reviewIntervalHours <= 0) {
    throw new Error("--review-interval-hours must be a positive integer");
  }
  const reviewTime = opts.reviewTime ?? "08:00";
  if (!/^\d{2}:\d{2}$/.test(reviewTime)) {
    throw new Error("--review-time must use HH:MM format");
  }
  const targetLengthWords = opts.targetLengthWords ? Number.parseInt(opts.targetLengthWords, 10) : undefined;
  if (targetLengthWords !== undefined && (!Number.isInteger(targetLengthWords) || targetLengthWords <= 0)) {
    throw new Error("--target-length-words must be a positive integer");
  }
  const maxRecordedTokens = positiveIntegerOption(opts.maxRecordedTokens, "--max-recorded-tokens");
  const maxUnitMinutes = positiveIntegerOption(opts.maxUnitMinutes, "--max-unit-minutes");
  const maxActiveRunMinutes = positiveIntegerOption(opts.maxActiveRunMinutes, "--max-active-run-minutes");
  const pageLimit = positiveIntegerOption(opts.pageLimit, "--page-limit");
  const submissionTarget = opts.submissionTarget ?? "arxiv";
  if (submissionTarget !== "arxiv" && submissionTarget !== "custom") {
    throw new Error("--submission-target must be arxiv or custom");
  }
  if (submissionTarget === "custom" && (!opts.submissionTemplateDir || !opts.documentClass)) {
    throw new Error("custom submission target requires --submission-template-dir and --document-class");
  }
  if (opts.citationStyle && opts.citationStyle !== "numeric" && opts.citationStyle !== "author_year") {
    throw new Error("--citation-style must be numeric or author_year");
  }
  const requestedRunLimits = maxRecordedTokens !== undefined || maxUnitMinutes !== undefined || maxActiveRunMinutes !== undefined;
  const runLimits = isFullResearchMode(mode.id)
    ? {
      max_unit_minutes: maxUnitMinutes ?? 30,
      max_active_run_minutes: maxActiveRunMinutes ?? 1_440,
      max_recorded_tokens: maxRecordedTokens ?? 10_000_000,
      on_limit: "pause" as const,
    }
    : requestedRunLimits
      ? {
        ...(maxRecordedTokens !== undefined ? { max_recorded_tokens: maxRecordedTokens } : {}),
        ...(maxUnitMinutes !== undefined ? { max_unit_minutes: maxUnitMinutes } : {}),
        ...(maxActiveRunMinutes !== undefined ? { max_active_run_minutes: maxActiveRunMinutes } : {}),
        on_limit: "pause" as const,
      }
      : undefined;
  const researchTargetCandidates = opts.researchTargetCandidates
    ? Number.parseInt(opts.researchTargetCandidates, 10)
    : undefined;
  if (researchTargetCandidates !== undefined && (!Number.isInteger(researchTargetCandidates) || researchTargetCandidates < 1 || researchTargetCandidates > 1_000)) {
    throw new Error("--research-target-candidates must be an integer from 1 to 1000");
  }
  const researchQueryBudget = opts.researchQueryBudget
    ? Number.parseInt(opts.researchQueryBudget, 10)
    : undefined;
  if (researchQueryBudget !== undefined && (!Number.isInteger(researchQueryBudget) || researchQueryBudget < 1 || researchQueryBudget > 50)) {
    throw new Error("--research-query-budget must be an integer from 1 to 50");
  }
  // A full paper is an authored artifact: start each approved section with
  // the selected harness, then retain scripts for evidence and release gates.
  // Non-flagship artifact modes retain the inexpensive deterministic scaffold
  // unless an operator explicitly opts into LLM-authored sections.
  const researchWritingStrategy = opts.researchWritingStrategy
    ?? (isFullResearchMode(mode.id)
      ? "llm_sections"
      : "scaffold_then_revise");
  if (researchWritingStrategy !== "scaffold_then_revise" && researchWritingStrategy !== "llm_sections") {
    throw new Error("--research-writing-strategy must be scaffold_then_revise or llm_sections");
  }
  const requestedOutputFormats = opts.outputFormat?.length ? opts.outputFormat : ["markdown"];
  for (const format of requestedOutputFormats) {
    if (!outputFormats.has(format)) throw new Error("--output-format must be markdown or pdf");
  }
  const created = await scaffoldWorkspace({
    mode,
    targetDir,
    projectId,
    projectName: opts.name,
    authors: authorRecords(opts.author, opts.email),
    topic: opts.topic,
    researchProvider: researchProvider as ResearchProviderId,
    researchPaperKind: researchPaperKind as "survey" | "empirical",
    researchPaperProfile: researchPaperProfile as PaperProfileId,
    codebases,
    codebaseDiscovery,
    researchWorkflowProfile: researchWorkflowProfile as ResearchWorkflowProfile,
    researchTargetCandidates,
    researchQueryBudget,
    researchWritingStrategy: researchWritingStrategy as "scaffold_then_revise" | "llm_sections",
    taxonomy: opts.taxonomy ?? [],
    reviewCadence: reviewCadence as "manual" | "daily" | "interval",
    reviewTime,
    reviewIntervalHours,
    batchApprovals: opts.batchApprovals ?? false,
    targetLengthWords,
    genre: opts.genre,
    audience: opts.audience,
    styleInstructions: opts.style,
    referenceInstructions: opts.referenceInstructions,
    language: opts.language,
    referenceLinks: opts.referenceLink ?? [],
    referenceFiles: opts.referenceFile ?? [],
    outputFormats: requestedOutputFormats as Array<"markdown" | "pdf">,
    runtimeProfile,
    runLimits,
    publication: {
      target: submissionTarget as "arxiv" | "custom",
      anonymous: opts.anonymous ?? false,
      pageLimit,
      requiredSections: opts.requiredSection ?? [],
      templateDir: opts.submissionTemplateDir,
      documentClass: opts.documentClass,
      documentClassOptions: opts.documentClassOption ?? [],
      citationStyle: opts.citationStyle as "numeric" | "author_year" | undefined,
    },
  });

  const parentWorkspace = process.env.MALIANG_PARENT_WORKSPACE;
  console.log(`Created ${parentWorkspace ? "writing component" : "LongWrite"} workspace at ${path.resolve(targetDir)}`);
  for (const file of created) console.log(`  + ${file}`);
  console.log("\nNext steps:");
  if (parentWorkspace) {
    const suggestedRuntime = isFullResearchMode(mode.id) && researchProvider !== "seed" ? "codex" : "dry-run";
    console.log(`  maliang run ${parentWorkspace} --runtime ${suggestedRuntime}`);
    console.log(`  maliang writing review agenda ${parentWorkspace}`);
    console.log(`  maliang writing approve ${parentWorkspace} --batch  # only if a human gate is configured or requested`);
    return;
  }
  if (isFullResearchMode(mode.id)) {
    console.log(`  longwrite run ${targetDir} --runtime codex`);
    console.log("  # Use a separate --research-provider seed workspace for an offline --runtime dry-run rehearsal.");
  } else {
    console.log(`  longwrite run ${targetDir} --runtime dry-run`);
  }
  console.log(`  longwrite review agenda ${targetDir}`);
  console.log(`  longwrite approve ${targetDir} --batch  # only if a human gate is configured or requested`);
}

import fs from "node:fs/promises";
import path from "node:path";
import { loadMode } from "./modes.js";
import { compileModeToManifest, manifestToYaml } from "./compiler.js";
import { loadProjectConfig, type LongWriteProjectConfig } from "./project-config.js";
import type { ResearchProviderId } from "./research/providers.js";
import { detectLanguage } from "./scaffold.js";
import { loadRuntimeProfileIfSelected } from "./runtime-profiles.js";
import { ensureWorkspaceEnvFiles } from "./workspace-env.js";
import { requireSupportedNode } from "./node-runtime.js";

function projectBrief(config: LongWriteProjectConfig, modeName: string): string {
  const writing = config.writing;
  const language = config.project.artifact_type === "novel"
    ? detectLanguage(config.research.topic, writing.language)
    : writing.language;
  const directives = [
    ...config.project.authors.map((author) => `- Author: ${author.name}${author.email ? ` <${author.email}>` : ""}`),
    ...(language ? [`- Language: write ALL prose, reviews, and artifacts in ${language}.`] : []),
    ...(writing.genre ? [`- Genre: ${writing.genre}`] : []),
    ...(writing.audience ? [`- Audience: ${writing.audience}`] : []),
    ...(writing.target_length_words ? [`- Target length: about ${writing.target_length_words} words total.`] : []),
    ...(writing.style_instructions ? [`- Style: ${writing.style_instructions}`] : []),
    ...(writing.reference_instructions ? [`- Reference-use instructions: ${writing.reference_instructions}`] : []),
    ...(config.project.artifact_type === "research_paper" ? [`- Research paper kind: ${config.research.paper_kind}; paper profile: ${config.research.paper_profile}.`] : []),
    ...(config.project.artifact_type === "research_paper" ? [`- Publication target: ${config.publication.target}${config.publication.anonymous ? " (anonymous)" : ""}.`] : []),
    ...(config.publication.required_sections.length ? [`- Required submission sections: ${config.publication.required_sections.join(", ")}.`] : []),
    `- Research target: ${config.research.target_candidates} candidates across up to ${config.research.query_budget} queries.`,
    ...config.research.taxonomy.map((term) => `- Taxonomy coverage cell: ${term}`),
    ...writing.reference_links.map((link) => `- Reference link: ${link}`),
    ...writing.reference_files.map((file) => `- Reference file: ${file}`),
    ...((writing.reference_links.length || writing.reference_files.length) ? [
      "- Reference-use policy: Recognized arXiv, DOI, and OpenReview links are authoritative scholarly seeds and must resolve exactly through the research pipeline before citation. Other links/files remain context for scope, terminology, or style and are not citable evidence until independently retrieved and validated.",
      "- Reference-file access: Prefer files copied into this workspace under references/. External absolute paths may be unavailable to a headless runtime.",
    ] : []),
  ];

  return (
    `# Project Brief\n\n` +
    `Mode: ${modeName} (${config.project.mode})\n` +
    `Artifact: ${config.project.artifact_type}\n\n` +
    `## Topic\n\n${config.research.topic ?? "TODO: describe what you want to write."}\n` +
    (directives.length > 0 ? `\n## Style and Language\n\n${directives.join("\n")}\n` : "")
  );
}

export type SyncWorkspaceResult = {
  written: string[];
};

/** Sync derived workspace files from longwrite.yaml.
 *
 * longwrite.yaml is the user-facing project config. project_brief.md and
 * malaclaw.yaml are derived inputs for workers and the flow engine; keeping
 * this as an explicit command prevents dashboard/CLI config edits from
 * silently drifting away from what workers actually read.
 */
export async function syncWorkspace(workspaceDir: string): Promise<SyncWorkspaceResult> {
  requireSupportedNode("Syncing a LongWrite workspace");
  const resolved = path.resolve(workspaceDir);
  const config = await loadProjectConfig(resolved);
  const mode = await loadMode(config.project.mode);
  const runtimeProfile = await loadRuntimeProfileIfSelected(config.runtime_profile);

  const written: string[] = [];
  written.push(...await ensureWorkspaceEnvFiles(resolved));
  await fs.writeFile(path.join(resolved, "project_brief.md"), projectBrief(config, mode.name), "utf-8");
  written.push("project_brief.md");

  const manifest = compileModeToManifest(mode, {
    projectId: config.project.id,
    projectName: config.project.name,
    topic: config.research.topic,
    researchProvider: config.research.provider as ResearchProviderId,
    runtimeProfile,
    runLimits: config.run_limits,
    stageOverrides: config.execution.stage_overrides,
    researchPolicy: {
      workflowProfile: config.research.workflow_profile,
      targetCandidates: config.research.target_candidates,
      queryBudget: config.research.query_budget,
      taxonomy: config.research.taxonomy,
      paperProfile: config.research.paper_profile,
      codebases: config.research.codebases,
      codebaseDiscovery: {
        enabled: config.research.codebase_discovery.enabled,
        queryBudget: config.research.codebase_discovery.query_budget,
        maxCandidates: config.research.codebase_discovery.max_candidates,
        maxReadmeFetches: config.research.codebase_discovery.max_readme_fetches,
        maxSelected: config.research.codebase_discovery.max_selected,
        requireLicense: config.research.codebase_discovery.require_license,
        includeArchived: config.research.codebase_discovery.include_archived,
        languages: config.research.codebase_discovery.languages,
      },
      fulltextMaxSources: config.research.fulltext.max_core_sources,
      allowPdfDownload: config.research.fulltext.allow_pdf_download,
      semanticScreenEnabled: config.research.semantic_screen.enabled,
      outlineReviewEnabled: config.research.outline_review.enabled,
      outlineReviewMaxRounds: config.research.outline_review.max_rounds,
      outlineApprovalMode: config.research.outline_review.approval_mode,
      verificationMaxSources: config.research.verification.max_sources,
      writingStrategy: config.research.writing_strategy,
      experiment: {
        enabled: config.research.experiment.enabled,
        manifestPath: config.research.experiment.manifest_path,
        codebaseId: config.research.experiment.codebase_id,
        inputId: config.research.experiment.input_id,
      },
    },
  });
  await fs.writeFile(path.join(resolved, "malaclaw.yaml"), manifestToYaml(manifest), "utf-8");
  written.push("malaclaw.yaml");

  return { written };
}

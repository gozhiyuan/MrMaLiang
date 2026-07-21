import { useEffect, useState } from "react";
import type { CSSProperties } from "react";
import { Link } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

type LongWriteResponse = {
  dir: string;
  config: ProjectConfig;
  project: { id?: string; name?: string; mode?: string; artifactType?: string; runtimeProfile?: string; authors: Array<{ name: string; email?: string }> };
  research: {
    topic?: string; provider?: string; paperKind?: string; paperProfile?: string;
    targetCandidates?: number; queryBudget?: number; taxonomy: string[];
    codebases: Array<{ id: string; source: string; ref: string; title?: string; role: "primary_artifact" | "supplementary_artifact" }>;
    codebaseDiscovery?: { enabled?: boolean; queryBudget?: number; maxCandidates?: number; maxReadmes?: number; maxSelected?: number };
  };
  writing: {
    targetLengthWords?: number;
    genre?: string;
    audience?: string;
    styleInstructions?: string;
    referenceLinks: string[];
    referenceFiles: string[];
    outputFormats: string[];
  };
  review: { cadence: string; time?: string; intervalHours?: number; batchApprovals: boolean };
  workflow: {
    runtime?: string;
    budgetUsd?: number;
    runtimePolicy: Record<string, unknown>;
    modelTiers: Record<string, unknown>;
    runLimits?: Record<string, unknown> | null;
    stages: Array<{
      id: string;
      title?: string;
      type: "standard" | "foreach" | "loop";
      effectiveRuntime?: string;
      effectiveModel?: string;
      locked?: boolean;
      maxRounds?: number;
      stopWhen?: string;
      children?: WorkspaceData["workflow"]["stages"];
      owner?: string;
      runtime?: string;
      model?: string;
      modelTier?: string;
      requiresHumanApproval: boolean;
      enabled: boolean;
      skippable: boolean;
      maxParallel?: number;
      steps: Array<{ id: string; owner?: string; runtime?: string; model?: string; modelTier?: string; effectiveRuntime?: string; effectiveModel?: string }>;
      outputs: string[];
    }>;
  };
  flow: {
    status: string;
    updatedAt: string;
    units: Record<string, { status: string }>;
    pendingApprovals: Array<{ id: string; stageId: string; stepId?: string; itemId?: string; artifacts?: string[] }>;
  } | null;
  usage: { totalTokens: number; costUsd: number; unitsWithUsage: number } | null;
  logs: Array<{ name: string; content: string; truncated: boolean }>;
  evidence: {
    indexed: boolean; chunks: number; sources: number; sections: number;
    taxonomy: Array<{ cell?: string; source_count?: number }>; ledgerEntries: number;
    fulltext: Record<string, number>; upgrades: Record<string, number>; urlVerification: Record<string, number>;
  };
  currentArtifacts: Array<{ path: string; kind: "pdf" | "text" }>;
  operation: {
    running: boolean;
    pid?: number;
    startedAt: string;
    finishedAt?: string;
    exitCode?: number | null;
    signal?: string | null;
    args: string[];
    stdout: string;
    stderr: string;
  } | null;
  commands: { status: string; run: string; approve: string; sync: string; words: string; packet: string; feedback: string };
};

type ProjectConfig = {
  version: 1;
  project: {
    id: string;
    name?: string;
    artifact_type: string;
    mode: string;
    authors?: Array<{ name: string; email?: string }>;
  };
  runtime_profile?: string;
  research?: {
    provider?: string;
    topic?: string;
    paper_kind?: "survey" | "empirical";
    paper_profile?: "literature_survey" | "repository_study";
    codebases?: Array<{ id: string; source: string; ref?: string; title?: string; role?: "primary_artifact" | "supplementary_artifact" }>;
    codebase_discovery?: { enabled?: boolean; provider?: "github"; query_budget?: number; max_candidates?: number; max_readme_fetches?: number; max_selected?: number; require_license?: boolean; include_archived?: boolean; languages?: string[] };
    target_candidates?: number;
    query_budget?: number;
    taxonomy?: string[];
    source_policy?: { min_recent_ratio?: number; min_verified_ratio?: number; max_arxiv_only_ratio?: number; require_live_urls?: boolean };
    fulltext?: { max_core_sources?: number; allow_pdf_download?: boolean };
    verification?: { max_sources?: number };
    writing_strategy?: "scaffold_then_revise" | "llm_sections";
    retrieval?: { backend?: "sqlite_fts" | "hybrid_openai"; embedding_model?: string };
  };
  writing?: {
    target_length_words?: number;
    genre?: string;
    audience?: string;
    style_instructions?: string;
    reference_instructions?: string;
    reference_links?: string[];
    reference_files?: string[];
    output_formats?: Array<"markdown" | "pdf">;
    workflow_profile?: "fast" | "standard" | "deep";
  };
  review?: {
    cadence?: "manual" | "daily" | "interval";
    time?: string;
    interval_hours?: number;
    batch_approvals?: boolean;
  };
  run_limits?: {
    max_recorded_tokens?: number;
    max_unit_minutes?: number;
    max_active_run_minutes?: number;
    on_limit?: "pause";
  };
  figures?: {
    backends?: {
      nanobanana?: { enabled?: boolean; budget_usd?: number; requires_approval?: boolean; model?: string };
    };
  };
  publication?: {
    target?: "arxiv" | "custom";
    anonymous?: boolean;
    page_limit?: number;
    required_sections?: string[];
    template_dir?: string;
    document_class?: string;
    document_class_options?: string[];
  };
  execution?: { stage_overrides?: Record<string, unknown> };
};

type InitDraft = {
  dir: string;
  mode: "auto_research_agentic" | "novel" | "technical_book";
  topic: string;
  name: string;
  researchProvider: string;
  researchWorkflowProfile: "fast" | "standard" | "deep";
  targetLengthWords: string;
  authors: string;
  genre: string;
  audience: string;
  style: string;
  outputPdf: boolean;
  runtimeProfile: "default" | "codex_first" | "claude_first" | "claude_advisor_sonnet";
  referenceLinks: string;
  referenceFiles: string;
  repositories: string;
  discoverRepositories: boolean;
  repositoryQueryBudget: string;
  repositoryMaxCandidates: string;
  repositoryMaxReadmes: string;
  repositoryMaxSelected: string;
  repositoryLanguages: string;
  includeArchivedRepositories: boolean;
  allowUnlicensedRepositories: boolean;
  reviewCadence: "manual" | "daily" | "interval";
  reviewTime: string;
  reviewIntervalHours: string;
  batchApprovals: boolean;
};

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error((body as { error?: string }).error ?? `HTTP ${res.status}`);
  }
  return res.json();
}

function useLongWrite(dir: string) {
  return useQuery<LongWriteResponse>({
    queryKey: ["longwrite", dir],
    queryFn: () => getJson(`/api/longwrite?dir=${encodeURIComponent(dir)}`),
    enabled: dir.length > 0,
    refetchInterval: 3000,
    retry: false,
  });
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={{ border: "1px solid #30363d", borderRadius: 6, padding: 12 }}>
      <h4 style={{ color: "#f0f6fc", margin: "0 0 8px" }}>{title}</h4>
      {children}
    </div>
  );
}

function Command({ value }: { value: string }) {
  return (
    <code style={{
      display: "block",
      color: "#c9d1d9",
      background: "#0d1117",
      border: "1px solid #30363d",
      borderRadius: 6,
      padding: "8px 10px",
      whiteSpace: "pre-wrap",
      overflowWrap: "anywhere",
      fontSize: 12,
    }}>
      {value}
    </code>
  );
}

function smallLabel(value: string) {
  return <span style={{ color: "#8b949e", fontSize: 12 }}>{value}</span>;
}

function formatAuthors(authors: Array<{ name: string; email?: string }> = []): string {
  return authors.map((author) => author.email ? `${author.name} <${author.email}>` : author.name).join("\n");
}

function parseAuthors(value: string): Array<{ name: string; email?: string }> {
  return value
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const match = line.match(/^(.*?)\s*<([^<>]+)>$/);
      if (!match) return { name: line };
      return { name: match[1].trim(), email: match[2].trim() };
    })
    .filter((author) => author.name.length > 0);
}

function codebaseId(source: string, index: number, used: Set<string>): string {
  const raw = source.replace(/\/$/, "").split("/").pop()?.replace(/\.git$/i, "") || `repository-${index + 1}`;
  const base = raw.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "") || `repository-${index + 1}`;
  let id = `repo-${base}`;
  let suffix = 2;
  while (used.has(id)) id = `repo-${base}-${suffix++}`;
  used.add(id);
  return id;
}

function codebasesFromText(value: string, existing: NonNullable<ProjectConfig["research"]>["codebases"] = []) {
  const sources = value.split("\n").map((line) => line.trim()).filter(Boolean);
  const bySource = new Map((existing ?? []).map((entry) => [entry.source, entry]));
  const used = new Set<string>();
  return sources.map((source, index) => {
    const previous = bySource.get(source);
    const id = previous?.id && !used.has(previous.id) ? previous.id : codebaseId(source, index, used);
    used.add(id);
    return {
      id,
      source,
      ref: previous?.ref ?? "HEAD",
      title: previous?.title,
      role: previous?.role ?? (index === 0 ? "primary_artifact" as const : "supplementary_artifact" as const),
    };
  });
}

async function postJson<T>(url: string, body: unknown): Promise<T> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const payload = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error((payload as { error?: string }).error ?? `HTTP ${res.status}`);
  }
  return res.json();
}

function RolesSection({ dir }: { dir: string }) {
  const queryClient = useQueryClient();
  const [selectedOwner, setSelectedOwner] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const roles = useQuery<{ roles: Array<{ owner: string; content: string }> }>({
    queryKey: ["longwrite-roles", dir],
    queryFn: () => getJson(`/api/longwrite/roles?dir=${encodeURIComponent(dir)}`),
    enabled: dir.length > 0,
  });
  const save = useMutation({
    mutationFn: () => postJson("/api/longwrite/roles", { dir, owner: selectedOwner, content: draft }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["longwrite-roles", dir] }),
  });
  const entries = roles.data?.roles ?? [];
  const active = entries.find((r) => r.owner === selectedOwner) ?? null;
  return (
    <Section title="Owner Personas (roles/)">
      <details>
        <summary style={{ color: "#8b949e", cursor: "pointer", fontSize: 12 }}>
          Advanced prompt editing — {entries.length} owner persona{entries.length === 1 ? "" : "s"}; does not select a model.
        </summary>
        <div style={{ color: "#8b949e", fontSize: 12, margin: "10px 0 8px" }}>
          A role file is injected into prompts for LLM-owned stages with that owner. It supplies
          task guidance and boundaries; runtime/model selection is configured separately. Role files
          are durable workspace files and are not touched by longwrite sync.
        </div>
        {entries.length === 0 ? (
          <div style={{ color: "#8b949e", fontSize: 13 }}>No roles/ directory — re-run longwrite init or create roles/&lt;owner&gt;.md.</div>
        ) : (
          <>
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: active ? 10 : 0 }}>
              {entries.map((role) => (
                <button
                  key={role.owner}
                  onClick={() => { setSelectedOwner(role.owner); setDraft(role.content); save.reset(); }}
                  style={{
                    padding: "4px 7px", borderRadius: 5, cursor: "pointer",
                    border: role.owner === selectedOwner ? "1px solid #58a6ff" : "1px solid #30363d",
                    background: role.owner === selectedOwner ? "#0d2138" : "#0d1117",
                    color: role.owner === selectedOwner ? "#58a6ff" : "#c9d1d9",
                    fontFamily: "monospace", fontSize: 12,
                  }}
                >{role.owner}</button>
              ))}
            </div>
            {active ? (
              <div style={{ minWidth: 0 }}>
                <div style={{ display: "flex", justifyContent: "space-between", gap: 8, alignItems: "center", marginBottom: 6 }}>
                  <strong style={{ color: "#c9d1d9", fontFamily: "monospace", fontSize: 13 }}>{active.owner}</strong>
                  <button
                    onClick={() => { setSelectedOwner(null); setDraft(""); save.reset(); }}
                    style={{ padding: "3px 8px", borderRadius: 5, border: "1px solid #30363d", background: "#21262d", color: "#c9d1d9", cursor: "pointer", fontSize: 12 }}
                  >Close editor</button>
                </div>
                <textarea
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  rows={12}
                  style={{
                    width: "100%", minWidth: 0, boxSizing: "border-box", padding: 8, borderRadius: 6,
                    border: "1px solid #30363d", background: "#0d1117", color: "#c9d1d9",
                    fontFamily: "monospace", fontSize: 12,
                  }}
                />
                <div style={{ display: "flex", gap: 10, alignItems: "center", marginTop: 6, flexWrap: "wrap" }}>
                  <button
                    onClick={() => save.mutate()}
                    disabled={save.isPending || draft.trim().length === 0}
                    style={{
                      padding: "6px 12px", borderRadius: 6, border: "1px solid #30363d",
                      background: "#238636", color: "#fff", cursor: save.isPending ? "wait" : "pointer",
                    }}
                  >Save persona</button>
                  {save.isSuccess ? <span style={{ color: "#3fb950", fontSize: 12 }}>saved — applies from the next run</span> : null}
                  {save.isError ? <span style={{ color: "#f85149", fontSize: 12 }}>{String(save.error)}</span> : null}
                </div>
              </div>
            ) : null}
          </>
        )}
      </details>
    </Section>
  );
}

export function LongWrite() {
  const [dir, setDir] = useState(() => localStorage.getItem("longwrite-dir") ?? "");
  const [input, setInput] = useState(dir);
  const [operationMessage, setOperationMessage] = useState<string | null>(null);
  const [runtimeOverride, setRuntimeOverride] = useState("");
  const [draftConfig, setDraftConfig] = useState<ProjectConfig | null>(null);
  const [feedbackText, setFeedbackText] = useState("");
  const [outlineRevisionText, setOutlineRevisionText] = useState("");
  const [selectedStageId, setSelectedStageId] = useState<string | null>(null);
  const [selectedApprovalArtifact, setSelectedApprovalArtifact] = useState<string | null>(null);
  const [selectedCurrentArtifact, setSelectedCurrentArtifact] = useState<string | null>(null);
  const [stagePatch, setStagePatch] = useState<{ runtime: string; model: string; modelTier: string; requiresHumanApproval: boolean; enabled: boolean; maxParallel: string }>({
    runtime: "",
    model: "",
    modelTier: "",
    requiresHumanApproval: false,
    enabled: true,
    maxParallel: "",
  });
  const [initDraft, setInitDraft] = useState<InitDraft>({
    dir: "",
    // This form is the product demo entry point. Keep the stable V2 option
    // available, but start new dashboard demos on the bounded adaptive alpha
    // so the workflow graph exposes the action-plan/dispatcher behavior.
    mode: "auto_research_agentic",
    topic: "",
    name: "",
    researchProvider: "multi",
    researchWorkflowProfile: "deep",
    targetLengthWords: "",
    authors: "",
    genre: "",
    audience: "",
    style: "",
    outputPdf: false,
    runtimeProfile: "default",
    referenceLinks: "",
    referenceFiles: "",
    repositories: "",
    discoverRepositories: false,
    repositoryQueryBudget: "10",
    repositoryMaxCandidates: "40",
    repositoryMaxReadmes: "12",
    repositoryMaxSelected: "8",
    repositoryLanguages: "",
    includeArchivedRepositories: false,
    allowUnlicensedRepositories: false,
    reviewCadence: "manual",
    reviewTime: "08:00",
    reviewIntervalHours: "4",
    batchApprovals: false,
  });
  const queryClient = useQueryClient();
  const { data, error, isLoading } = useLongWrite(dir);

  useEffect(() => {
    if (data?.config) setDraftConfig(data.config);
  }, [data?.dir, data?.config]);

  useEffect(() => {
    const stage = data?.workflow.stages.find((entry) => entry.id === selectedStageId);
    if (!stage) return;
    setStagePatch({
      runtime: stage.runtime ?? "",
      model: stage.model ?? "",
      modelTier: stage.modelTier ?? "",
      requiresHumanApproval: stage.requiresHumanApproval,
      enabled: stage.enabled,
      maxParallel: stage.maxParallel != null ? String(stage.maxParallel) : "",
    });
  }, [data?.workflow.stages, selectedStageId]);

  const approve = useMutation({
    mutationFn: (body: { approvalId?: string; batch?: boolean }) =>
      postJson<{ ok: boolean }>("/api/longwrite/approve", { dir, ...body }),
    onSuccess: (_, body) => {
      setOperationMessage(body.batch ? "Approved all pending approvals." : "Approved pending item.");
      queryClient.invalidateQueries({ queryKey: ["longwrite", dir] });
    },
    onError: (err) => setOperationMessage(err instanceof Error ? err.message : String(err)),
  });

  const packet = useMutation({
    mutationFn: () => postJson<{ ok: boolean; artifact: string; stdout?: string }>("/api/longwrite/packet", { dir }),
    onSuccess: (result) => {
      setOperationMessage(`Generated ${result.artifact}.`);
      queryClient.invalidateQueries({ queryKey: ["longwrite", dir] });
    },
    onError: (err) => setOperationMessage(err instanceof Error ? err.message : String(err)),
  });

  const run = useMutation({
    mutationFn: (body: { runtime?: string; reset?: boolean }) =>
      postJson<{ ok: boolean; operation: LongWriteResponse["operation"] }>("/api/longwrite/run", { dir, ...body }),
    onSuccess: (_, body) => {
      setOperationMessage(body.reset ? "Started LongWrite reset run." : "Started LongWrite run.");
      queryClient.invalidateQueries({ queryKey: ["longwrite", dir] });
    },
    onError: (err) => setOperationMessage(err instanceof Error ? err.message : String(err)),
  });

  const retry = useMutation({
    mutationFn: () => postJson<{ ok: boolean; stdout?: string }>("/api/longwrite/retry", { dir }),
    onSuccess: () => {
      setOperationMessage("Cleared failed units. Click Run to resume without resetting completed work.");
      queryClient.invalidateQueries({ queryKey: ["longwrite", dir] });
    },
    onError: (err) => setOperationMessage(err instanceof Error ? err.message : String(err)),
  });

  const approvalArtifact = useQuery<{ path: string; content: string; truncated: boolean }>({
    queryKey: ["longwrite-approval-artifact", dir, selectedApprovalArtifact],
    queryFn: () => getJson(`/api/longwrite/approval-artifact?dir=${encodeURIComponent(dir)}&path=${encodeURIComponent(selectedApprovalArtifact ?? "")}`),
    enabled: dir.length > 0 && selectedApprovalArtifact !== null,
    retry: false,
  });
  const currentArtifact = useQuery<{ path: string; content: string; truncated: boolean }>({
    queryKey: ["longwrite-current-artifact", dir, selectedCurrentArtifact],
    queryFn: () => getJson(`/api/longwrite/current-artifact?dir=${encodeURIComponent(dir)}&path=${encodeURIComponent(selectedCurrentArtifact ?? "")}`),
    enabled: dir.length > 0 && selectedCurrentArtifact !== null,
    retry: false,
  });

  const reviseOutline = useMutation({
    mutationFn: (message: string) => postJson<{ ok: boolean; artifact: string }>("/api/longwrite/outline/revise", { dir, message }),
    onSuccess: (result) => {
      setOutlineRevisionText("");
      setSelectedApprovalArtifact(null);
      setOperationMessage(`Recorded ${result.artifact}; the outline and downstream stages are reopened. Click Run to generate the revision.`);
      queryClient.invalidateQueries({ queryKey: ["longwrite", dir] });
    },
    onError: (err) => setOperationMessage(err instanceof Error ? err.message : String(err)),
  });

  const [yamlToolsResult, setYamlToolsResult] = useState<{ ok: boolean; text: string } | null>(null);
  const yamlTools = useMutation({
    mutationFn: async (action: "sync" | "validate") => {
      if (action === "sync") {
        const result = await postJson<{ ok: boolean; output: string }>("/api/longwrite/sync", { dir });
        return { ok: result.ok, text: result.output || "synced project_brief.md + malaclaw.yaml from longwrite.yaml" };
      }
      const result = await postJson<{ ok: boolean; findings: string[] }>("/api/longwrite/validate", { dir });
      return { ok: result.ok, text: result.findings.join("\n") };
    },
    onSuccess: (result) => {
      setYamlToolsResult(result);
      queryClient.invalidateQueries({ queryKey: ["longwrite", dir] });
    },
    onError: (err) => setYamlToolsResult({ ok: false, text: String(err) }),
  });

  const saveConfig = useMutation({
    mutationFn: (config: ProjectConfig) =>
      postJson<{ ok: boolean; path: string; synced?: string[] }>("/api/longwrite/config", { dir, config }),
    onSuccess: () => {
      setOperationMessage("Saved longwrite.yaml and synced derived files.");
      queryClient.invalidateQueries({ queryKey: ["longwrite", dir] });
    },
    onError: (err) => setOperationMessage(err instanceof Error ? err.message : String(err)),
  });

  const saveStage = useMutation({
    mutationFn: () =>
      postJson<{ ok: boolean; warning?: string }>("/api/longwrite/workflow/stage", {
        dir,
        stageId: selectedStageId,
        runtime: stagePatch.runtime,
        model: stagePatch.model,
        modelTier: stagePatch.modelTier,
        requiresHumanApproval: selectedStage?.type === "standard" ? stagePatch.requiresHumanApproval : undefined,
        enabled: selectedStage?.skippable ? stagePatch.enabled : undefined,
        maxParallel: stagePatch.maxParallel ? Number(stagePatch.maxParallel) : null,
      }),
    onSuccess: (result) => {
      setOperationMessage(result.warning ?? "Saved durable workflow stage override.");
      queryClient.invalidateQueries({ queryKey: ["longwrite", dir] });
    },
    onError: (err) => setOperationMessage(err instanceof Error ? err.message : String(err)),
  });

  const addFeedback = useMutation({
    mutationFn: (message: string) =>
      postJson<{ ok: boolean; artifact: string }>("/api/longwrite/feedback", { dir, message }),
    onSuccess: (result) => {
      setOperationMessage(`Recorded feedback in ${result.artifact}.`);
      setFeedbackText("");
      queryClient.invalidateQueries({ queryKey: ["longwrite", dir] });
    },
    onError: (err) => setOperationMessage(err instanceof Error ? err.message : String(err)),
  });

  const createWorkspace = useMutation({
    mutationFn: (draft: InitDraft) =>
      postJson<{ ok: boolean; dir: string; stdout?: string }>("/api/longwrite/init", {
        dir: draft.dir,
        mode: draft.mode,
        topic: draft.topic,
        name: draft.name || undefined,
        researchProvider: draft.researchProvider || undefined,
        researchWorkflowProfile: draft.researchWorkflowProfile,
        authors: parseAuthors(draft.authors),
        targetLengthWords: draft.targetLengthWords ? Number(draft.targetLengthWords) : undefined,
        genre: draft.genre || undefined,
        audience: draft.audience || undefined,
        style: draft.style || undefined,
        outputFormats: draft.outputPdf ? ["markdown", "pdf"] : ["markdown"],
        runtimeProfile: draft.runtimeProfile === "default" ? undefined : draft.runtimeProfile,
        referenceLinks: draft.referenceLinks.split("\n").map((v) => v.trim()).filter(Boolean),
        referenceFiles: draft.referenceFiles.split("\n").map((v) => v.trim()).filter(Boolean),
        repositories: draft.repositories.split("\n").map((v) => v.trim()).filter(Boolean),
        discoverRepositories: draft.discoverRepositories,
        repositoryQueryBudget: draft.discoverRepositories ? Number(draft.repositoryQueryBudget) : undefined,
        repositoryMaxCandidates: draft.discoverRepositories ? Number(draft.repositoryMaxCandidates) : undefined,
        repositoryMaxReadmes: draft.discoverRepositories ? Number(draft.repositoryMaxReadmes) : undefined,
        repositoryMaxSelected: draft.discoverRepositories ? Number(draft.repositoryMaxSelected) : undefined,
        repositoryLanguages: draft.repositoryLanguages.split(/[\n,]/).map((v) => v.trim()).filter(Boolean),
        includeArchivedRepositories: draft.includeArchivedRepositories,
        allowUnlicensedRepositories: draft.allowUnlicensedRepositories,
        reviewCadence: draft.reviewCadence,
        reviewTime: draft.reviewTime,
        reviewIntervalHours: draft.reviewIntervalHours ? Number(draft.reviewIntervalHours) : undefined,
        batchApprovals: draft.batchApprovals,
      }),
    onSuccess: (result) => {
      setOperationMessage(`Created LongWrite workspace at ${result.dir}.`);
      localStorage.setItem("longwrite-dir", result.dir);
      localStorage.setItem("malaclaw-flow-dir", result.dir);
      setInput(result.dir);
      setDir(result.dir);
      queryClient.invalidateQueries({ queryKey: ["longwrite", result.dir] });
    },
    onError: (err) => setOperationMessage(err instanceof Error ? err.message : String(err)),
  });

  const load = () => {
    localStorage.setItem("longwrite-dir", input);
    localStorage.setItem("malaclaw-flow-dir", input);
    setDir(input);
  };

  const openFlow = () => {
    localStorage.setItem("malaclaw-flow-dir", dir);
  };

  const flowUnits = data?.flow ? Object.values(data.flow.units) : [];
  const succeeded = flowUnits.filter((unit) => unit.status === "succeeded").length;
  const runningUnitKeys = Object.entries(data?.flow?.units ?? {})
    .filter(([, unit]) => unit.status === "running")
    .map(([key]) => key);
  const pending = flowUnits.filter((unit) => unit.status === "pending").length;
  const selectedRuntime = runtimeOverride.trim() || data?.workflow.runtime || undefined;
  // A CLI/supervisor-started flow is not represented by this dashboard's
  // in-memory operation flag. Derive the disabled state from durable flow
  // state as well, so the Run buttons never invite a concurrent launch.
  const runActive = data?.operation?.running === true
    || data?.flow?.status === "running"
    || runningUnitKeys.length > 0;
  const selectedStage = data?.workflow.stages.find((stage) => stage.id === selectedStageId) ?? data?.workflow.stages[0];

  const patchConfig = (patch: (current: ProjectConfig) => ProjectConfig) => {
    setDraftConfig((current) => current ? patch(current) : current);
  };

  const patchInit = (patch: Partial<InitDraft>) => setInitDraft((current) => ({ ...current, ...patch }));

  const inputStyle: CSSProperties = {
    display: "block",
    width: "100%",
    boxSizing: "border-box",
    marginTop: 4,
    padding: "6px 8px",
    borderRadius: 6,
    border: "1px solid #30363d",
    background: "#0d1117",
    color: "#c9d1d9",
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12, maxWidth: 1120 }}>
      <div style={{ display: "flex", gap: 8 }}>
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && load()}
          placeholder="/absolute/path/to/longwrite-workspace"
          style={{
            flex: 1,
            padding: "6px 10px",
            borderRadius: 6,
            fontFamily: "monospace",
            fontSize: 13,
            background: "#0d1117",
            color: "#c9d1d9",
            border: "1px solid #30363d",
          }}
        />
        <button onClick={load} style={{
          padding: "6px 14px",
          borderRadius: 6,
          border: "1px solid #30363d",
          background: "#1f6feb",
          color: "#fff",
          cursor: "pointer",
        }}>Open</button>
      </div>

      {!dir && <div style={{ color: "#8b949e" }}>Enter a LongWrite workspace directory.</div>}
      {isLoading && dir && <div style={{ color: "#8b949e" }}>Loading LongWrite workspace...</div>}
      {error != null && <div style={{ color: "#f85149" }}>Error: {String(error)}</div>}
      {operationMessage && <div style={{ color: operationMessage.includes("failed") || operationMessage.includes("not found") ? "#f85149" : "#8b949e" }}>{operationMessage}</div>}

      <Section title="Create Workspace">
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 10 }}>
          <label style={{ color: "#8b949e", fontSize: 12 }}>
            Directory
            <input value={initDraft.dir} onChange={(e) => patchInit({ dir: e.target.value })} placeholder="/absolute/path/to/new-workspace" style={inputStyle} />
          </label>
          <label style={{ color: "#8b949e", fontSize: 12 }}>
            Mode
            <select value={initDraft.mode} onChange={(e) => {
              const mode = e.target.value as InitDraft["mode"];
              patchInit({
                mode,
                ...(mode === "auto_research_agentic" ? { researchProvider: "multi", researchWorkflowProfile: "deep" } : {}),
              });
            }} style={inputStyle}>
              <option value="auto_research_agentic">auto_research_agentic (research paper; alpha, bounded adaptive remediation)</option>
              <option value="novel">novel</option>
              <option value="technical_book">technical_book</option>
            </select>
          </label>
          <label style={{ color: "#8b949e", fontSize: 12 }}>
            Topic / premise
            <input value={initDraft.topic} onChange={(e) => patchInit({ topic: e.target.value })} style={inputStyle} />
          </label>
          <label style={{ color: "#8b949e", fontSize: 12 }}>
            Name
            <input value={initDraft.name} onChange={(e) => patchInit({ name: e.target.value })} style={inputStyle} />
          </label>
          <label style={{ color: "#8b949e", fontSize: 12 }}>
            Target words
            <input type="number" min={1} value={initDraft.targetLengthWords} onChange={(e) => patchInit({ targetLengthWords: e.target.value })} style={inputStyle} />
          </label>
          <label style={{ color: "#8b949e", fontSize: 12 }}>
            Authors
            <textarea value={initDraft.authors} onChange={(e) => patchInit({ authors: e.target.value })} rows={2} placeholder="One per line: Name <email>" style={inputStyle} />
          </label>
          <label style={{ color: "#8b949e", fontSize: 12 }}>
            Genre / category
            <input value={initDraft.genre} onChange={(e) => patchInit({ genre: e.target.value })} style={inputStyle} />
          </label>
          <label style={{ color: "#8b949e", fontSize: 12 }}>
            Audience
            <input value={initDraft.audience} onChange={(e) => patchInit({ audience: e.target.value })} style={inputStyle} />
          </label>
          <label style={{ color: "#8b949e", fontSize: 12 }}>
            Research provider
            <select value={initDraft.researchProvider} onChange={(e) => patchInit({ researchProvider: e.target.value })} style={inputStyle}>
              <option value="seed">seed</option>
              <option value="arxiv">arxiv</option>
              <option value="semantic_scholar">semantic_scholar</option>
              <option value="dblp">dblp</option>
              <option value="crossref">crossref</option>
              <option value="openalex">openalex</option>
              <option value="multi">multi</option>
            </select>
          </label>
          <label style={{ color: "#8b949e", fontSize: 12 }}>
            Workflow profile
            <select value={initDraft.researchWorkflowProfile} onChange={(e) => patchInit({ researchWorkflowProfile: e.target.value as InitDraft["researchWorkflowProfile"] })} style={inputStyle}>
              <option value="fast">fast</option>
              <option value="standard">standard</option>
              <option value="deep">deep</option>
            </select>
          </label>
          <label style={{ color: "#8b949e", fontSize: 12 }}>
            Runtime strategy
            <select value={initDraft.runtimeProfile} onChange={(e) => patchInit({ runtimeProfile: e.target.value as InitDraft["runtimeProfile"] })} style={inputStyle}>
              <option value="default">default</option>
              <option value="codex_first">codex_first</option>
              <option value="claude_first">claude_first</option>
              <option value="claude_advisor_sonnet">claude_advisor_sonnet (legacy)</option>
            </select>
          </label>
          <label style={{ color: "#8b949e", fontSize: 12 }}>
            Review cadence
            <select value={initDraft.reviewCadence} onChange={(e) => patchInit({ reviewCadence: e.target.value as InitDraft["reviewCadence"] })} style={inputStyle}>
              <option value="manual">manual</option>
              <option value="daily">daily</option>
              <option value="interval">interval</option>
            </select>
          </label>
          <label style={{ color: "#8b949e", fontSize: 12 }}>
            Review time
            <input value={initDraft.reviewTime} onChange={(e) => patchInit({ reviewTime: e.target.value })} style={inputStyle} />
          </label>
          <label style={{ color: "#8b949e", fontSize: 12 }}>
            Interval hours
            <input type="number" min={1} value={initDraft.reviewIntervalHours} onChange={(e) => patchInit({ reviewIntervalHours: e.target.value })} style={inputStyle} />
          </label>
          <label style={{ color: "#8b949e", fontSize: 12, display: "flex", gap: 8, alignItems: "center", marginTop: 20 }}>
            <input type="checkbox" checked={initDraft.batchApprovals} onChange={(e) => patchInit({ batchApprovals: e.target.checked })} />
            Batch approvals
          </label>
          <label style={{ color: "#8b949e", fontSize: 12, display: "flex", gap: 8, alignItems: "center", marginTop: 20 }}>
            <input type="checkbox" checked={initDraft.outputPdf} onChange={(e) => patchInit({ outputPdf: e.target.checked })} />
            PDF output
          </label>
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))", gap: 10, marginTop: 10 }}>
          <label style={{ color: "#8b949e", fontSize: 12 }}>
            Style instructions
            <textarea value={initDraft.style} onChange={(e) => patchInit({ style: e.target.value })} rows={3} style={inputStyle} />
          </label>
          <label style={{ color: "#8b949e", fontSize: 12 }}>
            Reference links
            <textarea value={initDraft.referenceLinks} onChange={(e) => patchInit({ referenceLinks: e.target.value })} rows={3} placeholder="One public URL per line (context/style lead)" style={inputStyle} />
          </label>
          <label style={{ color: "#8b949e", fontSize: 12 }}>
            Reference files
            <textarea value={initDraft.referenceFiles} onChange={(e) => patchInit({ referenceFiles: e.target.value })} rows={3} placeholder="One workspace-local path per line, e.g. references/brief.pdf" style={inputStyle} />
          </label>
          {initDraft.mode === "auto_research_agentic" && <label style={{ color: "#8b949e", fontSize: 12 }}>
            Repository evidence (optional)
            <textarea value={initDraft.repositories} onChange={(e) => patchInit({ repositories: e.target.value })} rows={3} placeholder="One Git URL or local Git path per line" style={inputStyle} />
          </label>}
          {initDraft.mode === "auto_research_agentic" && <div style={{ color: "#8b949e", fontSize: 12, border: "1px solid #30363d", borderRadius: 6, padding: 10 }}>
            <label style={{ display: "flex", gap: 8, alignItems: "center", color: "#c9d1d9" }}>
              <input type="checkbox" checked={initDraft.discoverRepositories} onChange={(e) => patchInit({ discoverRepositories: e.target.checked })} />
              Discover related GitHub repositories
            </label>
            {initDraft.discoverRepositories && <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginTop: 8 }}>
              <label>Queries<input type="number" min={1} max={20} value={initDraft.repositoryQueryBudget} onChange={(e) => patchInit({ repositoryQueryBudget: e.target.value })} style={inputStyle} /></label>
              <label>Candidates<input type="number" min={1} max={100} value={initDraft.repositoryMaxCandidates} onChange={(e) => patchInit({ repositoryMaxCandidates: e.target.value })} style={inputStyle} /></label>
              <label>README fetches<input type="number" min={0} max={40} value={initDraft.repositoryMaxReadmes} onChange={(e) => patchInit({ repositoryMaxReadmes: e.target.value })} style={inputStyle} /></label>
              <label>Selected repos<input type="number" min={1} max={10} value={initDraft.repositoryMaxSelected} onChange={(e) => patchInit({ repositoryMaxSelected: e.target.value })} style={inputStyle} /></label>
              <label style={{ gridColumn: "1 / -1" }}>Languages<input value={initDraft.repositoryLanguages} onChange={(e) => patchInit({ repositoryLanguages: e.target.value })} placeholder="Python, TypeScript" style={inputStyle} /></label>
              <label style={{ display: "flex", gap: 6, alignItems: "center" }}><input type="checkbox" checked={initDraft.includeArchivedRepositories} onChange={(e) => patchInit({ includeArchivedRepositories: e.target.checked })} /> include archived</label>
              <label style={{ display: "flex", gap: 6, alignItems: "center" }}><input type="checkbox" checked={initDraft.allowUnlicensedRepositories} onChange={(e) => patchInit({ allowUnlicensedRepositories: e.target.checked })} /> allow unlicensed</label>
            </div>}
          </div>}
        </div>
        <div style={{ color: "#8b949e", fontSize: 12, marginTop: 8 }}>
          Recognized arXiv, DOI, and OpenReview links are resolved as authoritative scholarly seeds; other links remain unverified context. Explicit or discovered repositories switch a research paper to the repository-survey evidence profile, are pinned before use, and are never executed. Copy reference files into <code>references/</code>; research claims still require evidence-packet validation.
        </div>
        <button
          onClick={() => createWorkspace.mutate(initDraft)}
          disabled={createWorkspace.isPending}
          style={{
            marginTop: 10,
            padding: "6px 12px",
            borderRadius: 6,
            border: "1px solid #30363d",
            background: "#238636",
            color: "#fff",
            cursor: createWorkspace.isPending ? "wait" : "pointer",
          }}
        >
          Create workspace
        </button>
      </Section>

      {data && (
        <>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 12 }}>
            <Section title="Project">
              <div style={{ color: "#c9d1d9", lineHeight: 1.7 }}>
                <div>{smallLabel("name")} {data.project.name ?? data.project.id ?? "unknown"}</div>
                <div>{smallLabel("mode")} {data.project.mode ?? "unknown"}</div>
                <div>{smallLabel("artifact")} {data.project.artifactType ?? "unknown"}</div>
                <div>{smallLabel("profile")} {data.project.runtimeProfile ?? "default"}</div>
                <div>{smallLabel("topic")} {data.research.topic ?? "not set"}</div>
                <div>{smallLabel("provider")} {data.research.provider ?? "not set"}</div>
                <div>{smallLabel("paper evidence")} {data.research.paperProfile ?? "literature_survey"}</div>
                <div>{smallLabel("repositories")} {data.research.codebases.length || "none"}</div>
                <div>{smallLabel("GitHub discovery")} {data.research.codebaseDiscovery?.enabled ? `enabled (${data.research.codebaseDiscovery.maxSelected ?? 8} max)` : "disabled"}</div>
                <div>{smallLabel("research target")} {data.research.targetCandidates ?? 100} candidates / {data.research.queryBudget ?? 24} queries</div>
                <div>{smallLabel("audience")} {data.writing.audience ?? "not set"}</div>
                <div>{smallLabel("style")} {data.writing.styleInstructions ?? "not set"}</div>
              </div>
            </Section>

            <RolesSection dir={data.dir} />

            <Section title="Run Policy">
              <div style={{ color: "#c9d1d9", lineHeight: 1.7 }}>
                <div>{smallLabel("runtime")} {data.workflow.runtime ?? "CLI option/default"}</div>
                <div>{smallLabel("provider quota")} not observable by MalaClaw (your subscription plan is the real cap)</div>
                <div>
                  {smallLabel("run limits")}{" "}
                  {data.workflow.runLimits
                    ? Object.entries(data.workflow.runLimits).filter(([k]) => k !== "on_limit")
                        .map(([k, v]) => `${k}=${String(v)}`).join(" · ") + " · on_limit: pause"
                    : "run limits not configured"}
                </div>
                <div>
                  {smallLabel("observed telemetry")}{" "}
                  {data.usage && data.usage.unitsWithUsage > 0
                    ? `${data.usage.totalTokens.toLocaleString()} recorded tokens (all attempts)` +
                      (data.usage.costUsd > 0 ? ` · $${data.usage.costUsd.toFixed(4)} (claude-code estimate, not billing truth)` : " · cost unavailable for this runtime")
                    : "none yet"}
                </div>
                <div>
                  {smallLabel("review")} {data.review.cadence}
                  {data.review.cadence === "daily" && data.review.time ? ` at ${data.review.time}` : ""}
                  {data.review.cadence === "interval" && data.review.intervalHours ? ` every ${data.review.intervalHours}h` : ""}
                  <span style={{ color: "#8b949e" }}> — generates agendas only; no daemon or cron runs</span>
                </div>
                <div>{smallLabel("batch approvals")} {data.review.batchApprovals ? "yes" : "no"}</div>
                <div>{smallLabel("model tiers")} {Object.keys(data.workflow.modelTiers).join(", ") || "none defined by this profile"}</div>
              </div>
            </Section>

            <Section title="Flow">
              <div style={{ color: "#c9d1d9", lineHeight: 1.7 }}>
                <div>{smallLabel("status")} {data.flow?.status ?? "not started"}</div>
                <div>{smallLabel("units")} {data.flow ? `${succeeded}/${flowUnits.length} succeeded · ${runningUnitKeys.length} running · ${pending} pending` : "no state"}</div>
                {runningUnitKeys.length > 0 && <div>{smallLabel("active stage")} <code style={{ color: "#d29922" }}>{runningUnitKeys.join(", ")}</code></div>}
                <div>{smallLabel("approvals")} {data.flow?.pendingApprovals.length ?? 0}</div>
                <div>{smallLabel("tokens")} {data.usage ? data.usage.totalTokens.toLocaleString() : "unknown"}</div>
                <div>{smallLabel("cost")} {data.usage && data.usage.costUsd > 0 ? `$${data.usage.costUsd.toFixed(4)}` : "unknown"}</div>
              </div>
              <div style={{ marginTop: 8 }}>
                <Link to="/flow" onClick={openFlow} style={{ color: "#58a6ff", fontSize: 13 }}>Open flow monitor</Link>
              </div>
            </Section>

            <Section title="Evidence Corpus">
              <div style={{ color: "#c9d1d9", lineHeight: 1.7 }}>
                <div>{smallLabel("index")} {data.evidence.indexed ? "SQLite FTS ready" : "not built"}</div>
                <div>{smallLabel("chunks")} {data.evidence.chunks.toLocaleString()}</div>
                <div>{smallLabel("cached sources")} {data.evidence.sources}</div>
                <div>{smallLabel("section packets")} {data.evidence.sections}</div>
                <div>{smallLabel("citation ledger")} {data.evidence.ledgerEntries} entries</div>
                <div>{smallLabel("full text")} {data.evidence.fulltext.ingested ?? 0} ingested / {data.evidence.fulltext.failed ?? 0} failed</div>
                <div>{smallLabel("metadata upgrades")} {data.evidence.upgrades.upgraded ?? 0} upgraded / {data.evidence.upgrades.no_match ?? 0} no match</div>
                <div>{smallLabel("citation URLs")} {data.evidence.urlVerification.live ?? 0} live, {data.evidence.urlVerification.redirect ?? 0} redirects, {data.evidence.urlVerification.dead ?? 0} dead</div>
              </div>
            </Section>
          </div>

          <Section title="Operations">
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              <select
                value={runtimeOverride || data.workflow.runtime || "codex"}
                onChange={(e) => setRuntimeOverride(e.target.value)}
                disabled={runActive}
                style={{
                  minWidth: 180,
                  padding: "6px 10px",
                  borderRadius: 6,
                  fontFamily: "monospace",
                  fontSize: 13,
                  background: "#0d1117",
                  color: "#c9d1d9",
                  border: "1px solid #30363d",
                }}
                aria-label="Worker runtime for this run"
              >
                <option value="codex">codex</option>
                <option value="claude-code">claude-code</option>
                <option value="dry-run">dry-run</option>
                <option value="openai-api">openai-api</option>
                <option value="openai-compatible">openai-compatible</option>
                <option value="anthropic-api">anthropic-api</option>
                <option value="gemini-api">gemini-api</option>
                <option value="ollama">ollama</option>
              </select>
              <button
                onClick={() => run.mutate({ runtime: selectedRuntime })}
                disabled={runActive || run.isPending}
                style={{
                  padding: "6px 12px",
                  borderRadius: 6,
                  border: "1px solid #30363d",
                  background: runActive ? "#21262d" : "#1f6feb",
                  color: "#fff",
                  cursor: runActive ? "not-allowed" : "pointer",
                }}
              >
                Run
              </button>
              <button
                onClick={() => run.mutate({ runtime: selectedRuntime, reset: true })}
                disabled={runActive || run.isPending}
                style={{
                  padding: "6px 12px",
                  borderRadius: 6,
                  border: "1px solid #30363d",
                  background: runActive ? "#21262d" : "#8957e5",
                  color: "#fff",
                  cursor: runActive ? "not-allowed" : "pointer",
                }}
              >
                Reset + run
              </button>
              <button
                onClick={() => retry.mutate()}
                disabled={runActive || retry.isPending}
                style={{
                  padding: "6px 12px",
                  borderRadius: 6,
                  border: "1px solid #30363d",
                  background: runActive ? "#21262d" : "#d29922",
                  color: "#fff",
                  cursor: runActive ? "not-allowed" : "pointer",
                }}
              >
                Retry failed
              </button>
              <button
                onClick={() => approve.mutate({ batch: true })}
                disabled={!data.flow?.pendingApprovals.length || approve.isPending}
                style={{
                  padding: "6px 12px",
                  borderRadius: 6,
                  border: "1px solid #30363d",
                  background: data.flow?.pendingApprovals.length ? "#238636" : "#21262d",
                  color: "#fff",
                  cursor: data.flow?.pendingApprovals.length ? "pointer" : "not-allowed",
                }}
              >
                Approve all
              </button>
              <button
                onClick={() => packet.mutate()}
                disabled={packet.isPending}
                style={{
                  padding: "6px 12px",
                  borderRadius: 6,
                  border: "1px solid #30363d",
                  background: "#1f6feb",
                  color: "#fff",
                  cursor: packet.isPending ? "wait" : "pointer",
                }}
              >
                Generate packet
              </button>
            </div>
            {data.flow?.pendingApprovals.length ? (
              <div style={{ marginTop: 8, display: "grid", gap: 6 }}>
                {data.flow.pendingApprovals.map((approval) => (
                  <div key={approval.id} style={{ display: "flex", alignItems: "center", gap: 8, color: "#8b949e", fontSize: 13 }}>
                    <button
                      onClick={() => approve.mutate({ approvalId: approval.id })}
                      disabled={approve.isPending}
                      style={{
                        padding: "3px 8px",
                        borderRadius: 6,
                        border: "1px solid #30363d",
                        background: "#238636",
                        color: "#fff",
                        cursor: "pointer",
                      }}
                    >
                      Approve
                    </button>
                    <code style={{ color: "#c9d1d9" }}>{approval.id}</code>
                    <span>{[approval.stageId, approval.stepId, approval.itemId].filter(Boolean).join(" / ")}</span>
                    {(approval.artifacts ?? []).map((artifact) => (
                      <button
                        key={artifact}
                        onClick={() => setSelectedApprovalArtifact(artifact)}
                        style={{
                          padding: 0,
                          border: "none",
                          background: "transparent",
                          color: "#58a6ff",
                          cursor: "pointer",
                          fontFamily: "monospace",
                          fontSize: 12,
                          textDecoration: "underline",
                        }}
                      >
                        {artifact}
                      </button>
                    ))}
                  </div>
                ))}
                {selectedApprovalArtifact && (
                  <div style={{ marginTop: 8, border: "1px solid #30363d", borderRadius: 6, padding: 10 }}>
                    <div style={{ display: "flex", justifyContent: "space-between", gap: 8, alignItems: "center" }}>
                      <strong style={{ color: "#c9d1d9", fontFamily: "monospace", fontSize: 13 }}>{selectedApprovalArtifact}</strong>
                      <button
                        onClick={() => setSelectedApprovalArtifact(null)}
                        style={{ padding: "3px 8px", borderRadius: 5, border: "1px solid #30363d", background: "#21262d", color: "#c9d1d9", cursor: "pointer", fontSize: 12 }}
                      >Close</button>
                    </div>
                    {approvalArtifact.isLoading && <div style={{ color: "#8b949e", marginTop: 8 }}>Loading artifact…</div>}
                    {approvalArtifact.error && <div style={{ color: "#f85149", marginTop: 8 }}>{String(approvalArtifact.error)}</div>}
                    {approvalArtifact.data && <pre style={{ margin: "8px 0 0", maxHeight: 480, overflow: "auto", whiteSpace: "pre-wrap", color: "#c9d1d9", fontSize: 12 }}>{approvalArtifact.data.content}{approvalArtifact.data.truncated ? "\n\n[Preview truncated]" : ""}</pre>}
                  </div>
                )}
                {data.flow.pendingApprovals.some((approval) => approval.stageId === "outline") && (
                  <div style={{ marginTop: 8, border: "1px solid #d29922", borderRadius: 6, padding: 10 }}>
                    <div style={{ color: "#d29922", fontWeight: 600, fontSize: 13 }}>Request outline revision</div>
                    <div style={{ color: "#8b949e", fontSize: 12, marginTop: 4 }}>Do not approve yet. The request reopens only outline and downstream stages; completed research and evidence work remains preserved.</div>
                    <textarea
                      value={outlineRevisionText}
                      onChange={(e) => setOutlineRevisionText(e.target.value)}
                      placeholder="e.g. Add a section comparing episodic and semantic memory; move safety before evaluation; keep the survey scope focused on deployed LLM agents."
                      style={{ ...inputStyle, minHeight: 86 }}
                    />
                    <button
                      onClick={() => reviseOutline.mutate(outlineRevisionText)}
                      disabled={reviseOutline.isPending || outlineRevisionText.trim().length === 0}
                      style={{ marginTop: 8, padding: "6px 10px", borderRadius: 6, border: "1px solid #30363d", background: outlineRevisionText.trim().length ? "#d29922" : "#21262d", color: "#fff", cursor: outlineRevisionText.trim().length ? "pointer" : "not-allowed" }}
                    >
                      Request revision
                    </button>
                  </div>
                )}
              </div>
            ) : (
              <div style={{ marginTop: 8, color: "#8b949e", fontSize: 13 }}>No pending approvals.</div>
            )}
            {data.operation && (
              <div style={{ marginTop: 10, color: "#8b949e", fontSize: 13 }}>
                <div>
                  <span style={{ color: data.operation.running ? "#d29922" : data.operation.exitCode === 0 ? "#3fb950" : "#f85149" }}>
                    {data.operation.running ? "running" : `finished ${data.operation.exitCode ?? data.operation.signal ?? "unknown"}`}
                  </span>
                  {" "}started {data.operation.startedAt}
                  {data.operation.pid ? ` · pid ${data.operation.pid}` : ""}
                </div>
                <code style={{ display: "block", marginTop: 4, color: "#c9d1d9" }}>
                  longwrite {data.operation.args.join(" ")}
                </code>
              </div>
            )}
          </Section>

          <Section title="Current Manuscript and Adaptive Artifacts">
            <div style={{ color: "#8b949e", fontSize: 13, lineHeight: 1.5 }}>
              Inspect the latest manuscript and, in agentic mode, the validated action plan, dispatcher record, and any operator clarification. A running review may still be scoring an earlier build; use the PDF build report and the next review round to confirm the current state.
            </div>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 10 }}>
              {data.currentArtifacts.length === 0 ? (
                <span style={{ color: "#8b949e", fontSize: 13 }}>No manuscript artifacts have been generated yet.</span>
              ) : data.currentArtifacts.map((artifact) => artifact.kind === "pdf" ? (
                <a
                  key={artifact.path}
                  href={`/api/longwrite/current-artifact?dir=${encodeURIComponent(dir)}&path=${encodeURIComponent(artifact.path)}`}
                  target="_blank"
                  rel="noreferrer"
                  style={{ padding: "6px 10px", borderRadius: 6, border: "1px solid #58a6ff", background: "#0d419d", color: "#fff", fontFamily: "monospace", fontSize: 12, textDecoration: "none" }}
                >
                  Open latest PDF
                </a>
              ) : (
                <button
                  key={artifact.path}
                  onClick={() => setSelectedCurrentArtifact(artifact.path)}
                  style={{ padding: "6px 10px", borderRadius: 6, border: "1px solid #30363d", background: selectedCurrentArtifact === artifact.path ? "#1f6feb" : "#21262d", color: "#c9d1d9", cursor: "pointer", fontFamily: "monospace", fontSize: 12 }}
                >
                  {artifact.path}
                </button>
              ))}
            </div>
            {selectedCurrentArtifact && (
              <div style={{ marginTop: 10, border: "1px solid #30363d", borderRadius: 6, padding: 10 }}>
                <div style={{ display: "flex", justifyContent: "space-between", gap: 8, alignItems: "center" }}>
                  <strong style={{ color: "#c9d1d9", fontFamily: "monospace", fontSize: 13 }}>{selectedCurrentArtifact}</strong>
                  <button
                    onClick={() => setSelectedCurrentArtifact(null)}
                    style={{ padding: "3px 8px", borderRadius: 5, border: "1px solid #30363d", background: "#21262d", color: "#c9d1d9", cursor: "pointer", fontSize: 12 }}
                  >Close</button>
                </div>
                {currentArtifact.isLoading && <div style={{ color: "#8b949e", marginTop: 8 }}>Loading artifact…</div>}
                {currentArtifact.error && <div style={{ color: "#f85149", marginTop: 8 }}>{String(currentArtifact.error)}</div>}
                {currentArtifact.data && <pre style={{ margin: "8px 0 0", maxHeight: 560, overflow: "auto", whiteSpace: "pre-wrap", color: "#c9d1d9", fontSize: 12 }}>{currentArtifact.data.content}{currentArtifact.data.truncated ? "\n\n[Preview truncated]" : ""}</pre>}
              </div>
            )}
          </Section>

          <Section title="Workflow Graph">
            <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 8, flexWrap: "wrap" }}>
              <button
                onClick={() => yamlTools.mutate("validate")}
                disabled={yamlTools.isPending}
                style={{ padding: "4px 10px", borderRadius: 6, border: "1px solid #30363d", background: "#21262d", color: "#c9d1d9", cursor: "pointer", fontSize: 12 }}
              >Validate YAML</button>
              <button
                onClick={() => yamlTools.mutate("sync")}
                disabled={yamlTools.isPending}
                style={{ padding: "4px 10px", borderRadius: 6, border: "1px solid #30363d", background: "#21262d", color: "#c9d1d9", cursor: "pointer", fontSize: 12 }}
              >Sync from longwrite.yaml</button>
              <span style={{ color: "#8b949e", fontSize: 12 }}>
                Structure edits are YAML edits: prefer longwrite.yaml + Sync; hand-edits to malaclaw.yaml are advanced-mode and Sync regenerates over them.
              </span>
            </div>
            {yamlToolsResult ? (
              <pre style={{
                margin: "0 0 8px", padding: 8, borderRadius: 6, border: "1px solid #30363d",
                background: "#0d1117", fontSize: 12, whiteSpace: "pre-wrap",
                color: yamlToolsResult.ok ? "#3fb950" : "#f85149",
              }}>{yamlToolsResult.text}</pre>
            ) : null}
            <div style={{ display: "flex", gap: 10, alignItems: "stretch", overflowX: "auto", paddingBottom: 4 }}>
              {data.workflow.stages.map((stage, index) => {
                const unit = data.flow?.units[stage.id];
                const selected = stage.id === (selectedStageId ?? selectedStage?.id);
                const statusColor = unit?.status === "succeeded"
                  ? "#3fb950"
                  : unit?.status === "failed"
                    ? "#f85149"
                    : unit?.status === "running"
                      ? "#d29922"
                      : "#8b949e";
                return (
                  <div key={stage.id} style={{ display: "flex", alignItems: "center", gap: 10 }}>
                    <button
                      onClick={() => setSelectedStageId(stage.id)}
                      style={{
                        width: 170,
                        minHeight: 96,
                        textAlign: "left",
                        padding: 10,
                        borderRadius: 6,
                        border: selected ? "1px solid #58a6ff" : "1px solid #30363d",
                        background: selected ? "#0d2138" : "#0d1117",
                        color: "#c9d1d9",
                        cursor: "pointer",
                      }}
                    >
                      <div style={{ fontFamily: "monospace", fontSize: 13, overflowWrap: "anywhere" }}>{stage.id}</div>
                      <div style={{ color: statusColor, fontSize: 12, marginTop: 6 }}>{unit?.status ?? "pending"}</div>
                      <div style={{ color: "#8b949e", fontSize: 12, marginTop: 6 }}>
                        {stage.type}
                        {stage.maxParallel ? ` · x${stage.maxParallel}` : ""}
                        {stage.type === "loop" && stage.maxRounds ? ` · ≤${stage.maxRounds} rounds` : ""}
                      </div>
                      <div style={{ color: "#8b949e", fontSize: 12 }}>{stage.effectiveRuntime ?? stage.runtime ?? "default runtime"}{stage.locked ? " 🔒" : ""}</div>
                      {/* Inner executable units are REAL nodes, not hidden detail:
                          foreach steps and loop children each show their own
                          effective runtime and live status. */}
                      {(stage.steps.length > 0 || (stage.children ?? []).length > 0) && (
                        <div style={{ marginTop: 6, borderTop: "1px dashed #30363d", paddingTop: 4 }}>
                          {stage.steps.map((step) => {
                            const stepUnits = Object.entries(data.flow?.units ?? {})
                              .filter(([key]) => key.startsWith(`${stage.id}.${step.id}[`));
                            const doneCount = stepUnits.filter(([, u]) => u.status === "succeeded").length;
                            return (
                              <div key={step.id} style={{ fontSize: 11, color: "#8b949e" }}>
                                ↳ {step.id} · {step.effectiveRuntime ?? "default"}
                                {stepUnits.length > 0 ? ` · ${doneCount}/${stepUnits.length}` : ""}
                              </div>
                            );
                          })}
                          {(stage.children ?? []).map((child) => {
                            const childUnits = Object.entries(data.flow?.units ?? {})
                              .filter(([key]) => new RegExp(`^${stage.id}-r\\d+-${child.id}$`).test(key));
                            const lastStatus = childUnits.at(-1)?.[1]?.status;
                            return (
                              <div key={child.id} style={{ fontSize: 11, color: lastStatus === "failed" ? "#f85149" : "#8b949e" }}>
                                ↳ {child.id} · {child.effectiveRuntime ?? "default"}{child.locked ? " 🔒" : ""}
                                {childUnits.length > 0 ? ` · r${childUnits.length}${lastStatus ? ` ${lastStatus}` : ""}` : ""}
                              </div>
                            );
                          })}
                        </div>
                      )}
                    </button>
                    {index < data.workflow.stages.length - 1 ? <div style={{ color: "#8b949e", fontSize: 22 }}>→</div> : null}
                  </div>
                );
              })}
            </div>
            {selectedStage && (
              <div style={{
                marginTop: 12,
                display: "grid",
                gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))",
                gap: 10,
                borderTop: "1px solid #21262d",
                paddingTop: 10,
              }}>
                <div style={{ color: "#c9d1d9" }}>
                  <div>{smallLabel("selected")} <code>{selectedStage.id}</code></div>
                  <div>{smallLabel("owner (role)")} {selectedStage.owner ?? (selectedStage.steps.map((s) => s.owner).filter(Boolean).join(", ") || "not set")}</div>
                  <div>{smallLabel("effective runtime")} {selectedStage.effectiveRuntime}{selectedStage.effectiveModel ? ` · ${selectedStage.effectiveModel}` : ""}</div>
                  <div>{smallLabel("outputs")} {selectedStage.outputs.length}</div>
                  <div>{smallLabel("availability")} {selectedStage.enabled ? "enabled" : "skipped"}</div>
                  {selectedStage.locked ? <div style={{ color: "#d29922" }}>deterministic script stage — execution overrides locked</div> : null}
                  {selectedStage.type === "loop" ? <div style={{ color: "#d29922" }}>loop group — child execution settings are YAML-only for now</div> : null}
                  {selectedStage.type === "foreach" ? <div style={{ color: "#d29922" }}>foreach group — runtime/model belong to inner steps and are YAML-only for now</div> : null}
                </div>
                <label style={{ color: "#8b949e", fontSize: 12, opacity: selectedStage.locked || selectedStage.type === "loop" || selectedStage.type === "foreach" ? 0.4 : 1 }}>
                  Runtime override
                  <input disabled={selectedStage.locked || selectedStage.type === "loop" || selectedStage.type === "foreach"} value={stagePatch.runtime} onChange={(e) => setStagePatch((current) => ({ ...current, runtime: e.target.value }))} placeholder="codex, claude-code, openai-api" style={inputStyle} />
                </label>
                <label style={{ color: "#8b949e", fontSize: 12, opacity: selectedStage.locked || selectedStage.type === "loop" || selectedStage.type === "foreach" ? 0.4 : 1 }}>
                  Model override
                  <input disabled={selectedStage.locked || selectedStage.type === "loop" || selectedStage.type === "foreach"} value={stagePatch.model} onChange={(e) => setStagePatch((current) => ({ ...current, model: e.target.value }))} placeholder="provider model id" style={inputStyle} />
                </label>
                <label style={{ color: "#8b949e", fontSize: 12, opacity: selectedStage.locked || selectedStage.type === "loop" || selectedStage.type === "foreach" || Object.keys(data.workflow.modelTiers).length === 0 ? 0.4 : 1 }}>
                  Model tier
                  <select
                    disabled={selectedStage.locked || selectedStage.type === "loop" || selectedStage.type === "foreach" || Object.keys(data.workflow.modelTiers).length === 0}
                    value={stagePatch.modelTier}
                    onChange={(e) => setStagePatch((current) => ({ ...current, modelTier: e.target.value }))}
                    style={inputStyle}
                  >
                    <option value="">{Object.keys(data.workflow.modelTiers).length === 0 ? "no tiers defined by this profile" : "(none)"}</option>
                    {Object.keys(data.workflow.modelTiers).map((tier) => <option key={tier} value={tier}>{tier}</option>)}
                  </select>
                </label>
                <label style={{ color: "#8b949e", fontSize: 12, opacity: selectedStage.type !== "foreach" ? 0.4 : 1 }}>
                  Max parallel {selectedStage.type !== "foreach" ? "(foreach only)" : ""}
                  <input disabled={selectedStage.type !== "foreach"} type="number" min={1} value={stagePatch.maxParallel} onChange={(e) => setStagePatch((current) => ({ ...current, maxParallel: e.target.value }))} style={inputStyle} />
                </label>
                <label style={{ color: "#8b949e", fontSize: 12, display: "flex", gap: 8, alignItems: "center", marginTop: 20, opacity: selectedStage.type === "standard" ? 1 : 0.4 }}>
                  <input
                    type="checkbox"
                    disabled={selectedStage.type !== "standard"}
                    checked={stagePatch.requiresHumanApproval}
                    onChange={(e) => setStagePatch((current) => ({ ...current, requiresHumanApproval: e.target.checked }))}
                  />
                  Approval gate
                </label>
                <label style={{ color: "#8b949e", fontSize: 12, display: "flex", gap: 8, alignItems: "center", marginTop: 20, opacity: selectedStage.skippable ? 1 : 0.4 }}>
                  <input
                    type="checkbox"
                    disabled={!selectedStage.skippable}
                    checked={stagePatch.enabled}
                    onChange={(e) => setStagePatch((current) => ({ ...current, enabled: e.target.checked }))}
                  />
                  Enable skippable stage
                </label>
                <div style={{ display: "flex", alignItems: "end" }}>
                  <button
                    onClick={() => saveStage.mutate()}
                    disabled={saveStage.isPending}
                    style={{
                      padding: "6px 12px",
                      borderRadius: 6,
                      border: "1px solid #30363d",
                      background: "#238636",
                      color: "#fff",
                      cursor: saveStage.isPending ? "wait" : "pointer",
                    }}
                  >
                    Save stage override
                  </button>
                </div>
              </div>
            )}
            <div style={{ marginTop: 8, color: "#8b949e", fontSize: 12 }}>
              Stage overrides are stored in longwrite.yaml and then compiled into malaclaw.yaml. Structure edits remain YAML-only.
            </div>
          </Section>

          <Section title="Feedback">
            <div style={{ color: "#8b949e", fontSize: 12, lineHeight: 1.5, marginBottom: 8 }}>
              Saves an operator request for the next quality-loop review and revision. Saving does not restart or interrupt a running flow; after a paused or completed flow, click Run to continue it.
            </div>
            <textarea
              value={feedbackText}
              onChange={(e) => setFeedbackText(e.target.value)}
              rows={4}
              placeholder="e.g. Add a direct comparison of memory architectures; shorten the introduction; preserve only packet-backed claims."
              style={{
                width: "100%",
                boxSizing: "border-box",
                padding: 10,
                borderRadius: 6,
                border: "1px solid #30363d",
                background: "#0d1117",
                color: "#c9d1d9",
              }}
            />
            <button
              onClick={() => addFeedback.mutate(feedbackText)}
              disabled={addFeedback.isPending || feedbackText.trim().length === 0}
              style={{
                marginTop: 8,
                padding: "6px 12px",
                borderRadius: 6,
                border: "1px solid #30363d",
                background: feedbackText.trim().length ? "#1f6feb" : "#21262d",
                color: "#fff",
                cursor: feedbackText.trim().length ? "pointer" : "not-allowed",
              }}
            >
              Save for next revision
            </button>
          </Section>

          {draftConfig && (
            <Section title="Config">
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 10 }}>
                <label style={{ color: "#8b949e", fontSize: 12 }}>
                  Project name
                  <input
                    value={draftConfig.project.name ?? ""}
                    onChange={(e) => patchConfig((c) => ({ ...c, project: { ...c.project, name: e.target.value } }))}
                    style={{
                      display: "block", width: "100%", boxSizing: "border-box", marginTop: 4,
                      padding: "6px 8px", borderRadius: 6, border: "1px solid #30363d",
                      background: "#0d1117", color: "#c9d1d9",
                    }}
                  />
                </label>
                <label style={{ color: "#8b949e", fontSize: 12 }}>
                  Authors
                  <textarea
                    value={formatAuthors(draftConfig.project.authors)}
                    onChange={(e) => patchConfig((c) => ({ ...c, project: { ...c.project, authors: parseAuthors(e.target.value) } }))}
                    rows={3}
                    placeholder="Ada Lovelace <ada@example.com>"
                    style={inputStyle}
                  />
                </label>
                <label style={{ color: "#8b949e", fontSize: 12 }}>
                  Topic
                  <input
                    value={draftConfig.research?.topic ?? ""}
                    onChange={(e) => patchConfig((c) => ({ ...c, research: { provider: c.research?.provider ?? "seed", ...c.research, topic: e.target.value } }))}
                    style={{
                      display: "block", width: "100%", boxSizing: "border-box", marginTop: 4,
                      padding: "6px 8px", borderRadius: 6, border: "1px solid #30363d",
                      background: "#0d1117", color: "#c9d1d9",
                    }}
                  />
                </label>
                <label style={{ color: "#8b949e", fontSize: 12 }}>
                  Provider
                  <select
                    value={draftConfig.research?.provider ?? "seed"}
                    onChange={(e) => patchConfig((c) => ({ ...c, research: { ...c.research, provider: e.target.value } }))}
                    style={{
                      display: "block", width: "100%", boxSizing: "border-box", marginTop: 4,
                      padding: "6px 8px", borderRadius: 6, border: "1px solid #30363d",
                      background: "#0d1117", color: "#c9d1d9",
                    }}
                  >
                    <option value="seed">seed</option>
                    <option value="arxiv">arxiv</option>
                    <option value="semantic_scholar">semantic_scholar</option>
                    <option value="dblp">dblp</option>
                    <option value="crossref">crossref</option>
                    <option value="multi">multi</option>
                  </select>
                </label>
                <label style={{ color: "#8b949e", fontSize: 12 }}>
                  Workflow profile
                  <select
                    value={draftConfig.research?.workflow_profile ?? "standard"}
                    onChange={(e) => patchConfig((c) => ({
                      ...c,
                      research: { ...c.research, workflow_profile: e.target.value as "fast" | "standard" | "deep" },
                    }))}
                    style={inputStyle}
                  >
                    <option value="fast">fast</option>
                    <option value="standard">standard</option>
                    <option value="deep">deep</option>
                  </select>
                </label>
                <label style={{ color: "#8b949e", fontSize: 12 }}>
                  Runtime strategy
                  <select
                    value={draftConfig.runtime_profile ?? "default"}
                    onChange={(e) => patchConfig((c) => ({
                      ...c,
                      runtime_profile: e.target.value === "default" ? undefined : e.target.value,
                    }))}
                    style={inputStyle}
                  >
                    <option value="default">default</option>
                    <option value="codex_first">codex_first</option>
                    <option value="claude_first">claude_first</option>
                    <option value="claude_advisor_sonnet">claude_advisor_sonnet (legacy)</option>
                  </select>
                </label>
                <label style={{ color: "#8b949e", fontSize: 12 }}>
                  Research candidates
                  <input
                    type="number" min={1} max={1000}
                    value={draftConfig.research?.target_candidates ?? 100}
                    onChange={(e) => patchConfig((c) => ({
                      ...c,
                      research: { provider: "seed", query_budget: 24, taxonomy: [], source_policy: { min_recent_ratio: 0.4, min_verified_ratio: 0.8, max_arxiv_only_ratio: 0.6, require_live_urls: false }, fulltext: { max_core_sources: 40, allow_pdf_download: true }, verification: { max_sources: 30 }, writing_strategy: "scaffold_then_revise", retrieval: { backend: "sqlite_fts" }, ...c.research, target_candidates: Number(e.target.value) },
                    }))}
                    style={inputStyle}
                  />
                </label>
                <label style={{ color: "#8b949e", fontSize: 12 }}>
                  Section drafting
                  <select
                    value={draftConfig.research?.writing_strategy ?? "scaffold_then_revise"}
                    onChange={(e) => patchConfig((c) => ({
                      ...c,
                      research: { ...c.research, writing_strategy: e.target.value as "scaffold_then_revise" | "llm_sections" },
                    }))}
                    style={inputStyle}
                  >
                    <option value="scaffold_then_revise">deterministic evidence scaffold, then LLM revision</option>
                    <option value="llm_sections">direct LLM section drafting (full-mode default)</option>
                  </select>
                  <span style={{ display: "block", marginTop: 4, color: "#8b949e", lineHeight: 1.35 }}>
                    This controls only the initial foreach draft. Scripts always handle retrieval, evidence, citation, build, and validation; the quality-loop review/revision uses the selected LLM runtime in either mode.
                  </span>
                </label>
                <label style={{ color: "#8b949e", fontSize: 12 }}>
                  Evidence retrieval
                  <select
                    value={draftConfig.research?.retrieval?.backend ?? "sqlite_fts"}
                    onChange={(e) => patchConfig((c) => ({
                      ...c,
                      research: {
                        ...c.research,
                        retrieval: {
                          backend: e.target.value as "sqlite_fts" | "hybrid_openai",
                          embedding_model: c.research?.retrieval?.embedding_model ?? "text-embedding-3-small",
                        },
                      },
                    }))}
                    style={inputStyle}
                  >
                    <option value="sqlite_fts">SQLite FTS (local)</option>
                    <option value="hybrid_openai">Hybrid embeddings (API key required)</option>
                  </select>
                </label>
                <label style={{ color: "#8b949e", fontSize: 12, display: "flex", gap: 8, alignItems: "center", marginTop: 20 }}>
                  <input
                    type="checkbox"
                    checked={draftConfig.figures?.backends?.nanobanana?.enabled ?? false}
                    onChange={(e) => patchConfig((c) => ({
                      ...c,
                      figures: {
                        ...c.figures,
                        backends: {
                          ...c.figures?.backends,
                          nanobanana: { budget_usd: 2, requires_approval: true, ...c.figures?.backends?.nanobanana, enabled: e.target.checked },
                        },
                      },
                    }))}
                  />
                  Enable Nano Banana conceptual illustration (optional paid backend)
                </label>
                <label style={{ color: "#8b949e", fontSize: 12 }}>
                  Nano Banana budget (USD)
                  <input
                    type="number" min={0.05} step={0.05}
                    value={draftConfig.figures?.backends?.nanobanana?.budget_usd ?? 2}
                    onChange={(e) => patchConfig((c) => ({
                      ...c,
                      figures: { ...c.figures, backends: { ...c.figures?.backends, nanobanana: { enabled: false, requires_approval: true, ...c.figures?.backends?.nanobanana, budget_usd: Number(e.target.value) } } },
                    }))}
                    style={inputStyle}
                  />
                  <span style={{ display: "block", marginTop: 4, color: "#8b949e", lineHeight: 1.35 }}>Requires `GEMINI_API_KEY` (or `LONGWRITE_NANOBANANA_API_KEY`) in `.env`; the key is never stored here.</span>
                </label>
                <label style={{ color: "#8b949e", fontSize: 12, display: "flex", gap: 8, alignItems: "center", marginTop: 20 }}>
                  <input
                    type="checkbox"
                    checked={draftConfig.figures?.backends?.nanobanana?.requires_approval ?? true}
                    onChange={(e) => patchConfig((c) => ({
                      ...c,
                      figures: { ...c.figures, backends: { ...c.figures?.backends, nanobanana: { enabled: false, budget_usd: 2, ...c.figures?.backends?.nanobanana, requires_approval: e.target.checked } } },
                    }))}
                  />
                  Require `figures/nanobanana.approved` before spending
                </label>
                <label style={{ color: "#8b949e", fontSize: 12, display: "flex", gap: 8, alignItems: "center", marginTop: 20 }}>
                  <input
                    type="checkbox"
                    checked={draftConfig.research?.source_policy?.require_live_urls ?? false}
                    onChange={(e) => patchConfig((c) => ({
                      ...c,
                      research: {
                        ...c.research,
                        source_policy: { ...c.research?.source_policy, require_live_urls: e.target.checked },
                      },
                    }))}
                  />
                  Require live cited-source URLs for release
                </label>
                <label style={{ color: "#8b949e", fontSize: 12 }}>
                  Query budget
                  <input
                    type="number" min={1} max={50}
                    value={draftConfig.research?.query_budget ?? 24}
                    onChange={(e) => patchConfig((c) => ({
                      ...c,
                      research: { provider: "seed", target_candidates: 100, taxonomy: [], source_policy: { min_recent_ratio: 0.4, min_verified_ratio: 0.8, max_arxiv_only_ratio: 0.6, require_live_urls: false }, fulltext: { max_core_sources: 40, allow_pdf_download: true }, verification: { max_sources: 30 }, writing_strategy: "scaffold_then_revise", retrieval: { backend: "sqlite_fts" }, ...c.research, query_budget: Number(e.target.value) },
                    }))}
                    style={inputStyle}
                  />
                </label>
                <label style={{ color: "#8b949e", fontSize: 12, gridColumn: "1 / -1" }}>
                  Taxonomy coverage cells
                  <textarea
                    rows={2}
                    value={(draftConfig.research?.taxonomy ?? []).join("\n")}
                    placeholder="One topic cell per line, e.g. planning\nmemory\ntool use"
                    onChange={(e) => patchConfig((c) => ({
                      ...c,
                      research: {
                        provider: "seed", target_candidates: 100, query_budget: 24,
                        source_policy: { min_recent_ratio: 0.4, min_verified_ratio: 0.8, max_arxiv_only_ratio: 0.6, require_live_urls: false },
                        fulltext: { max_core_sources: 40, allow_pdf_download: true }, verification: { max_sources: 30 }, writing_strategy: "scaffold_then_revise", retrieval: { backend: "sqlite_fts" },
                        ...c.research,
                        taxonomy: e.target.value.split("\n").map((value) => value.trim()).filter(Boolean),
                      },
                    }))}
                    style={inputStyle}
                  />
                </label>
                <label style={{ color: "#8b949e", fontSize: 12, gridColumn: "1 / -1" }}>
                  Repository evidence
                  <textarea
                    rows={3}
                    value={(draftConfig.research?.codebases ?? []).map((entry) => entry.source).join("\n")}
                    placeholder="One Git URL or local Git path per line. Leave empty for a literature survey."
                    onChange={(e) => patchConfig((c) => {
                      const codebases = codebasesFromText(e.target.value, c.research?.codebases);
                      return {
                        ...c,
                        research: {
                          ...c.research,
                          paper_kind: c.research?.paper_kind ?? "survey",
                          paper_profile: codebases.length > 0 || c.research?.codebase_discovery?.enabled ? "repository_study" : "literature_survey",
                          codebases,
                        },
                      };
                    })}
                    style={inputStyle}
                  />
                  <span style={{ display: "block", marginTop: 4, color: "#8b949e", lineHeight: 1.35 }}>
                    Repositories are snapshotted at an immutable commit and analyzed as software evidence. Adding one never executes repository code or changes an existing project's experiment source.
                  </span>
                </label>
                <div style={{ color: "#8b949e", fontSize: 12, gridColumn: "1 / -1", border: "1px solid #30363d", borderRadius: 6, padding: 10 }}>
                  <label style={{ display: "flex", gap: 8, alignItems: "center", color: "#c9d1d9" }}>
                    <input
                      type="checkbox"
                      checked={draftConfig.research?.codebase_discovery?.enabled ?? false}
                      onChange={(e) => patchConfig((c) => ({
                        ...c,
                        research: {
                          ...c.research,
                          paper_kind: c.research?.paper_kind ?? "survey",
                          paper_profile: e.target.checked ? "repository_study" : ((c.research?.codebases?.length ?? 0) > 0 ? "repository_study" : "literature_survey"),
                          codebase_discovery: {
                            provider: "github", query_budget: 10, max_candidates: 40, max_readme_fetches: 12,
                            max_selected: 8, require_license: true, include_archived: false, languages: [],
                            ...c.research?.codebase_discovery,
                            enabled: e.target.checked,
                          },
                        },
                      }))}
                    />
                    Discover related GitHub repositories
                  </label>
                  {(draftConfig.research?.codebase_discovery?.enabled ?? false) && <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: 8, marginTop: 8 }}>
                    {([
                      ["query_budget", "Queries", 1, 20],
                      ["max_candidates", "Candidates", 1, 100],
                      ["max_readme_fetches", "README fetches", 0, 40],
                      ["max_selected", "Selected", 1, 10],
                    ] as const).map(([key, label, min, max]) => <label key={key}>{label}<input type="number" min={min} max={max} value={draftConfig.research?.codebase_discovery?.[key] ?? min} onChange={(e) => patchConfig((c) => ({ ...c, research: { ...c.research, codebase_discovery: { provider: "github", enabled: true, query_budget: 10, max_candidates: 40, max_readme_fetches: 12, max_selected: 8, require_license: true, include_archived: false, languages: [], ...c.research?.codebase_discovery, [key]: Number(e.target.value) } } }))} style={inputStyle} /></label>)}
                    <label>Languages<input value={(draftConfig.research?.codebase_discovery?.languages ?? []).join(", ")} onChange={(e) => patchConfig((c) => ({ ...c, research: { ...c.research, codebase_discovery: { provider: "github", enabled: true, query_budget: 10, max_candidates: 40, max_readme_fetches: 12, max_selected: 8, require_license: true, include_archived: false, languages: [], ...c.research?.codebase_discovery, languages: e.target.value.split(",").map((v) => v.trim()).filter(Boolean) } } }))} style={inputStyle} /></label>
                  </div>}
                </div>
                <label style={{ color: "#8b949e", fontSize: 12 }}>
                  Target words
                  <input
                    type="number"
                    min={1}
                    value={draftConfig.writing?.target_length_words ?? ""}
                    onChange={(e) => patchConfig((c) => ({
                      ...c,
                      writing: {
                        reference_links: [],
                        reference_files: [],
                        output_formats: ["markdown"],
                        ...c.writing,
                        target_length_words: e.target.value ? Number(e.target.value) : undefined,
                      },
                    }))}
                    style={inputStyle}
                  />
                </label>
                <label style={{ color: "#8b949e", fontSize: 12 }}>
                  Genre / category
                  <input
                    value={draftConfig.writing?.genre ?? ""}
                    onChange={(e) => patchConfig((c) => ({
                      ...c,
                      writing: { reference_links: [], reference_files: [], output_formats: ["markdown"], ...c.writing, genre: e.target.value || undefined },
                    }))}
                    style={inputStyle}
                  />
                </label>
                <label style={{ color: "#8b949e", fontSize: 12 }}>
                  Audience
                  <input
                    value={draftConfig.writing?.audience ?? ""}
                    onChange={(e) => patchConfig((c) => ({
                      ...c,
                      writing: { reference_links: [], reference_files: [], output_formats: ["markdown"], ...c.writing, audience: e.target.value || undefined },
                    }))}
                    style={inputStyle}
                  />
                </label>
                <label style={{ color: "#8b949e", fontSize: 12 }}>
                  Review cadence
                  <select
                    value={draftConfig.review?.cadence ?? "manual"}
                    onChange={(e) => patchConfig((c) => ({
                      ...c,
                      review: { time: "08:00", interval_hours: 4, batch_approvals: false, ...c.review, cadence: e.target.value as "manual" | "daily" | "interval" },
                    }))}
                    style={{
                      display: "block", width: "100%", boxSizing: "border-box", marginTop: 4,
                      padding: "6px 8px", borderRadius: 6, border: "1px solid #30363d",
                      background: "#0d1117", color: "#c9d1d9",
                    }}
                  >
                    <option value="manual">manual</option>
                    <option value="daily">daily</option>
                    <option value="interval">interval</option>
                  </select>
                </label>
                {(draftConfig.review?.cadence ?? "manual") === "daily" ? <label style={{ color: "#8b949e", fontSize: 12 }}>
                  Review time
                  <input
                    value={draftConfig.review?.time ?? "08:00"}
                    onChange={(e) => patchConfig((c) => ({ ...c, review: { cadence: "manual", interval_hours: 4, batch_approvals: false, ...c.review, time: e.target.value } }))}
                    style={{
                      display: "block", width: "100%", boxSizing: "border-box", marginTop: 4,
                      padding: "6px 8px", borderRadius: 6, border: "1px solid #30363d",
                      background: "#0d1117", color: "#c9d1d9",
                    }}
                  />
                </label> : null}
                {(draftConfig.review?.cadence ?? "manual") === "interval" ? <label style={{ color: "#8b949e", fontSize: 12 }}>
                  Interval hours
                  <input
                    type="number"
                    min={1}
                    value={draftConfig.review?.interval_hours ?? 4}
                    onChange={(e) => patchConfig((c) => ({
                      ...c,
                      review: { cadence: "manual", time: "08:00", batch_approvals: false, ...c.review, interval_hours: Number(e.target.value) },
                    }))}
                    style={{
                      display: "block", width: "100%", boxSizing: "border-box", marginTop: 4,
                      padding: "6px 8px", borderRadius: 6, border: "1px solid #30363d",
                      background: "#0d1117", color: "#c9d1d9",
                    }}
                  />
                </label> : null}
                <div style={{ color: "#8b949e", fontSize: 12, gridColumn: "1 / -1" }}>
                  Cadence generates review agendas/guidance only — it does not run a daemon or cron job.
                </div>
                {([
                  ["max_recorded_tokens", "Max recorded tokens", "e.g. 200000"],
                  ["max_unit_minutes", "Max minutes per unit", "e.g. 15"],
                  ["max_active_run_minutes", "Max active run minutes", "e.g. 120"],
                ] as const).map(([key, label, hint]) => (
                  <label key={key} style={{ color: "#8b949e", fontSize: 12 }}>
                    {label}
                    <input
                      type="number"
                      min={1}
                      value={draftConfig.run_limits?.[key] ?? ""}
                      placeholder={hint}
                      onChange={(e) => patchConfig((c) => {
                        const next = { on_limit: "pause" as const, ...c.run_limits };
                        if (e.target.value === "") delete next[key];
                        else next[key] = Number(e.target.value);
                        const hasAny = ["max_recorded_tokens", "max_unit_minutes", "max_active_run_minutes"]
                          .some((k) => next[k as keyof typeof next] !== undefined);
                        return { ...c, run_limits: hasAny ? next : undefined };
                      })}
                      style={{
                        display: "block", width: "100%", boxSizing: "border-box", marginTop: 4,
                        padding: "6px 8px", borderRadius: 6, border: "1px solid #30363d",
                        background: "#0d1117", color: "#c9d1d9",
                      }}
                    />
                  </label>
                ))}
                <div style={{ color: "#8b949e", fontSize: 12, gridColumn: "1 / -1" }}>
                  Run limits are guardrails checked between units (can overshoot by one in-flight unit); on_limit is always pause. Saved to longwrite.yaml — durable through sync.
                </div>
                <label style={{ color: "#8b949e", fontSize: 12, display: "flex", gap: 8, alignItems: "center", marginTop: 20 }}>
                  <input
                    type="checkbox"
                    checked={draftConfig.review?.batch_approvals ?? false}
                    onChange={(e) => patchConfig((c) => ({ ...c, review: { cadence: "manual", time: "08:00", interval_hours: 4, ...c.review, batch_approvals: e.target.checked } }))}
                  />
                  Batch approvals
                </label>
                <label style={{ color: "#8b949e", fontSize: 12, display: "flex", gap: 8, alignItems: "center", marginTop: 20 }}>
                  <input
                    type="checkbox"
                    checked={(draftConfig.writing?.output_formats ?? ["markdown"]).includes("pdf")}
                    onChange={(e) => patchConfig((c) => {
                      const current = new Set(c.writing?.output_formats ?? ["markdown"]);
                      if (e.target.checked) current.add("pdf");
                      else current.delete("pdf");
                      current.add("markdown");
                      return {
                        ...c,
                        writing: {
                          reference_links: [],
                          reference_files: [],
                          ...c.writing,
                          output_formats: [...current] as Array<"markdown" | "pdf">,
                        },
                      };
                    })}
                  />
                  PDF output
                </label>
                <label style={{ color: "#8b949e", fontSize: 12 }}>
                  Publication target
                  <select
                    value={draftConfig.publication?.target ?? "arxiv"}
                    onChange={(e) => patchConfig((c) => ({
                      ...c,
                      publication: { anonymous: false, required_sections: [], document_class_options: [], ...c.publication, target: e.target.value as "arxiv" | "custom" },
                    }))}
                    style={inputStyle}
                  >
                    <option value="arxiv">arXiv source bundle</option>
                    <option value="custom">Custom venue template</option>
                  </select>
                </label>
                <label style={{ color: "#8b949e", fontSize: 12 }}>
                  Page limit (optional)
                  <input
                    type="number" min={1}
                    value={draftConfig.publication?.page_limit ?? ""}
                    onChange={(e) => patchConfig((c) => ({
                      ...c,
                      publication: { target: "arxiv", anonymous: false, required_sections: [], document_class_options: [], ...c.publication, page_limit: e.target.value ? Number(e.target.value) : undefined },
                    }))}
                    style={inputStyle}
                  />
                </label>
                <label style={{ color: "#8b949e", fontSize: 12, display: "flex", gap: 8, alignItems: "center", marginTop: 20 }}>
                  <input
                    type="checkbox"
                    checked={draftConfig.publication?.anonymous ?? false}
                    onChange={(e) => patchConfig((c) => ({
                      ...c,
                      publication: { target: "arxiv", required_sections: [], document_class_options: [], ...c.publication, anonymous: e.target.checked },
                    }))}
                  />
                  Anonymous author metadata
                </label>
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))", gap: 10, marginTop: 10 }}>
                <label style={{ color: "#8b949e", fontSize: 12 }}>
                  Style instructions
                  <textarea
                    value={draftConfig.writing?.style_instructions ?? ""}
                    onChange={(e) => patchConfig((c) => ({
                      ...c,
                      writing: { reference_links: [], reference_files: [], output_formats: ["markdown"], ...c.writing, style_instructions: e.target.value || undefined },
                    }))}
                    rows={3}
                    style={inputStyle}
                  />
                </label>
                <label style={{ color: "#8b949e", fontSize: 12 }}>
                  Reference links
                  <textarea
                    value={(draftConfig.writing?.reference_links ?? []).join("\n")}
                    onChange={(e) => patchConfig((c) => ({
                      ...c,
                      writing: {
                        reference_files: [],
                        output_formats: ["markdown"],
                        ...c.writing,
                        reference_links: e.target.value.split("\n").map((v) => v.trim()).filter(Boolean),
                      },
                    }))}
                    rows={3}
                    placeholder="One public URL per line (context/style lead; not auto-fetched)"
                  style={inputStyle}
                />
              </label>
                <label style={{ color: "#8b949e", fontSize: 12 }}>
                  Reference-use instructions
                  <textarea
                    value={draftConfig.writing?.reference_instructions ?? ""}
                    onChange={(e) => patchConfig((c) => ({
                      ...c,
                      writing: { reference_links: [], reference_files: [], output_formats: ["markdown"], ...c.writing, reference_instructions: e.target.value || undefined },
                    }))}
                    rows={3}
                    placeholder="e.g. Use these reports for terminology and comparison framing; do not treat them as evidence or citations."
                    style={inputStyle}
                  />
                </label>
                <label style={{ color: "#8b949e", fontSize: 12 }}>
                  Reference files
                  <textarea
                    value={(draftConfig.writing?.reference_files ?? []).join("\n")}
                    onChange={(e) => patchConfig((c) => ({
                      ...c,
                      writing: {
                        reference_links: [],
                        output_formats: ["markdown"],
                        ...c.writing,
                        reference_files: e.target.value.split("\n").map((v) => v.trim()).filter(Boolean),
                      },
                    }))}
                    rows={3}
                    placeholder="One workspace-local path per line, e.g. references/brief.pdf"
                    style={inputStyle}
                  />
                </label>
                <label style={{ color: "#8b949e", fontSize: 12 }}>
                  Required submission sections
                  <textarea
                    value={(draftConfig.publication?.required_sections ?? []).join("\n")}
                    onChange={(e) => patchConfig((c) => ({
                      ...c,
                      publication: { target: "arxiv", anonymous: false, document_class_options: [], ...c.publication, required_sections: e.target.value.split("\n").map((v) => v.trim()).filter(Boolean) },
                    }))}
                    rows={3}
                    placeholder="One required section title per line"
                    style={inputStyle}
                  />
                </label>
                {(draftConfig.publication?.target ?? "arxiv") === "custom" ? <>
                  <label style={{ color: "#8b949e", fontSize: 12 }}>
                    Template directory (workspace-relative)
                    <input
                      value={draftConfig.publication?.template_dir ?? ""}
                      onChange={(e) => patchConfig((c) => ({ ...c, publication: { target: "custom", anonymous: false, required_sections: [], document_class_options: [], ...c.publication, template_dir: e.target.value || undefined } }))}
                      placeholder="templates/my-venue"
                      style={inputStyle}
                    />
                  </label>
                  <label style={{ color: "#8b949e", fontSize: 12 }}>
                    Document class (without .cls)
                    <input
                      value={draftConfig.publication?.document_class ?? ""}
                      onChange={(e) => patchConfig((c) => ({ ...c, publication: { target: "custom", anonymous: false, required_sections: [], document_class_options: [], ...c.publication, document_class: e.target.value || undefined } }))}
                      placeholder="myvenue_2026"
                      style={inputStyle}
                    />
                  </label>
                </> : null}
              </div>
              <div style={{ color: "#8b949e", fontSize: 12, marginTop: 8 }}>
                Style and reference guidance is injected into LLM drafting/revision prompts through the project brief. URLs are not automatically fetched; workspace-local files are available to a tool-capable worker when it needs them. Neither becomes a citation without packet-backed evidence. A custom publication target requires its official class assets inside the selected template directory; use `longwrite publication validate` and `longwrite publication package` after the final build.
              </div>
              <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
                <button
                  onClick={() => saveConfig.mutate(draftConfig)}
                  disabled={saveConfig.isPending}
                  style={{
                    padding: "6px 12px",
                    borderRadius: 6,
                    border: "1px solid #30363d",
                    background: "#238636",
                    color: "#fff",
                    cursor: saveConfig.isPending ? "wait" : "pointer",
                  }}
                >
                  Save config
                </button>
                <button
                  onClick={() => data?.config && setDraftConfig(data.config)}
                  disabled={saveConfig.isPending}
                  style={{
                    padding: "6px 12px",
                    borderRadius: 6,
                    border: "1px solid #30363d",
                    background: "#21262d",
                    color: "#c9d1d9",
                    cursor: "pointer",
                  }}
                >
                  Revert
                </button>
              </div>
            </Section>
          )}

          <Section title="Commands">
            <div style={{ display: "grid", gap: 8 }}>
              <Command value={data.commands.status} />
              <Command value={data.commands.run} />
              <Command value={data.commands.approve} />
              <Command value={data.commands.sync} />
              <Command value={data.commands.words} />
              <Command value={data.commands.packet} />
              <Command value={data.commands.feedback} />
            </div>
          </Section>

          <Section title="Stages">
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
              <thead>
                <tr style={{ color: "#8b949e", textAlign: "left" }}>
                  <th style={{ padding: "4px 8px" }}>stage</th>
                  <th style={{ padding: "4px 8px" }}>owner</th>
                  <th style={{ padding: "4px 8px" }}>runtime</th>
                  <th style={{ padding: "4px 8px" }}>model</th>
                  <th style={{ padding: "4px 8px" }}>review</th>
                  <th style={{ padding: "4px 8px" }}>outputs</th>
                </tr>
              </thead>
              <tbody>
                {data.workflow.stages.map((stage) => (
                  <tr key={stage.id} style={{ borderTop: "1px solid #21262d" }}>
                    <td style={{ padding: "4px 8px", color: "#c9d1d9", fontFamily: "monospace" }}>
                      {stage.id}
                      {stage.type === "foreach" ? <span style={{ color: "#8b949e" }}> foreach{stage.maxParallel ? ` x${stage.maxParallel}` : ""}</span> : null}
                    </td>
                    <td style={{ padding: "4px 8px", color: "#8b949e" }}>{stage.owner ?? stage.steps.map((s) => s.owner).filter(Boolean).join(", ")}</td>
                    <td style={{ padding: "4px 8px", color: "#8b949e" }}>{stage.runtime ?? stage.steps.map((s) => s.runtime).filter(Boolean).join(", ")}</td>
                    <td style={{ padding: "4px 8px", color: "#8b949e" }}>{stage.model ?? stage.modelTier ?? stage.steps.map((s) => s.model ?? s.modelTier).filter(Boolean).join(", ")}</td>
                    <td style={{ padding: "4px 8px", color: stage.requiresHumanApproval ? "#d29922" : "#8b949e" }}>
                      {stage.requiresHumanApproval ? "gate" : ""}
                    </td>
                    <td style={{ padding: "4px 8px", color: "#8b949e", fontFamily: "monospace", fontSize: 12 }}>
                      {stage.outputs.slice(0, 3).join(", ")}{stage.outputs.length > 3 ? `, +${stage.outputs.length - 3}` : ""}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Section>

          <Section title="Recent logs">
            {data.operation?.stdout || data.operation?.stderr ? (
              <details open={data.operation.running} style={{ marginBottom: 8 }}>
                <summary style={{ color: "#58a6ff", cursor: "pointer", fontFamily: "monospace", fontSize: 13 }}>
                  dashboard-run output
                </summary>
                <pre style={{
                  margin: "6px 0 0",
                  padding: 10,
                  maxHeight: 260,
                  overflow: "auto",
                  whiteSpace: "pre-wrap",
                  background: "#0d1117",
                  border: "1px solid #30363d",
                  borderRadius: 6,
                  color: data.operation.stderr ? "#f85149" : "#c9d1d9",
                  fontSize: 12,
                }}>{[data.operation.stdout, data.operation.stderr].filter(Boolean).join("\n")}</pre>
              </details>
            ) : null}
            {data.logs.length === 0 ? (
              <div style={{ color: "#8b949e", fontSize: 13 }}>No worker logs found.</div>
            ) : (
              <div style={{ display: "grid", gap: 8 }}>
                {data.logs.map((log) => (
                  <details key={log.name} open={data.logs.length === 1}>
                    <summary style={{ color: "#58a6ff", cursor: "pointer", fontFamily: "monospace", fontSize: 13 }}>
                      {log.name}{log.truncated ? " (tail)" : ""}
                    </summary>
                    <pre style={{
                      margin: "6px 0 0",
                      padding: 10,
                      maxHeight: 260,
                      overflow: "auto",
                      whiteSpace: "pre-wrap",
                      background: "#0d1117",
                      border: "1px solid #30363d",
                      borderRadius: 6,
                      color: "#c9d1d9",
                      fontSize: 12,
                    }}>{log.content}</pre>
                  </details>
                ))}
              </div>
            )}
          </Section>
        </>
      )}
    </div>
  );
}

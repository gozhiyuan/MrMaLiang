import fs from "node:fs/promises";
import path from "node:path";
import { consolidateCitationLedger, type CitationLedgerEntry, type EvidenceChunk, type EvidencePacket } from "./evidence.js";
import type { ClassifiedSource } from "./types.js";
import { loadProjectConfig } from "../project-config.js";
import { isClaimBearingEvidenceExcerpt } from "./semantic-screen.js";

type Gate = { id: string; pass: boolean; findings: string[] };
type ReleaseReport = { pass: boolean; gates: Gate[] };

type RecoveryMetrics = {
  cited_sources?: number;
  citations_per_page?: number;
  ledger_unresolved?: number;
  claim_support_rate?: number;
  review_score?: number;
};

type RecoverySnapshot = {
  version: 1;
  generated_at: string;
  release_pass: boolean;
  failed_gate_ids: string[];
  gate_pass: Record<string, boolean>;
  metrics: RecoveryMetrics;
};

type PlannedRepairAction = {
  id: string;
  tool: string;
  finding_ids: string[];
  acceptance_criteria?: Array<{ metric: string; operator?: string; target: number; scope?: string }>;
};

type ValidatedEvidenceClaim = {
  claim: string;
  supporting_excerpt: string;
  locator: string;
};

type ActiveValidatedEvidence = {
  entries?: Array<{ packet?: { source_id?: string; claims?: ValidatedEvidenceClaim[] } }>;
};

async function readJson<T>(file: string): Promise<T | null> {
  try {
    return JSON.parse(await fs.readFile(file, "utf-8")) as T;
  } catch {
    return null;
  }
}

async function readJsonl<T>(file: string): Promise<T[]> {
  try {
    return (await fs.readFile(file, "utf-8")).split("\n").flatMap((line) => {
      if (!line.trim()) return [];
      try { return [JSON.parse(line) as T]; } catch { return []; }
    });
  } catch {
    return [];
  }
}

function isAcceptedSource(source: ClassifiedSource): boolean {
  const status = source.identity?.publication_status?.toLowerCase() ?? "";
  if (/(accepted|published|inproceedings|journal|proceedings)/.test(status)) return true;
  return Boolean(source.identifiers?.doi) && !/(arxiv|preprint|unknown)/i.test(source.venue);
}

function sourceMarkers(text: string): string[] {
  return [...text.matchAll(/\[source:([^:\]]+)(?::[^\]]+)?\]/g)].map((match) => match[1]!);
}

function safeFileStem(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/g, "_");
}

function normalizedText(value: string): string {
  return value.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").replace(/\s+/g, " ").trim();
}

function locatorParagraph(value: string): number | undefined {
  const matched = value.match(/(?:paragraph|p)\s*:?\s*(\d+)/i);
  return matched ? Number(matched[1]) : undefined;
}

/** Recovery editors may only receive claim-bearing excerpts that have already
 * crossed the semantic/full-text evidence boundary. Section FTS chunks are
 * useful retrieval material, but an arbitrary paragraph (or provider metadata
 * page) is not automatically safe material for a new manuscript claim. */
async function validatedClaimsBySource(workspaceDir: string, sourceTitles: Map<string, string>): Promise<Map<string, ValidatedEvidenceClaim[]>> {
  const artifact = await readJson<ActiveValidatedEvidence>(path.join(workspaceDir, "evidence", "active-validated-source-evidence.json"));
  const result = new Map<string, ValidatedEvidenceClaim[]>();
  for (const entry of artifact?.entries ?? []) {
    const sourceId = entry.packet?.source_id;
    if (!sourceId || !Array.isArray(entry.packet?.claims)) continue;
    result.set(sourceId, entry.packet.claims.filter((claim) =>
      typeof claim.claim === "string" && claim.claim.trim().length >= 12
      && typeof claim.supporting_excerpt === "string" && claim.supporting_excerpt.trim().length >= 12
      && typeof claim.locator === "string"
      && isClaimBearingEvidenceExcerpt(claim.supporting_excerpt, sourceTitles.get(sourceId) ?? "")));
  }
  return result;
}

function validatedClaimForChunk(claims: ValidatedEvidenceClaim[] | undefined, chunk: EvidenceChunk): ValidatedEvidenceClaim | undefined {
  const chunkText = normalizedText(chunk.text);
  return claims?.find((claim) => {
    const paragraph = locatorParagraph(claim.locator);
    const excerpt = normalizedText(claim.supporting_excerpt);
    return paragraph === chunk.locator.paragraph && excerpt.length > 0 && chunkText.includes(excerpt);
  });
}

function gatesFrom(value: unknown): Gate[] {
  if (!value || typeof value !== "object") return [];
  const gates = (value as { gates?: unknown }).gates;
  if (!Array.isArray(gates)) return [];
  return gates.flatMap((gate) => {
    if (!gate || typeof gate !== "object") return [];
    const item = gate as { id?: unknown; pass?: unknown; findings?: unknown };
    if (typeof item.id !== "string" || typeof item.pass !== "boolean") return [];
    return [{ id: item.id, pass: item.pass, findings: Array.isArray(item.findings) ? item.findings.filter((finding): finding is string => typeof finding === "string") : [] }];
  });
}

function citedMetrics(gates: Gate[]): Pick<RecoveryMetrics, "cited_sources" | "citations_per_page"> {
  const finding = gates.find((gate) => gate.id === "cited_literature_release_gates")?.findings.join(" ") ?? "";
  const cited = finding.match(/\bcited=(\d+)/)?.[1];
  const perPage = finding.match(/\bcitations?_per_page=([\d.]+)/)?.[1]
    ?? finding.match(/\(([\d.]+)\s+per\s+page\)/)?.[1];
  return {
    ...(cited ? { cited_sources: Number(cited) } : {}),
    ...(perPage ? { citations_per_page: Number(perPage) } : {}),
  };
}

async function currentSnapshot(workspaceDir: string): Promise<RecoverySnapshot> {
  const [release, audit, metrics] = await Promise.all([
    readJson<ReleaseReport>(path.join(workspaceDir, "reports", "release-gates.json")),
    readJson<{ missing_evidence?: unknown; metadata_linked?: unknown; unknown_source?: unknown }>(path.join(workspaceDir, "reports", "evidence-audit.json")),
    readJson<Record<string, unknown>>(path.join(workspaceDir, "reports", "metrics.json")),
  ]);
  const gates = gatesFrom(release);
  // A recovery loop may only compare two independently valid assessments.
  // Treat a missing/malformed report as a hard contract error instead of an
  // empty failure set (which would falsely look like every old gate passed).
  if (!release || typeof release.pass !== "boolean" || gates.length === 0) {
    throw new Error("reports/release-gates.json is missing or invalid; cannot assess recovery progress");
  }
  const numeric = (value: unknown): number | undefined => typeof value === "number" && Number.isFinite(value) ? value : undefined;
  const unresolved = [audit?.missing_evidence, audit?.metadata_linked, audit?.unknown_source]
    .map(numeric).reduce<number | undefined>((total, value) => value === undefined ? total : (total ?? 0) + value, undefined);
  return {
    version: 1,
    generated_at: new Date().toISOString(),
    release_pass: release?.pass === true,
    failed_gate_ids: gates.filter((gate) => !gate.pass).map((gate) => gate.id).sort(),
    gate_pass: Object.fromEntries(gates.map((gate) => [gate.id, gate.pass])),
    metrics: {
      ...citedMetrics(gates),
      ...(unresolved === undefined ? {} : { ledger_unresolved: unresolved }),
      ...(numeric(metrics?.claim_support_rate) === undefined ? {} : { claim_support_rate: numeric(metrics?.claim_support_rate) }),
      ...(numeric(metrics?.review_score) === undefined ? {} : { review_score: numeric(metrics?.review_score) }),
    },
  };
}

/** Materialize exact, section-scoped citation work items after allocation and
 * before the prose action runs. The editor is never asked to infer a repair
 * list from a hundred-line final validator log. */
export async function writeCitationRepairPacket(workspaceDir: string): Promise<{ items: number; written: string[] }> {
  const root = path.resolve(workspaceDir);
  // Allocation may have changed which markers resolve.  Rebuild from current
  // chapters and packets before deciding any editor work is still required.
  await consolidateCitationLedger(root);
  const ledger = await readJsonl<CitationLedgerEntry>(path.join(root, "evidence", "citation-ledger.jsonl"));
  const unresolved = ledger.filter((entry) => entry.status !== "evidence_linked");
  const packets = new Map<string, EvidencePacket>();
  for (const sectionId of [...new Set(unresolved.map((entry) => entry.section_id))]) {
    const packet = await readJson<EvidencePacket>(path.join(root, "evidence", `section-${safeFileStem(sectionId)}.json`));
    if (packet) packets.set(sectionId, packet);
  }
  const seen = new Set<string>();
  const repairs = unresolved.flatMap((entry) => {
    const key = `${entry.chapter_path}\u0000${entry.source_id}`;
    if (seen.has(key)) return [];
    seen.add(key);
    const packet = packets.get(entry.section_id);
    const chunks = packet?.chunks ?? [];
    const exactChunks = chunks.filter((chunk) => chunk.source_id === entry.source_id).slice(0, 3);
    const toMarker = (chunk: EvidenceChunk) => `[source:${chunk.source_id}:${chunk.id.slice(`${chunk.source_id}:`.length)}]`;
    return [{
      chapter_path: entry.chapter_path,
      section_id: entry.section_id,
      source_id: entry.source_id,
      current_status: entry.status,
      required_action: exactChunks.length > 0
        ? "replace every unresolved marker for this source with an exact marker below, or remove/rewrite each unsupported claim"
        : "remove or rewrite every unsupported claim cited to this source; no semantically verified replacement evidence is available in this section packet",
      exact_marker_options: exactChunks.map(toMarker),
    }];
  });
  const packet = {
    version: 1,
    generated_at: new Date().toISOString(),
    contract: "Every listed work item must be repaired in its named chapter. Do not retain a source-only marker. Use only exact markers for the same source, or remove/rewrite the unsupported claim; this packet never authorizes an unrelated replacement citation.",
    unresolved_entries: unresolved.length,
    repair_items: repairs,
  };
  const jsonPath = path.join(root, "reviews", "citation-repair-packet.json");
  const markdownPath = path.join(root, "reviews", "citation-repair-packet.md");
  await fs.mkdir(path.dirname(jsonPath), { recursive: true });
  await fs.writeFile(jsonPath, `${JSON.stringify(packet, null, 2)}\n`, "utf-8");
  await fs.writeFile(markdownPath, [
    "# Citation repair packet", "",
    `- Unresolved ledger entries: ${unresolved.length}`,
    `- Unique chapter/source work items: ${repairs.length}`,
    "- The editor must repair every JSON work item using its exact marker options or remove/rewrite the unsupported claim.",
    "- This packet is regenerated after evidence allocation; it is the authoritative repair scope for the current revision.", "",
  ].join("\n"), "utf-8");
  return { items: repairs.length, written: ["reviews/citation-repair-packet.json", "reviews/citation-repair-packet.md"] };
}

/** Turn the accepted-cited-source ratio into finite, chapter-local editor
 * work. The corpus can contain hundreds of eligible records while the prose
 * keeps reusing familiar preprints; a numerical gate alone does not tell an
 * editor which evidence-backed replacement is safe. This packet offers only
 * currently allocated accepted sources and exact locator markers. */
export async function writeCitedSourceUpgradePacket(workspaceDir: string): Promise<{ items: number; written: string[] }> {
  const root = path.resolve(workspaceDir);
  const sources = await readJsonl<ClassifiedSource>(path.join(root, "sources", "classified_sources.jsonl"));
  const config = await loadProjectConfig(root);
  const requiredRatio = config.research.release_gates.min_accepted_cited_ratio;
  const requiredCitedSources = config.research.release_gates.min_cited_sources;
  const byId = new Map(sources.map((source) => [source.id, source]));
  const validatedClaims = await validatedClaimsBySource(root, new Map(sources.map((source) => [source.id, source.title])));
  const chapterFiles = (await fs.readdir(path.join(root, "chapters")).catch(() => []))
    .filter((name) => name.endsWith(".md")).sort();
  const citedByChapter = new Map<string, string[]>();
  const allCited = new Set<string>();
  for (const name of chapterFiles) {
    const rel = `chapters/${name}`;
    const ids = [...new Set(sourceMarkers(await fs.readFile(path.join(root, rel), "utf8").catch(() => "")))];
    citedByChapter.set(rel, ids);
    for (const id of ids) allCited.add(id);
  }
  const cited = [...allCited];
  const acceptedCited = cited.filter((id) => {
    const source = byId.get(id);
    return source ? isAcceptedSource(source) : false;
  });
  const requiredAccepted = Math.ceil(cited.length * requiredRatio);
  const needed = Math.max(0, requiredAccepted - acceptedCited.length);
  const neededDistinct = Math.max(0, requiredCitedSources - cited.length);
  const packetBySection = new Map<string, EvidencePacket>();
  for (const name of await fs.readdir(path.join(root, "evidence")).catch(() => [])) {
    if (!/^section-.*\.json$/.test(name)) continue;
    const packet = await readJson<EvidencePacket>(path.join(root, "evidence", name));
    if (packet?.section_id) packetBySection.set(packet.section_id, packet);
  }
  const upgrades: Array<Record<string, unknown>> = [];
  const additions: Array<Record<string, unknown>> = [];
  const additionIds = new Set<string>();
  for (const [chapterPath, ids] of citedByChapter) {
    // Chapter stems and packet section_ids share the exact `section-*`
    // identity. Rewriting the prefix to `sec-*` made every packet lookup miss
    // and silently produced an empty recovery worklist.
    const sectionId = path.basename(chapterPath, ".md");
    const packet = packetBySection.get(sectionId);
    const uncitedChunks = [...new Map((packet?.chunks ?? [])
      .filter((chunk) => !allCited.has(chunk.source_id) && validatedClaimForChunk(validatedClaims.get(chunk.source_id), chunk))
      .map((chunk) => [chunk.source_id, chunk])).values()];
    const candidates = uncitedChunks
      .filter((chunk) => isAcceptedSource(byId.get(chunk.source_id) ?? {} as ClassifiedSource))
      .slice(0, 6)
      .map((chunk) => ({
        source_id: chunk.source_id,
        title: byId.get(chunk.source_id)?.title ?? chunk.source_id,
        venue: byId.get(chunk.source_id)?.venue ?? "",
        exact_marker: `[source:${chunk.source_id}:${chunk.id.slice(`${chunk.source_id}:`.length)}]`,
      }));
    for (const sourceId of ids.filter((id) => !isAcceptedSource(byId.get(id) ?? {} as ClassifiedSource))) {
      if (candidates.length === 0) continue;
      upgrades.push({ chapter_path: chapterPath, section_id: sectionId, nonaccepted_source_id: sourceId, accepted_replacement_options: candidates });
    }
    for (const chunk of uncitedChunks) {
      if (additionIds.has(chunk.source_id)) continue;
      const source = byId.get(chunk.source_id);
      if (!source) continue;
      const validated = validatedClaimForChunk(validatedClaims.get(chunk.source_id), chunk);
      if (!validated) continue;
      additionIds.add(chunk.source_id);
      additions.push({
        chapter_path: chapterPath,
        section_id: sectionId,
        source_id: chunk.source_id,
        title: source.title,
        venue: source.venue,
        citation_depth: source.citation_depth,
        accepted: isAcceptedSource(source),
        exact_marker: `[source:${chunk.source_id}:${chunk.id.slice(`${chunk.source_id}:`.length)}]`,
        suggested_claim: validated.claim,
        evidence_excerpt: validated.supporting_excerpt,
        locator: chunk.locator,
        evidence_status: "validated_claim_excerpt",
      });
    }
  }
  additions.sort((left, right) => Number(right.accepted) - Number(left.accepted)
    || String(left.chapter_path).localeCompare(String(right.chapter_path))
    || String(left.source_id).localeCompare(String(right.source_id)));
  const boundedAdditions = additions.slice(0, Math.min(40, Math.max(neededDistinct * 3, 12)));
  const jsonPath = path.join(root, "reviews", "cited-source-upgrade-packet.json");
  const markdownPath = path.join(root, "reviews", "cited-source-upgrade-packet.md");
  const packet = {
    version: 1, generated_at: new Date().toISOString(), cited_sources: cited.length,
    required_cited_sources: requiredCitedSources, required_distinct_additions: neededDistinct,
    accepted_cited_sources: acceptedCited.length, required_accepted_cited_sources: requiredAccepted,
    required_replacements: needed, addition_candidates: boundedAdditions, upgrade_items: upgrades,
    candidate_capacity_pass: boundedAdditions.length >= neededDistinct && (needed === 0 || upgrades.length >= needed),
    contract: "Every addition or replacement option is backed by an exact excerpt that already passed semantic/full-text validation. When required_distinct_additions is positive, add at least that many distinct addition_candidates to their named chapters, writing only the suggested_claim or a narrower claim directly supported by evidence_excerpt and using its exact_marker. When required_replacements is positive, replace at least that many listed nonaccepted citations with distinct accepted replacement options in the same chapter. Preserve claim meaning only when the replacement packet supports it; otherwise narrow or remove the claim. Do not fabricate a locator, pad the bibliography, or treat an indexed metadata paragraph as claim evidence.",
  };
  await fs.mkdir(path.dirname(jsonPath), { recursive: true });
  await fs.writeFile(jsonPath, `${JSON.stringify(packet, null, 2)}\n`, "utf8");
  await fs.writeFile(markdownPath, [
    "# Accepted-source citation upgrade packet", "",
    `- Current distinct cited sources: ${cited.length}/${requiredCitedSources}`,
    `- Required distinct additions: ${neededDistinct}`,
    `- Packet-backed addition candidates: ${boundedAdditions.length}`,
    `- Current accepted cited sources: ${acceptedCited.length}/${cited.length}`,
    `- Required accepted cited sources at configured ratio: ${requiredAccepted}`,
    `- Required distinct upgrades: ${needed}`,
    `- Chapter-local upgrade work items: ${upgrades.length}`,
    "- Use only the exact accepted replacement markers in the JSON packet; preserve or narrow claims to the replacement evidence.", "",
  ].join("\n"), "utf8");
  return { items: upgrades.length + boundedAdditions.length, written: ["reviews/cited-source-upgrade-packet.json", "reviews/cited-source-upgrade-packet.md"] };
}

export async function writeFinalReleaseBaseline(workspaceDir: string): Promise<string> {
  const root = path.resolve(workspaceDir);
  const snapshot = await currentSnapshot(root);
  const rel = "reports/final-release-baseline.json";
  await fs.mkdir(path.join(root, "reports"), { recursive: true });
  await fs.writeFile(path.join(root, rel), `${JSON.stringify(snapshot, null, 2)}\n`, "utf-8");
  return rel;
}

/** Fail fast when an expensive recovery round leaves every measured release
 * objective unchanged, worse, or trades one hard failure for another. A round
 * is accepted transactionally: measurable improvement counts only when no
 * release gate or protected metric regresses. */
export async function assessFinalReleaseProgress(workspaceDir: string): Promise<{ pass: boolean; improvements: string[]; reportPath: string }> {
  const root = path.resolve(workspaceDir);
  const baseline = await readJson<RecoverySnapshot>(path.join(root, "reports", "final-release-baseline.json"));
  if (!baseline) throw new Error("reports/final-release-baseline.json is missing; recovery progress cannot be evaluated");
  const current = await currentSnapshot(root);
  const improvements: string[] = [];
  const regressions: string[] = [];
  const baselineGateIds = new Set(baseline.failed_gate_ids);
  for (const gate of Object.keys(baseline.gate_pass)) {
    if (current.gate_pass[gate] === undefined) regressions.push(`${gate} missing from current assessment`);
  }
  for (const gate of baseline.failed_gate_ids) {
    // A gate is only considered repaired when it remains present in the
    // current assessment and is explicitly marked passed. currentSnapshot's
    // validated report prevents a vanished gate from being counted as progress.
    if (current.gate_pass[gate] === true) improvements.push(`${gate} passed`);
    else if (current.gate_pass[gate] === undefined) { /* reported above */ }
  }
  for (const gate of current.failed_gate_ids) {
    if (!baselineGateIds.has(gate)) regressions.push(`${gate} newly failed`);
  }
  const increase = (key: "cited_sources" | "citations_per_page" | "claim_support_rate" | "review_score") => {
    const before = baseline.metrics[key]; const after = current.metrics[key];
    if (before !== undefined && after !== undefined) {
      if (after > before) improvements.push(`${key} improved (${before} → ${after})`);
      if (after < before) regressions.push(`${key} regressed (${before} → ${after})`);
    }
  };
  increase("cited_sources"); increase("citations_per_page"); increase("claim_support_rate"); increase("review_score");
  const beforeLedger = baseline.metrics.ledger_unresolved;
  const afterLedger = current.metrics.ledger_unresolved;
  if (beforeLedger !== undefined && afterLedger !== undefined && afterLedger < beforeLedger) improvements.push(`ledger_unresolved improved (${beforeLedger} → ${afterLedger})`);
  if (beforeLedger !== undefined && afterLedger !== undefined && afterLedger > beforeLedger) regressions.push(`ledger_unresolved regressed (${beforeLedger} → ${afterLedger})`);
  // Never spend another round on a state that improved one score by damaging
  // a different release obligation. The failed progress unit keeps the exact
  // regression visible and re-openable instead of blessing token-consuming
  // oscillation as convergence.
  const pass = current.release_pass || (improvements.length > 0 && regressions.length === 0);
  const actionPlan = await readJson<{ actions?: PlannedRepairAction[] }>(path.join(root, "reviews", "action-plan.json"));
  const actionOutcomes = (actionPlan?.actions ?? []).map((action) => {
    const unresolvedFindingIds = action.finding_ids.filter((id) => current.gate_pass[id] !== true);
    return {
      id: action.id,
      tool: action.tool,
      execution_status: "completed" as const,
      acceptance_status: unresolvedFindingIds.length === 0 ? "accepted" as const : "unmet" as const,
      resolved_finding_ids: action.finding_ids.filter((id) => current.gate_pass[id] === true),
      unresolved_finding_ids: unresolvedFindingIds,
      acceptance_criteria: action.acceptance_criteria ?? [],
    };
  });
  const acceptedActions = actionOutcomes.filter((action) => action.acceptance_status === "accepted").length;
  const resolvedFindings = actionOutcomes.reduce((sum, action) => sum + action.resolved_finding_ids.length, 0);
  const stalled = actionOutcomes.length > 0 && resolvedFindings === 0;
  const metricsPath = path.join(root, "reports", "metrics.json");
  const priorMetrics = await readJson<Record<string, unknown>>(metricsPath) ?? {};
  const priorStreak = typeof priorMetrics.repair_stalled_rounds === "number" && Number.isFinite(priorMetrics.repair_stalled_rounds)
    ? priorMetrics.repair_stalled_rounds : 0;
  await fs.writeFile(metricsPath, `${JSON.stringify({
    ...priorMetrics,
    repair_acceptance_pass: actionOutcomes.length === 0 || acceptedActions === actionOutcomes.length ? 1 : 0,
    repair_actions_accepted: acceptedActions,
    repair_actions_unmet: actionOutcomes.length - acceptedActions,
    repair_findings_resolved: resolvedFindings,
    repair_stalled_rounds: stalled ? priorStreak + 1 : 0,
  }, null, 2)}\n`, "utf-8");
  const acceptanceRel = "reports/action-acceptance.json";
  await fs.writeFile(path.join(root, acceptanceRel), `${JSON.stringify({
    version: 1,
    generated_at: new Date().toISOString(),
    pass: actionOutcomes.length === 0 || acceptedActions === actionOutcomes.length,
    stalled,
    actions: actionOutcomes,
  }, null, 2)}\n`, "utf-8");
  const rel = "reports/final-release-progress.json";
  const markdown = "reports/final-release-progress.md";
  await fs.writeFile(path.join(root, rel), `${JSON.stringify({ version: 1, generated_at: new Date().toISOString(), pass, baseline, current, improvements, regressions, action_acceptance: { pass: actionOutcomes.length === 0 || acceptedActions === actionOutcomes.length, stalled, actions: actionOutcomes } }, null, 2)}\n`, "utf-8");
  await fs.writeFile(path.join(root, markdown), [
    "# Final-release recovery progress", "",
    `- Status: ${pass ? "progress recorded" : "no measurable progress"}`,
    `- Release pass: ${current.release_pass ? "yes" : "no"}`,
    ...(improvements.length > 0 ? improvements.map((item) => `- ${item}`) : ["- No failed gate passed and no tracked recovery metric improved."]),
    ...(regressions.length > 0 ? ["", "## Regressions", ...regressions.map((item) => `- ${item}`)] : []), "",
    "## Action acceptance", "",
    ...(actionOutcomes.length > 0
      ? actionOutcomes.map((action) => `- ${action.id} (${action.tool}): ${action.acceptance_status}${action.unresolved_finding_ids.length ? `; unresolved ${action.unresolved_finding_ids.join(", ")}` : ""}`)
      : ["- No repair actions were dispatched."]), "",
  ].join("\n"), "utf-8");
  return { pass, improvements, reportPath: rel };
}

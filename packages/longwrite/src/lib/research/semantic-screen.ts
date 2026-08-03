import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { toJsonl, parseJsonl } from "./jsonl.js";
import { writeBibtex } from "./bibtex.js";
import { buildCitationPlan } from "./citation-plan.js";
import type { ClassifiedSource, CitationDepth } from "./types.js";
import { loadProjectConfig } from "../project-config.js";

/** Agentic-only bridge between metadata triage and deep reading.  It never
 * searches, scores, or promotes sources itself: scripts select/validate the
 * bounded workset, while the LLM supplies inspectable semantic judgments. */

export const SEMANTIC_CANDIDATES_PATH = "sources/semantic-screening-candidates.json";
export const SEMANTIC_SCREEN_PATH = "sources/semantic-screening.json";
export const SOURCE_EVIDENCE_CANDIDATES_PATH = "sources/source-evidence-candidates.json";
export const SOURCE_EVIDENCE_PATH = "evidence/source-packets.json";
/** Durable, cumulative record of evidence packets which have already passed
 * excerpt validation. Recovery rounds may replace their working artifacts,
 * but must never silently discard validated evidence from an earlier round. */
export const VALIDATED_SOURCE_EVIDENCE_HISTORY_PATH = "evidence/validated-source-evidence.json";
/** Citation-ready projection of the durable history. It contains only
 * packets whose source IDs are still present at A/B depth in the current
 * classified corpus; archived packets remain in the history for audit. */
export const ACTIVE_VALIDATED_SOURCE_EVIDENCE_PATH = "evidence/active-validated-source-evidence.json";
const METADATA_CLASSIFIED_PATH = "sources/metadata-classified_sources.jsonl";

const Depth = z.enum(["A", "B", "C", "D"]);

const SemanticCandidate = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  abstract: z.string(),
  year: z.number().int(),
  venue: z.string(),
  topics: z.array(z.string()),
  quality_score: z.number(),
  metadata_depth: Depth,
  taxonomy_cells: z.array(z.string()),
  selection_reasons: z.array(z.string()).min(1),
}).strict();

export const SemanticCandidateSet = z.object({
  version: z.literal(1),
  candidates: z.array(SemanticCandidate),
}).strict();

const SemanticScreening = z.object({
  source_id: z.string().min(1),
  taxonomy_cells: z.array(z.string().min(2)).max(12),
  chapter_role: z.enum(["protagonist", "comparison", "background", "exclude"]),
  semantic_relevance: z.enum(["high", "medium", "low"]),
  rationale: z.string().min(20).max(2_000),
  recommended_depth: Depth,
  fulltext_priority: z.boolean(),
}).strict();

export const SemanticScreen = z.object({
  version: z.literal(1),
  screenings: z.array(SemanticScreening).max(200),
}).strict();
export type SemanticScreen = z.infer<typeof SemanticScreen>;

const SourceEvidenceClaim = z.object({
  claim: z.string().min(12).max(1_000),
  supporting_excerpt: z.string().min(12).max(700),
  locator: z.string().min(1).max(300),
  comparison_dimensions: z.array(z.string().min(2).max(160)).max(8).default([]),
  limitations: z.array(z.string().min(4).max(500)).max(8).default([]),
}).strict();

const SourceEvidencePacket = z.object({
  source_id: z.string().min(1),
  recommended_depth: z.enum(["A", "B", "C"]),
  claims: z.array(SourceEvidenceClaim).min(1).max(5),
}).strict();

export const SourceEvidencePackets = z.object({
  version: z.literal(1),
  packets: z.array(SourceEvidencePacket).max(100),
}).strict();
export type SourceEvidencePackets = z.infer<typeof SourceEvidencePackets>;

const ValidatedSourceEvidenceHistory = z.object({
  version: z.literal(1),
  entries: z.array(z.object({
    screening: SemanticScreening,
    packet: SourceEvidencePacket,
  }).strict()).max(500),
}).strict();
type ValidatedSourceEvidenceHistory = z.infer<typeof ValidatedSourceEvidenceHistory>;

async function loadValidatedEvidenceHistory(workspaceDir: string): Promise<ValidatedSourceEvidenceHistory> {
  try {
    return ValidatedSourceEvidenceHistory.parse(JSON.parse(await fs.readFile(path.join(workspaceDir, VALIDATED_SOURCE_EVIDENCE_HISTORY_PATH), "utf-8")));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { version: 1, entries: [] };
    throw new Error(`${VALIDATED_SOURCE_EVIDENCE_HISTORY_PATH}: invalid cumulative evidence history`, { cause: error });
  }
}

/** Restore a cumulative evidence record for workspaces created before the
 * history artifact existed. A MalaClaw checkpoint is written only after its
 * unit succeeds, so completed source-evidence extraction checkpoints are a
 * safe provenance source. The closest preceding semantic-screen checkpoint in
 * the same recovery round supplies the paired judgment. */
export async function backfillValidatedEvidenceHistory(workspaceDir: string): Promise<{ recovered: number; total: number; reportPath: string }> {
  const root = path.join(workspaceDir, ".malaclaw", "flow", "checkpoints");
  const reportPath = "reports/validated-evidence-history-backfill.md";
  let names: string[];
  try {
    names = await fs.readdir(root, { recursive: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new Error("No flow checkpoints are available to backfill validated evidence history.");
    throw error;
  }
  const packetFiles = names.filter((name) => name.endsWith("-corpus_recovery_source_evidence_extract/evidence/source-packets.json")).sort();
  const screenFiles = names.filter((name) => name.endsWith("-corpus_recovery_semantic_screen/sources/semantic-screening.json")).sort();
  const roundOf = (name: string) => name.match(/-corpus_evidence_recovery_loop-r(\d+)-corpus_recovery_/)?.[1];
  const checkpointTime = (name: string) => name.slice(0, 24);
  const history = await loadValidatedEvidenceHistory(workspaceDir);
  const merged = new Map(history.entries.map((entry) => [entry.packet.source_id, entry]));
  let recovered = 0;
  for (const packetFile of packetFiles) {
    const round = roundOf(packetFile);
    const screenFile = screenFiles.filter((candidate) => roundOf(candidate) === round && checkpointTime(candidate) <= checkpointTime(packetFile)).at(-1);
    if (!screenFile) continue;
    const [packets, screen] = await Promise.all([
      fs.readFile(path.join(root, packetFile), "utf-8").then((value) => SourceEvidencePackets.parse(JSON.parse(value))),
      fs.readFile(path.join(root, screenFile), "utf-8").then((value) => SemanticScreen.parse(JSON.parse(value))),
    ]);
    const screeningById = new Map(screen.screenings.map((item) => [item.source_id, item]));
    for (const packet of packets.packets) {
      const screening = screeningById.get(packet.source_id);
      if (!screening) continue;
      merged.set(packet.source_id, { screening, packet });
      recovered += 1;
    }
  }
  const artifact = ValidatedSourceEvidenceHistory.parse({ version: 1, entries: [...merged.values()] });
  await Promise.all([
    fs.mkdir(path.join(workspaceDir, "evidence"), { recursive: true }),
    fs.mkdir(path.join(workspaceDir, "reports"), { recursive: true }),
  ]);
  await fs.writeFile(path.join(workspaceDir, VALIDATED_SOURCE_EVIDENCE_HISTORY_PATH), `${JSON.stringify(artifact, null, 2)}\n`, "utf-8");
  await fs.writeFile(path.join(workspaceDir, reportPath), [
    "# Validated evidence history backfill", "",
    `- Completed extraction checkpoints inspected: ${packetFiles.length}`,
    `- Packet records recovered: ${recovered}`,
    `- Cumulative validated packets: ${artifact.entries.length}`,
    "- Provenance: completed MalaClaw source-evidence extraction checkpoints paired with the preceding semantic screen in the same recovery round.", "",
  ].join("\n"), "utf-8");
  return { recovered, total: artifact.entries.length, reportPath };
}

/** One-time companion migration for the pre-cumulative-recovery workflow.
 * Earlier successful finalization checkpoints retain source metadata that an
 * old expansion path could subsequently overwrite. Restore their union to
 * the durable recall corpus so the evidence history can still refer to live
 * classified sources on the next deterministic rebuild. */
export async function restoreRecoveryCorpusFromCheckpoints(workspaceDir: string): Promise<{ restored: number; total: number; reportPath: string }> {
  const root = path.join(workspaceDir, ".malaclaw", "flow", "checkpoints");
  const reportPath = "reports/recovery-corpus-restore.md";
  let names: string[];
  try {
    names = await fs.readdir(root, { recursive: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new Error("No flow checkpoints are available to restore the recovery corpus.");
    throw error;
  }
  const snapshotFiles = names.filter((name) => name.endsWith("_finalize_evidence_depth/sources/classified_sources.jsonl")).sort();
  const merged = new Map<string, ClassifiedSource>();
  for (const file of snapshotFiles) {
    const sources = parseJsonl<ClassifiedSource>(await fs.readFile(path.join(root, file), "utf-8"));
    for (const source of sources) if (!merged.has(source.id)) merged.set(source.id, source);
  }
  const beforeCurrent = merged.size;
  try {
    const current = parseJsonl<ClassifiedSource>(await fs.readFile(path.join(workspaceDir, "sources", "deduped_sources.jsonl"), "utf-8"));
    // Prefer the latest provider metadata/provenance when the same ID exists.
    for (const source of current) merged.set(source.id, source);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  await fs.mkdir(path.join(workspaceDir, "reports"), { recursive: true });
  await fs.writeFile(path.join(workspaceDir, "sources", "deduped_sources.jsonl"), toJsonl([...merged.values()]), "utf-8");
  await fs.writeFile(path.join(workspaceDir, reportPath), [
    "# Recovery corpus restore", "",
    `- Finalization checkpoints inspected: ${snapshotFiles.length}`,
    `- Sources recovered from checkpoints: ${beforeCurrent}`,
    `- Durable deduplicated corpus after merge: ${merged.size}`,
    "- Current corpus metadata wins on duplicate source IDs; the next score/classify pass rederives all provisional fields.", "",
  ].join("\n"), "utf-8");
  return { restored: beforeCurrent, total: merged.size, reportPath };
}

async function readOptionalCurrentEvidence(workspaceDir: string): Promise<{ screen: SemanticScreen; packets: SourceEvidencePackets } | null> {
  try {
    const [screen, packets] = await Promise.all([
      fs.readFile(path.join(workspaceDir, SEMANTIC_SCREEN_PATH), "utf-8").then((value) => SemanticScreen.parse(JSON.parse(value))),
      fs.readFile(path.join(workspaceDir, SOURCE_EVIDENCE_PATH), "utf-8").then((value) => SourceEvidencePackets.parse(JSON.parse(value))),
    ]);
    return { screen, packets };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

function normalize(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, " ").replace(/\s+/g, " ").trim();
}

function sourceMatchesCell(source: ClassifiedSource, cell: string): boolean {
  const terms = normalize(cell).split(" ").filter((term) => term.length >= 4);
  if (terms.length === 0) return false;
  const text = normalize(`${source.title} ${source.abstract} ${source.topics.join(" ")}`);
  return terms.filter((term) => text.includes(term)).length >= Math.min(2, terms.length);
}

async function readClassified(workspaceDir: string, rel = "sources/classified_sources.jsonl"): Promise<ClassifiedSource[]> {
  return parseJsonl<ClassifiedSource>(await fs.readFile(path.join(workspaceDir, rel), "utf-8"));
}

function unwrapFence(raw: string): { content: string; normalized: boolean } {
  const trimmed = raw.trim();
  const matched = trimmed.match(/^```(?:json)?\s*\n([\s\S]*?)\n```$/i);
  return matched ? { content: matched[1]!.trim(), normalized: true } : { content: trimmed, normalized: false };
}

/** Script-selected subset: LQS rank is retained, while every taxonomy cell
 * reserves candidates so an early keyword miss cannot starve deep reading. */
export async function selectSemanticCandidates(workspaceDir: string): Promise<string[]> {
  const config = await loadProjectConfig(workspaceDir);
  const settings = config.research.semantic_screen;
  const sources = await readClassified(workspaceDir);
  const ranked = [...sources].filter((source) => source.citation_depth !== "D")
    .sort((a, b) => b.quality_score - a.quality_score || b.year - a.year);
  const selected = new Map<string, { source: ClassifiedSource; reasons: string[] }>();
  // Reserve taxonomy coverage *before* spending the remaining capacity on the
  // global LQS ranking. Filling rank first would make the reserve a no-op at
  // the cap and recreate the exact blind spot this stage is meant to expose.
  for (const cell of config.research.taxonomy) {
    for (const source of ranked.filter((candidate) => sourceMatchesCell(candidate, cell)).slice(0, settings.min_candidates_per_taxonomy_cell)) {
      const current = selected.get(source.id);
      if (current) current.reasons.push(`taxonomy reserve: ${cell}`);
      else if (selected.size < settings.max_candidates) selected.set(source.id, { source, reasons: [`taxonomy reserve: ${cell}`] });
    }
  }
  for (const source of ranked) {
    if (selected.size >= settings.max_candidates) break;
    const current = selected.get(source.id);
    if (current) current.reasons.push("metadata LQS rank");
    else selected.set(source.id, { source, reasons: ["metadata LQS rank"] });
  }
  const candidates = [...selected.values()].map(({ source, reasons }) => ({
    id: source.id, title: source.title, abstract: source.abstract, year: source.year,
    venue: source.venue, topics: source.topics, quality_score: source.quality_score,
    metadata_depth: source.citation_depth, taxonomy_cells: config.research.taxonomy.filter((cell) => sourceMatchesCell(source, cell)),
    selection_reasons: [...new Set(reasons)],
  })).sort((a, b) => b.quality_score - a.quality_score || b.year - a.year);
  const artifact = SemanticCandidateSet.parse({ version: 1, candidates });
  await fs.mkdir(path.join(workspaceDir, "sources"), { recursive: true });
  await Promise.all([
    fs.writeFile(path.join(workspaceDir, SEMANTIC_CANDIDATES_PATH), `${JSON.stringify(artifact, null, 2)}\n`, "utf-8"),
    fs.copyFile(path.join(workspaceDir, "sources", "classified_sources.jsonl"), path.join(workspaceDir, METADATA_CLASSIFIED_PATH)),
  ]);
  return [SEMANTIC_CANDIDATES_PATH, METADATA_CLASSIFIED_PATH];
}

export async function repairSemanticScreen(workspaceDir: string): Promise<{ normalized: boolean; reportPath: string }> {
  const target = path.join(workspaceDir, SEMANTIC_SCREEN_PATH);
  const reportPath = path.join(workspaceDir, "reports", "semantic-screen-repair.md");
  const raw = await fs.readFile(target, "utf-8");
  const { content, normalized } = unwrapFence(raw);
  try {
    const [screen, candidates, config] = await Promise.all([
      Promise.resolve(SemanticScreen.parse(JSON.parse(content))),
      fs.readFile(path.join(workspaceDir, SEMANTIC_CANDIDATES_PATH), "utf-8").then((value) => SemanticCandidateSet.parse(JSON.parse(value))),
      loadProjectConfig(workspaceDir),
    ]);
    const allowed = new Set(candidates.candidates.map((candidate) => candidate.id));
    const seen = new Set<string>();
    for (const screening of screen.screenings) {
      if (!allowed.has(screening.source_id)) throw new Error(`screening names source outside bounded candidate set: ${screening.source_id}`);
      if (seen.has(screening.source_id)) throw new Error(`duplicate screening for source ${screening.source_id}`);
      seen.add(screening.source_id);
      for (const cell of screening.taxonomy_cells) if (!config.research.taxonomy.includes(cell)) throw new Error(`screening names unconfigured taxonomy cell: ${cell}`);
      if (screening.chapter_role === "exclude" && screening.fulltext_priority) throw new Error(`excluded source ${screening.source_id} cannot request full text`);
    }
    if (screen.screenings.length === 0) throw new Error("screening must assess at least one bounded candidate");
    if (normalized) {
      await fs.writeFile(`${target}.pre-normalization.md`, raw, "utf-8");
      await fs.writeFile(target, `${JSON.stringify(screen, null, 2)}\n`, "utf-8");
    }
    await fs.mkdir(path.dirname(reportPath), { recursive: true });
    await fs.writeFile(reportPath, ["# Semantic-screen contract repair", "", "- Status: pass", `- Valid screenings: ${screen.screenings.length}`, `- Full-text priorities: ${screen.screenings.filter((item) => item.fulltext_priority).length}`, `- Envelope normalized: ${normalized ? "yes" : "no"}`, ""].join("\n"), "utf-8");
  } catch (error) {
    const detail = error instanceof z.ZodError
      ? error.issues.slice(0, 8).map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ")
      : error instanceof Error ? error.message.split("\n")[0] : String(error);
    await fs.mkdir(path.dirname(reportPath), { recursive: true });
    await fs.writeFile(reportPath, ["# Semantic-screen contract repair", "", "- Status: failed", `- Detail: ${detail}`, "- Required repair: write one JSON object that only screens sources in sources/semantic-screening-candidates.json.", ""].join("\n"), "utf-8");
    throw new Error(`${SEMANTIC_SCREEN_PATH}: invalid semantic-screen contract; see reports/semantic-screen-repair.md`);
  }
  return { normalized, reportPath: "reports/semantic-screen-repair.md" };
}

/** Select only ingested, semantically approved sources for costly claim-level
 * reading. The stage deliberately leaves unapproved sources at C/D later. */
export async function selectSourceEvidenceCandidates(workspaceDir: string): Promise<string[]> {
  const config = await loadProjectConfig(workspaceDir);
  const [screen, manifestRaw, sources] = await Promise.all([
    fs.readFile(path.join(workspaceDir, SEMANTIC_SCREEN_PATH), "utf-8").then((value) => SemanticScreen.parse(JSON.parse(value))),
    fs.readFile(path.join(workspaceDir, "fulltext", "manifest.json"), "utf-8"),
    readClassified(workspaceDir),
  ]);
  const manifest = JSON.parse(manifestRaw) as { results?: Array<{ sourceId?: string; status?: string; path?: string }> };
  const ingested = new Map((manifest.results ?? []).flatMap((result) => result.status === "ingested" && result.sourceId && result.path ? [[result.sourceId, result.path] as const] : []));
  const sourceById = new Map(sources.map((source) => [source.id, source]));
  const ordered = screen.screenings
    .filter((item) => item.fulltext_priority && item.semantic_relevance !== "low" && item.recommended_depth !== "D" && ingested.has(item.source_id))
    .sort((a, b) => (a.recommended_depth === "A" ? 0 : 1) - (b.recommended_depth === "A" ? 0 : 1));
  const candidates = ordered.slice(0, config.research.semantic_screen.max_evidence_sources).flatMap((screening) => {
    const source = sourceById.get(screening.source_id);
    const fulltext_path = ingested.get(screening.source_id);
    return source && fulltext_path ? [{ id: source.id, title: source.title, recommended_depth: screening.recommended_depth, taxonomy_cells: screening.taxonomy_cells, fulltext_path }] : [];
  });
  await fs.mkdir(path.join(workspaceDir, "sources"), { recursive: true });
  await fs.writeFile(path.join(workspaceDir, SOURCE_EVIDENCE_CANDIDATES_PATH), `${JSON.stringify({ version: 1, candidates }, null, 2)}\n`, "utf-8");
  return [SOURCE_EVIDENCE_CANDIDATES_PATH];
}

/** Validates semantic extraction without treating the model's assertion as a
 * fact: every packet must target an ingested source and contain a normalized
 * excerpt that is actually present in the retrieved full text. */
export async function repairSourceEvidencePackets(workspaceDir: string): Promise<{ normalized: boolean; reportPath: string }> {
  const target = path.join(workspaceDir, SOURCE_EVIDENCE_PATH);
  const reportPath = path.join(workspaceDir, "reports", "source-evidence-repair.md");
  const raw = await fs.readFile(target, "utf-8");
  const { content, normalized } = unwrapFence(raw);
  try {
    const [packets, candidatesRaw, config] = await Promise.all([
      Promise.resolve(SourceEvidencePackets.parse(JSON.parse(content))),
      fs.readFile(path.join(workspaceDir, SOURCE_EVIDENCE_CANDIDATES_PATH), "utf-8").then((value) => JSON.parse(value) as { candidates?: Array<{ id?: string; fulltext_path?: string }> }),
      loadProjectConfig(workspaceDir),
    ]);
    const candidates = new Map((candidatesRaw.candidates ?? []).flatMap((candidate) => candidate.id && candidate.fulltext_path ? [[candidate.id, candidate.fulltext_path] as const] : []));
    const seen = new Set<string>();
    for (const packet of packets.packets) {
      const rel = candidates.get(packet.source_id);
      if (!rel) throw new Error(`packet names source without approved ingested full text: ${packet.source_id}`);
      if (seen.has(packet.source_id)) throw new Error(`duplicate evidence packet for source ${packet.source_id}`);
      seen.add(packet.source_id);
      const fulltext = normalize(await fs.readFile(path.join(workspaceDir, rel), "utf-8"));
      for (const claim of packet.claims) {
        const excerpt = normalize(claim.supporting_excerpt);
        const wordCount = excerpt ? excerpt.split(" ").length : 0;
        if (wordCount < 4) {
          throw new Error(`packet ${packet.source_id} excerpt has ${wordCount} normalized words; use an exact contiguous excerpt of at least 4 words from ${rel}`);
        }
        if (!fulltext.includes(excerpt)) {
          throw new Error(`packet ${packet.source_id} excerpt is not found in ${rel}; copy an exact contiguous excerpt without paraphrasing`);
        }
      }
      const minimum = packet.recommended_depth === "A" ? config.research.semantic_screen.min_supported_claims_for_a : config.research.semantic_screen.min_supported_claims_for_b;
      if (packet.claims.length < minimum) throw new Error(`packet ${packet.source_id} has ${packet.claims.length} supported claims; ${minimum} required for ${packet.recommended_depth}`);
    }
    if (normalized) {
      await fs.writeFile(`${target}.pre-normalization.md`, raw, "utf-8");
      await fs.writeFile(target, `${JSON.stringify(packets, null, 2)}\n`, "utf-8");
    }
    // The current round is a working set, not the entire evidence record. A
    // source that has already passed exact-excerpt validation remains useful
    // even if a later recovery round selects a different bounded subset.
    let cumulative = 0;
    try {
      const screen = SemanticScreen.parse(JSON.parse(await fs.readFile(path.join(workspaceDir, SEMANTIC_SCREEN_PATH), "utf-8")));
      const screeningById = new Map(screen.screenings.map((item) => [item.source_id, item]));
      const history = await loadValidatedEvidenceHistory(workspaceDir);
      const merged = new Map(history.entries.map((entry) => [entry.packet.source_id, entry]));
      for (const packet of packets.packets) {
        const screening = screeningById.get(packet.source_id);
        if (!screening) throw new Error(`packet ${packet.source_id} has no semantic screening to preserve with its evidence`);
        merged.set(packet.source_id, { screening, packet });
      }
      const artifact = ValidatedSourceEvidenceHistory.parse({ version: 1, entries: [...merged.values()] });
      await fs.writeFile(path.join(workspaceDir, VALIDATED_SOURCE_EVIDENCE_HISTORY_PATH), `${JSON.stringify(artifact, null, 2)}\n`, "utf-8");
      cumulative = artifact.entries.length;
    } catch (error) {
      // Unit-level source-packet validation remains useful in isolation. In a
      // real agentic flow this artifact always follows semantic screening, so
      // any non-ENOENT history/screen error must stop the flow rather than
      // risking a partial cumulative record.
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    await fs.mkdir(path.dirname(reportPath), { recursive: true });
    await fs.writeFile(reportPath, ["# Source-evidence contract repair", "", "- Status: pass", `- Valid source packets: ${packets.packets.length}`, `- Cumulative validated packets: ${cumulative || "not recorded (semantic screen unavailable)"}`, `- Envelope normalized: ${normalized ? "yes" : "no"}`, ""].join("\n"), "utf-8");
  } catch (error) {
    const detail = error instanceof Error ? error.message.split("\n")[0] : String(error);
    await fs.mkdir(path.dirname(reportPath), { recursive: true });
    await fs.writeFile(reportPath, ["# Source-evidence contract repair", "", "- Status: failed", `- Detail: ${detail}`, "- Required repair: create packets only for approved ingested sources and use exact excerpts from their retrieved full text.", ""].join("\n"), "utf-8");
    throw new Error(`${SOURCE_EVIDENCE_PATH}: invalid source-evidence contract; see reports/source-evidence-repair.md`);
  }
  return { normalized, reportPath: "reports/source-evidence-repair.md" };
}

/** Metadata classification is provisional in agentic mode. A/B becomes final
 * only when abstract screening, ingested full text, and validated source
 * evidence agree. C remains available for contextual use. */
export async function finalizeEvidenceBackedDepth(workspaceDir: string): Promise<string[]> {
  const config = await loadProjectConfig(workspaceDir);
  const [metadata, history, current] = await Promise.all([
    readClassified(workspaceDir, METADATA_CLASSIFIED_PATH),
    loadValidatedEvidenceHistory(workspaceDir),
    readOptionalCurrentEvidence(workspaceDir),
  ]);
  const evidence = new Map(history.entries.map((entry) => [entry.packet.source_id, entry]));
  // Prefer a validated current packet only when present in history. This
  // protects callers that invoke finalization before the repair stage.
  if (current) {
    const currentScreenings = new Map(current.screen.screenings.map((item) => [item.source_id, item]));
    for (const packet of current.packets.packets) {
      const screening = currentScreenings.get(packet.source_id);
      if (screening && evidence.has(packet.source_id)) evidence.set(packet.source_id, { screening, packet });
    }
  }
  const finalized = metadata.map((source) => {
    const validated = evidence.get(source.id);
    const screening = validated?.screening;
    const packet = validated?.packet;
    const proposed = screening?.recommended_depth;
    const validSemantic = screening?.semantic_relevance !== "low" && screening?.chapter_role !== "exclude";
    const claims = packet?.claims.length ?? 0;
    const minimumA = config.research.semantic_screen.min_supported_claims_for_a;
    const minimumB = config.research.semantic_screen.min_supported_claims_for_b;
    let citation_depth: CitationDepth = source.citation_depth;
    if (validSemantic && packet && proposed === "A" && claims >= minimumA) citation_depth = "A";
    else if (validSemantic && packet && (proposed === "A" || proposed === "B") && claims >= minimumB) citation_depth = "B";
    else if (source.citation_depth === "A" || source.citation_depth === "B") citation_depth = "C";
    return {
      ...source,
      citation_depth,
      citation_depth_rationale: citation_depth === source.citation_depth
        ? `${source.citation_depth_rationale} Semantic screen and full-text evidence packet satisfied the agentic depth contract.`
        : (citation_depth === "A" || citation_depth === "B")
          ? `${source.citation_depth_rationale} Promoted by a validated semantic screen and exact-excerpt full-text evidence packet.`
          : `${source.citation_depth_rationale} Downgraded from metadata-provisional ${source.citation_depth}: no validated semantic/full-text evidence packet met the agentic A/B contract.`,
    };
  });
  const citationPlan = buildCitationPlan(finalized);
  const currentCoreIds = new Set(finalized.filter((source) => source.citation_depth === "A" || source.citation_depth === "B").map((source) => source.id));
  const activeEvidence = ValidatedSourceEvidenceHistory.parse({
    version: 1,
    entries: history.entries.filter((entry) => currentCoreIds.has(entry.packet.source_id)),
  });
  const report = ["# Evidence-backed depth finalization", "", `- Metadata-provisional A/B sources: ${metadata.filter((source) => source.citation_depth === "A" || source.citation_depth === "B").length}`, `- Cumulative validated packets (audit history): ${history.entries.length}`, `- Active validated packets (current A/B corpus): ${activeEvidence.entries.length}`, `- Evidence-backed final A/B sources: ${finalized.filter((source) => source.citation_depth === "A" || source.citation_depth === "B").length}`, "- Rule: A/B requires a validated semantic screen, retrieved full text, and source evidence packet; earlier validated packets remain eligible across recovery rounds, while only current A/B records are citation-ready.", ""];
  await Promise.all([
    fs.writeFile(path.join(workspaceDir, "sources", "classified_sources.jsonl"), toJsonl(finalized), "utf-8"),
    fs.writeFile(path.join(workspaceDir, "sources", "bibliography.bib"), writeBibtex(finalized), "utf-8"),
    fs.writeFile(path.join(workspaceDir, "sources", "citation_plan.jsonl"), toJsonl(citationPlan), "utf-8"),
    fs.writeFile(path.join(workspaceDir, ACTIVE_VALIDATED_SOURCE_EVIDENCE_PATH), `${JSON.stringify(activeEvidence, null, 2)}\n`, "utf-8"),
    fs.writeFile(path.join(workspaceDir, "reports", "evidence-depth-finalization.md"), report.join("\n"), "utf-8"),
  ]);
  return ["sources/classified_sources.jsonl", "sources/bibliography.bib", "sources/citation_plan.jsonl", ACTIVE_VALIDATED_SOURCE_EVIDENCE_PATH, "reports/evidence-depth-finalization.md"];
}

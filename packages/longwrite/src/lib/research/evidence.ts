import fs from "node:fs/promises";
import path from "node:path";
import { bibtexKey } from "./bibtex.js";
import { citationMarkers } from "./citation-markers.js";
import { parseJsonl } from "./jsonl.js";
import type { ClassifiedSource } from "./types.js";
import type { EmbeddingClient } from "./embeddings.js";

/** Lazy-load node:sqlite so merely IMPORTING this module never crashes on
 *  Node < 22. Only stages that actually build/query the FTS index pay the
 *  version requirement, with a clear message instead of ERR_UNKNOWN_BUILTIN. */
async function loadDatabaseSync(): Promise<typeof import("node:sqlite").DatabaseSync> {
  try {
    const mod = await import("node:sqlite");
    return mod.DatabaseSync;
  } catch (err) {
    throw new Error(
      "The evidence index requires node:sqlite (Node.js >= 22). " +
      "This workspace's scaffolded commands must run on a Node 22+ binary. " +
      `Underlying error: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

export type EvidenceLocator = {
  heading?: string;
  paragraph: number;
};

export type EvidenceChunk = {
  id: string;
  source_id: string;
  citation_key: string;
  locator: EvidenceLocator;
  text: string;
  chars: number;
};

export type EvidencePacket = {
  version: 1;
  section_id: string;
  section_title: string;
  query: string;
  generated_at: string;
  source_ids: string[];
  chunks: EvidenceChunk[];
};

export type CitationLedgerEntry = {
  version: 1;
  section_id: string;
  source_id: string;
  citation_key?: string;
  locator?: EvidenceLocator;
  chapter_path: string;
  status: "evidence_linked" | "metadata_linked" | "missing_evidence" | "unknown_source";
};

const EVIDENCE_DIR = "evidence";
const CHUNKS_PATH = `${EVIDENCE_DIR}/chunks.jsonl`;
const INDEX_PATH = `${EVIDENCE_DIR}/index.sqlite`;
const MANIFEST_PATH = `${EVIDENCE_DIR}/manifest.json`;
const COVERAGE_PATH = `${EVIDENCE_DIR}/coverage.json`;
const LEDGER_PATH = `${EVIDENCE_DIR}/citation-ledger.jsonl`;
const EMBEDDINGS_PATH = `${EVIDENCE_DIR}/embeddings.jsonl`;
const EVIDENCE_AUDIT_JSON = "reports/evidence-audit.json";
const EVIDENCE_AUDIT_MARKDOWN = "reports/evidence-audit.md";
const MAX_CHUNK_CHARS = 2_400;

function toJsonl(rows: unknown[]): string {
  return rows.map((row) => JSON.stringify(row)).join("\n") + (rows.length > 0 ? "\n" : "");
}

async function readJsonl<T>(workspaceDir: string, rel: string): Promise<T[]> {
  const raw = await fs.readFile(path.join(workspaceDir, rel), "utf-8");
  return parseJsonl<T>(raw);
}

function safeFileStem(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/g, "_");
}

function contentAfterFrontMatter(markdown: string): string {
  const marker = "\n---\n";
  const index = markdown.indexOf(marker);
  return index === -1 ? markdown : markdown.slice(index + marker.length);
}

function chunkText(sourceId: string, citationKey: string, markdown: string): EvidenceChunk[] {
  const lines = contentAfterFrontMatter(markdown).split("\n");
  const chunks: EvidenceChunk[] = [];
  let heading: string | undefined;
  let paragraph = 0;
  let buffer: string[] = [];

  const flush = () => {
    const text = buffer.join(" ").replace(/\s+/g, " ").trim();
    buffer = [];
    if (text.length < 120) return;
    paragraph += 1;
    // Keep chunks bounded without losing locator provenance. A long paragraph
    // becomes several chunks with the same heading and incrementing paragraph.
    for (let offset = 0; offset < text.length; offset += MAX_CHUNK_CHARS) {
      const part = text.slice(offset, offset + MAX_CHUNK_CHARS);
      const suffix = offset === 0 ? "" : `-${offset / MAX_CHUNK_CHARS + 1}`;
      chunks.push({
        id: `${sourceId}:p${paragraph}${suffix}`,
        source_id: sourceId,
        citation_key: citationKey,
        locator: { ...(heading ? { heading } : {}), paragraph },
        text: part,
        chars: part.length,
      });
    }
  };

  for (const line of lines) {
    const trimmed = line.trim();
    if (/^#{1,6}\s+/.test(trimmed)) {
      flush();
      heading = trimmed.replace(/^#{1,6}\s+/, "");
      continue;
    }
    if (trimmed.length === 0) {
      flush();
      continue;
    }
    buffer.push(trimmed);
  }
  flush();
  return chunks;
}

async function sourceCatalog(workspaceDir: string): Promise<Map<string, ClassifiedSource>> {
  const sources = await readJsonl<ClassifiedSource>(workspaceDir, "sources/classified_sources.jsonl");
  return new Map(sources.map((source) => [source.id, source]));
}

export async function buildEvidenceIndex(workspaceDir: string, opts: {
  backend?: "sqlite_fts" | "hybrid_openai";
  embeddingClient?: EmbeddingClient;
} = {}): Promise<{
  chunks: number;
  sources: number;
  written: string[];
}> {
  const catalog = await sourceCatalog(workspaceDir);
  const fulltextDir = path.join(workspaceDir, "fulltext");
  let entries: string[] = [];
  try {
    entries = (await fs.readdir(fulltextDir)).filter((entry) => entry.endsWith(".md")).sort();
  } catch {
    entries = [];
  }

  const chunks: EvidenceChunk[] = [];
  for (const entry of entries) {
    const sourceId = path.basename(entry, ".md");
    const source = catalog.get(sourceId);
    if (!source) continue;
    const markdown = await fs.readFile(path.join(fulltextDir, entry), "utf-8");
    chunks.push(...chunkText(sourceId, bibtexKey(source), markdown));
  }

  const evidenceDir = path.join(workspaceDir, EVIDENCE_DIR);
  await fs.mkdir(evidenceDir, { recursive: true });
  await fs.writeFile(path.join(workspaceDir, CHUNKS_PATH), toJsonl(chunks), "utf-8");

  const indexPath = path.join(workspaceDir, INDEX_PATH);
  await fs.rm(indexPath, { force: true });
  const DatabaseSync = await loadDatabaseSync();
  const db = new DatabaseSync(indexPath);
  try {
    db.exec("CREATE VIRTUAL TABLE chunks_fts USING fts5(chunk_id UNINDEXED, source_id UNINDEXED, citation_key UNINDEXED, locator UNINDEXED, text)");
    const insert = db.prepare("INSERT INTO chunks_fts (chunk_id, source_id, citation_key, locator, text) VALUES (?, ?, ?, ?, ?)");
    for (const chunk of chunks) {
      insert.run(chunk.id, chunk.source_id, chunk.citation_key, JSON.stringify(chunk.locator), chunk.text);
    }
  } finally {
    db.close();
  }

  const backend = opts.backend ?? "sqlite_fts";
  let embeddingWritten: string[] = [];
  if (backend === "hybrid_openai") {
    if (!opts.embeddingClient) throw new Error("hybrid_openai evidence index requires an embedding client");
    const vectors: Array<{ chunk_id: string; vector: number[] }> = [];
    for (let offset = 0; offset < chunks.length; offset += 32) {
      const batch = chunks.slice(offset, offset + 32);
      const embedded = await opts.embeddingClient.embed(batch.map((chunk) => chunk.text));
      vectors.push(...batch.map((chunk, index) => ({ chunk_id: chunk.id, vector: embedded[index] })));
    }
    await fs.writeFile(path.join(workspaceDir, EMBEDDINGS_PATH), toJsonl(vectors), "utf-8");
    embeddingWritten = [EMBEDDINGS_PATH];
  }
  const manifest = {
    version: 1,
    generated_at: new Date().toISOString(),
    backend,
    ...(backend === "hybrid_openai" ? { embedding_model: opts.embeddingClient!.model, embeddings: chunks.length } : {}),
    sources_indexed: new Set(chunks.map((chunk) => chunk.source_id)).size,
    chunks: chunks.length,
    source_documents: entries,
    derived_from: ["sources/classified_sources.jsonl", "fulltext/*.md"],
  };
  await fs.writeFile(path.join(workspaceDir, MANIFEST_PATH), `${JSON.stringify(manifest, null, 2)}\n`, "utf-8");
  return { chunks: chunks.length, sources: manifest.sources_indexed, written: [CHUNKS_PATH, INDEX_PATH, ...embeddingWritten, MANIFEST_PATH] };
}

function ftsQuery(query: string): string {
  const terms = query.match(/[\p{L}\p{N}_-]{2,}/gu) ?? [];
  if (terms.length === 0) throw new Error("Evidence query needs at least one searchable term");
  return terms.slice(0, 20).map((term) => `"${term.replace(/"/g, "")}"`).join(" OR ");
}

export async function searchEvidence(workspaceDir: string, query: string, limit = 12, opts: { embeddingClient?: EmbeddingClient } = {}): Promise<EvidenceChunk[]> {
  const indexPath = path.join(workspaceDir, INDEX_PATH);
  try {
    await fs.access(indexPath);
  } catch {
    throw new Error("Evidence index is missing. Run: longwrite evidence index <workspace>");
  }
  const DatabaseSync = await loadDatabaseSync();
  const db = new DatabaseSync(indexPath, { readOnly: true });
  try {
    const rows = db.prepare(
      "SELECT chunk_id, source_id, citation_key, locator, text FROM chunks_fts WHERE chunks_fts MATCH ? ORDER BY bm25(chunks_fts) LIMIT ?",
    ).all(ftsQuery(query), limit) as Array<{ chunk_id: string; source_id: string; citation_key: string; locator: string; text: string }>;
    const lexical = rows.map((row) => ({
      id: row.chunk_id,
      source_id: row.source_id,
      citation_key: row.citation_key,
      locator: JSON.parse(row.locator) as EvidenceLocator,
      text: row.text,
      chars: row.text.length,
    }));
    const manifest = JSON.parse(await fs.readFile(path.join(workspaceDir, MANIFEST_PATH), "utf-8")) as { backend?: string };
    if (manifest.backend !== "hybrid_openai") return lexical;
    if (!opts.embeddingClient) throw new Error("hybrid_openai evidence search requires an embedding client");
    const raw = await fs.readFile(path.join(workspaceDir, EMBEDDINGS_PATH), "utf-8");
    const vectors = parseJsonl<{ chunk_id: string; vector: number[] }>(raw);
    const [queryVector] = await opts.embeddingClient.embed([query]);
    const dot = (a: number[], b: number[]) => a.length === b.length ? a.reduce((sum, value, index) => sum + value * b[index], 0) : -Infinity;
    const scoredVectors: Array<[string, number]> = vectors.map((row) => [row.chunk_id, dot(queryVector, row.vector)]);
    const vectorRank = new Map<string, number>(scoredVectors.sort((a, b) => b[1] - a[1]).map(([id], index) => [id, index + 1]));
    const lexicalRank = new Map(lexical.map((chunk, index) => [chunk.id, index + 1]));
    const allChunks = await readJsonl<EvidenceChunk>(workspaceDir, CHUNKS_PATH);
    const byId = new Map(allChunks.map((chunk) => [chunk.id, chunk]));
    // RRF combines provider-independent lexical recall with optional vector
    // ranking; only stored chunks with stable IDs/locators participate.
    return [...byId.values()].sort((a, b) =>
      (1 / (60 + (vectorRank.get(b.id) ?? 10_000)) + 1 / (60 + (lexicalRank.get(b.id) ?? 10_000))) -
      (1 / (60 + (vectorRank.get(a.id) ?? 10_000)) + 1 / (60 + (lexicalRank.get(a.id) ?? 10_000))),
    ).slice(0, limit);
  } finally {
    db.close();
  }
}

type OutlineSection = { id: string; title?: string; keywords?: string[] };

const TAXONOMY_STOP_WORDS = new Set(["and", "for", "from", "into", "the", "with"]);

function normalizedTerms(value: string): string[] {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .split(/\s+/)
    .filter((term) => term.length > 1 && !TAXONOMY_STOP_WORDS.has(term));
}

/** Taxonomy cells are human labels, not exact phrases. Requiring two label
 * terms keeps coverage useful ("tool-use planning" matches tool + planning)
 * without treating every generic agent mention as coverage. */
export function sourceMatchesTaxonomy(source: ClassifiedSource, cell: string): boolean {
  const terms = normalizedTerms(cell);
  if (terms.length === 0) return false;
  const sourceTerms = new Set(normalizedTerms(`${source.title} ${source.abstract} ${source.topics.join(" ")}`));
  const matched = terms.filter((term) => sourceTerms.has(term)).length;
  return matched >= Math.min(2, terms.length);
}

async function outlineSections(workspaceDir: string): Promise<OutlineSection[]> {
  const raw = JSON.parse(await fs.readFile(path.join(workspaceDir, "outline.json"), "utf-8")) as { sections?: unknown };
  if (!Array.isArray(raw.sections)) throw new Error("outline.json must contain a sections array before evidence allocation");
  const sections = raw.sections
    .filter((value): value is Record<string, unknown> => typeof value === "object" && value !== null)
    .map((value) => ({
      id: typeof value.id === "string" ? value.id : "",
      title: typeof value.title === "string" ? value.title : undefined,
      keywords: Array.isArray(value.keywords) ? value.keywords.filter((term): term is string => typeof term === "string") : [],
    }))
    .filter((section) => section.id.length > 0);
  if (sections.length === 0) throw new Error("outline.json sections must contain string ids");
  return sections;
}

export async function allocateSectionEvidence(workspaceDir: string, taxonomy: string[] = [], opts: { embeddingClient?: EmbeddingClient } = {}): Promise<{
  sections: number;
  packets: string[];
  coveragePath: string;
}> {
  const [sections, sources] = await Promise.all([
    outlineSections(workspaceDir),
    readJsonl<ClassifiedSource>(workspaceDir, "sources/classified_sources.jsonl"),
  ]);
  // FTS is useful for focused selection, but an outline's display title can
  // be far from the wording used in a source. Keep a local chunk catalogue so
  // an already-selected attributable source can supply a bounded fallback
  // instead of producing an empty evidence packet.
  const allChunks = await readJsonl<EvidenceChunk>(workspaceDir, CHUNKS_PATH).catch(() => []);
  const evidenceDir = path.join(workspaceDir, EVIDENCE_DIR);
  await fs.mkdir(evidenceDir, { recursive: true });
  const packets: string[] = [];
  const primary = sources.filter((source) => source.citation_depth === "A" || source.citation_depth === "B");
  // C sources are ranked, topical candidates with incomplete metadata. Use
  // them when a keyless corpus has no A/B records so every outline section
  // receives attributable material rather than an empty packet.
  const core = primary.length > 0
    ? primary
    : sources.filter((source) => source.citation_depth === "C");

  for (const section of sections) {
    const query = [section.title ?? section.id, ...(section.keywords ?? [])].join(" ");
    const retrieved = await searchEvidence(workspaceDir, query, 24, opts).catch(() => []);
    const chunkSourceIds = retrieved.map((chunk) => chunk.source_id);
    const fallbackSourceIds = core
      .filter((source) => `${source.title} ${source.abstract} ${source.topics.join(" ")}`.toLowerCase().includes(query.toLowerCase()))
      .map((source) => source.id);
    const sourceIds = [...new Set([...chunkSourceIds, ...fallbackSourceIds, ...core.map((source) => source.id)])].slice(0, 12);
    const seen = new Set<string>();
    const chunks = [...retrieved, ...allChunks.filter((chunk) => sourceIds.includes(chunk.source_id))]
      .filter((chunk) => {
        if (seen.has(chunk.id)) return false;
        seen.add(chunk.id);
        return true;
      })
      .slice(0, 24);
    const packet: EvidencePacket = {
      version: 1,
      section_id: section.id,
      section_title: section.title ?? section.id,
      query,
      generated_at: new Date().toISOString(),
      source_ids: sourceIds,
      chunks: chunks.filter((chunk) => sourceIds.includes(chunk.source_id)).slice(0, 24),
    };
    const rel = `${EVIDENCE_DIR}/section-${safeFileStem(section.id)}.json`;
    await fs.writeFile(path.join(workspaceDir, rel), `${JSON.stringify(packet, null, 2)}\n`, "utf-8");
    packets.push(rel);
  }

  const coverage = {
    version: 1,
    generated_at: new Date().toISOString(),
    sections: packets.length,
    taxonomy: taxonomy.map((cell) => ({
      cell,
      source_count: sources.filter((source) => sourceMatchesTaxonomy(source, cell)).length,
      direct_source_count: sources.filter((source) =>
        (source.citation_depth === "A" || source.citation_depth === "B") && sourceMatchesTaxonomy(source, cell),
      ).length,
    })),
    packets,
  };
  await fs.writeFile(path.join(workspaceDir, COVERAGE_PATH), `${JSON.stringify(coverage, null, 2)}\n`, "utf-8");
  return { sections: packets.length, packets, coveragePath: COVERAGE_PATH };
}

export async function consolidateCitationLedger(workspaceDir: string): Promise<{ entries: number; path: string }> {
  const catalog = await sourceCatalog(workspaceDir);
  const chaptersDir = path.join(workspaceDir, "chapters");
  let chapterNames: string[] = [];
  try {
    chapterNames = (await fs.readdir(chaptersDir)).filter((name) => name.endsWith(".md")).sort();
  } catch {
    chapterNames = [];
  }
  const entries: CitationLedgerEntry[] = [];
  for (const name of chapterNames) {
    const sectionId = path.basename(name, ".md");
    const chapterPath = path.join("chapters", name);
    const content = await fs.readFile(path.join(workspaceDir, chapterPath), "utf-8");
    let packet: EvidencePacket | undefined;
    try {
      packet = JSON.parse(await fs.readFile(path.join(workspaceDir, EVIDENCE_DIR, `section-${safeFileStem(sectionId)}.json`), "utf-8")) as EvidencePacket;
    } catch {
      packet = undefined;
    }
    for (const marker of citationMarkers(content)) {
      const source = catalog.get(marker.sourceId);
      // A source-level marker proves only that metadata is known. Publication
      // provenance requires the writer to name the exact packet chunk.
      const chunk = marker.evidenceChunkId
        ? packet?.chunks.find((candidate) => candidate.id === marker.evidenceChunkId)
        : undefined;
      entries.push({
        version: 1,
        section_id: sectionId,
        source_id: marker.sourceId,
        ...(source ? { citation_key: bibtexKey(source) } : {}),
        ...(chunk ? { locator: chunk.locator } : {}),
        chapter_path: chapterPath,
        status: !source
          ? "unknown_source"
          : chunk
            ? "evidence_linked"
            : packet?.source_ids.includes(marker.sourceId)
              ? "metadata_linked"
              : "missing_evidence",
      });
    }
  }
  await fs.mkdir(path.join(workspaceDir, EVIDENCE_DIR), { recursive: true });
  await fs.writeFile(path.join(workspaceDir, LEDGER_PATH), toJsonl(entries), "utf-8");
  return { entries: entries.length, path: LEDGER_PATH };
}

export async function validateEvidenceLedger(
  workspaceDir: string,
  opts: { allowMetadataOnly?: boolean } = {},
): Promise<{ pass: boolean; findings: string[] }> {
  const findings: string[] = [];
  let ledger: CitationLedgerEntry[] = [];
  try {
    ledger = await readJsonl<CitationLedgerEntry>(workspaceDir, LEDGER_PATH);
  } catch {
    findings.push(`${LEDGER_PATH} is missing; rebuild the citation ledger before final validation`);
    return { pass: false, findings };
  }
  for (const entry of ledger) {
    if (entry.status !== "evidence_linked" && !(opts.allowMetadataOnly && entry.status === "metadata_linked")) {
      findings.push(`${entry.chapter_path}: [source:${entry.source_id}] is ${entry.status.replace(/_/g, " ")}`);
    }
    if (!entry.locator && !(opts.allowMetadataOnly && entry.status === "metadata_linked")) {
      findings.push(`${entry.chapter_path}: [source:${entry.source_id}] has no evidence locator`);
    }
  }
  if (ledger.length === 0) findings.push("citation ledger has no entries; drafted chapters need attributable [source:<id>] markers");
  return { pass: findings.length === 0, findings };
}

/** Write a compact, model-readable evidence defect report. It is deliberately
 * advisory inside the revision loop: the next reviewer/editor receives it and
 * repairs prose, while final_validate remains the publication gate. */
export async function auditCitationEvidence(workspaceDir: string): Promise<{
  pass: boolean;
  entries: number;
  evidenceLinked: number;
  metadataLinked: number;
  missingEvidence: number;
  unknownSource: number;
  findings: string[];
  written: string[];
}> {
  let ledger: CitationLedgerEntry[] = [];
  try {
    ledger = await readJsonl<CitationLedgerEntry>(workspaceDir, LEDGER_PATH);
  } catch {
    // validateEvidenceLedger below supplies the precise actionable finding.
  }
  const validation = await validateEvidenceLedger(workspaceDir);
  const count = (status: CitationLedgerEntry["status"]) => ledger.filter((entry) => entry.status === status).length;
  const report = {
    version: 1,
    generated_at: new Date().toISOString(),
    pass: validation.pass,
    entries: ledger.length,
    evidence_linked: count("evidence_linked"),
    metadata_linked: count("metadata_linked"),
    missing_evidence: count("missing_evidence"),
    unknown_source: count("unknown_source"),
    findings: [...new Set(validation.findings)],
    repair_instruction: "For every factual claim, cite an exact chunk id from the matching evidence/section-<id>.json packet as [source:<source-id>:p<paragraph>]. Replace or remove claims that have no packet-backed chunk.",
  };
  const markdown = [
    "# Evidence Audit",
    "",
    `Status: ${report.pass ? "pass" : "repair required"}`,
    "",
    `- Citation entries: ${report.entries}`,
    `- Evidence linked: ${report.evidence_linked}`,
    `- Metadata only: ${report.metadata_linked}`,
    `- Missing evidence: ${report.missing_evidence}`,
    `- Unknown sources: ${report.unknown_source}`,
    "",
    "## Required Repair",
    "",
    report.repair_instruction,
    "",
    "## Findings",
    "",
    ...(report.findings.length > 0 ? report.findings.map((finding) => `- ${finding}`) : ["- No findings."]),
    "",
  ].join("\n");
  const reportsDir = path.join(workspaceDir, "reports");
  await fs.mkdir(reportsDir, { recursive: true });
  await Promise.all([
    fs.writeFile(path.join(workspaceDir, EVIDENCE_AUDIT_JSON), `${JSON.stringify(report, null, 2)}\n`, "utf-8"),
    fs.writeFile(path.join(workspaceDir, EVIDENCE_AUDIT_MARKDOWN), markdown, "utf-8"),
  ]);
  return {
    pass: report.pass,
    entries: report.entries,
    evidenceLinked: report.evidence_linked,
    metadataLinked: report.metadata_linked,
    missingEvidence: report.missing_evidence,
    unknownSource: report.unknown_source,
    findings: report.findings,
    written: [EVIDENCE_AUDIT_JSON, EVIDENCE_AUDIT_MARKDOWN],
  };
}

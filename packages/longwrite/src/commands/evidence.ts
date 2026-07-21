import path from "node:path";
import { allocateSectionEvidence, auditCitationEvidence, buildEvidenceIndex, consolidateCitationLedger, searchEvidence } from "../lib/research/evidence.js";
import { loadProjectConfig } from "../lib/project-config.js";
import { openAICompatibleEmbeddings } from "../lib/research/embeddings.js";

function embeddingClientFor(config: Awaited<ReturnType<typeof loadProjectConfig>>) {
  return config.research.retrieval.backend === "hybrid_openai"
    ? openAICompatibleEmbeddings({ model: config.research.retrieval.embedding_model })
    : undefined;
}

export async function runEvidenceIndex(workspaceDir: string): Promise<void> {
  const resolved = path.resolve(workspaceDir);
  const config = await loadProjectConfig(resolved);
  const result = await buildEvidenceIndex(resolved, {
    backend: config.research.retrieval.backend,
    embeddingClient: embeddingClientFor(config),
  });
  console.log(`Indexed ${result.chunks} evidence chunks from ${result.sources} source documents.`);
  for (const file of result.written) console.log(`  + ${file}`);
}

export async function runEvidenceSearch(workspaceDir: string, opts: { query?: string; limit?: string }): Promise<void> {
  const query = opts.query?.trim();
  if (!query) throw new Error("--query is required");
  const limit = opts.limit ? Number.parseInt(opts.limit, 10) : 12;
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error("--limit must be an integer from 1 to 100");
  const resolved = path.resolve(workspaceDir);
  const config = await loadProjectConfig(resolved);
  const chunks = await searchEvidence(resolved, query, limit, { embeddingClient: embeddingClientFor(config) });
  console.log(JSON.stringify({ query, chunks }, null, 2));
}

export async function runEvidenceAllocate(workspaceDir: string): Promise<void> {
  const resolved = path.resolve(workspaceDir);
  const config = await loadProjectConfig(resolved);
  const result = await allocateSectionEvidence(resolved, config.research.taxonomy, { embeddingClient: embeddingClientFor(config) });
  console.log(`Allocated evidence packets for ${result.sections} outline sections.`);
  for (const packet of result.packets) console.log(`  + ${packet}`);
  console.log(`  + ${result.coveragePath}`);
}

export async function runEvidenceConsolidate(workspaceDir: string): Promise<void> {
  const result = await consolidateCitationLedger(path.resolve(workspaceDir));
  console.log(`Consolidated ${result.entries} citation ledger entries.`);
  console.log(`  + ${result.path}`);
}

export async function runEvidenceAudit(workspaceDir: string): Promise<void> {
  const result = await auditCitationEvidence(path.resolve(workspaceDir));
  console.log(`Evidence audit: ${result.pass ? "pass" : "repair required"} (${result.evidenceLinked}/${result.entries} evidence-linked)`);
  for (const file of result.written) console.log(`  + ${file}`);
}

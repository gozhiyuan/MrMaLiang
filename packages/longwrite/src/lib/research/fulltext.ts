import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import crypto from "node:crypto";
import { parseJsonl } from "./jsonl.js";
import type { ClassifiedSource } from "./types.js";
import { SemanticScreen, SEMANTIC_SCREEN_PATH } from "./semantic-screen.js";

/** Full-text ingestion for core sources (citation depth A, then B up to the
 *  cap). Strategy is HTML-first: arXiv's HTML rendering, then ar5iv, then an
 *  open-access PDF. PDF extraction uses the optional system `pdftotext`
 *  binary, so the report remains honest when a host has no extractor.
 *  Failures are per-source and never fail the stage — the report says
 *  exactly what was ingested vs skipped, so reviewers know the evidence
 *  depth instead of assuming it. */

export type FulltextFetch = (url: string, init?: RequestInit) => Promise<Response>;
export type PdfTextExtractor = (pdf: Buffer, sourceId: string, workspaceDir: string) => Promise<string | null>;
export type FulltextOptions = {
  maxSources?: number;
  allowPdfDownload?: boolean;
  refresh?: boolean;
};

export type FulltextResult = {
  sourceId: string;
  status: "ingested" | "skipped" | "failed";
  detail: string;
  path?: string;
  sourcePath?: string;
  sha256?: string;
  chars?: number;
};

const MAX_SOURCES = 6;
const MAX_CHARS = 60_000;
const TIMEOUT_MS = 30_000;
const execFileAsync = promisify(execFile);

export function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<(nav|header|footer)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

type CandidateUrl = { url: string; kind: "html" | "pdf" };

/** An arXiv identifier gives us known, machine-readable retrieval endpoints.
 * `open_access_pdf` comes from heterogeneous metadata providers and is often a
 * publisher landing page despite its name, so it is only a fallback. */
function accessibilityRank(source: ClassifiedSource): number {
  if (source.identifiers?.arxiv_id) return 2;
  if (source.links?.open_access_pdf) return 1;
  return 0;
}

function candidateUrls(source: ClassifiedSource, allowPdfDownload: boolean): CandidateUrl[] {
  const arxivId = source.identifiers?.arxiv_id;
  const candidates: CandidateUrl[] = [];
  if (arxivId) {
    const bare = arxivId.replace(/v\d+$/, "");
    candidates.push(
      { url: `https://arxiv.org/html/${arxivId}`, kind: "html" },
      { url: `https://arxiv.org/html/${bare}`, kind: "html" },
      { url: `https://ar5iv.org/abs/${bare}`, kind: "html" },
      ...(allowPdfDownload ? [{ url: `https://arxiv.org/pdf/${bare}`, kind: "pdf" } satisfies CandidateUrl] : []),
    );
  }
  if (allowPdfDownload && source.links?.open_access_pdf) candidates.push({ url: source.links.open_access_pdf, kind: "pdf" });
  return candidates;
}

type ExtractedContent = { text: string; raw: string | Buffer; extension: "html" | "pdf" };

/** Seed is a deterministic CI/demo provider, not a publication source. Give
 * it a clearly labelled local document so the same evidence-index and
 * citation-locator path can be tested without network access. Live providers
 * never take this branch: they must yield real HTML/PDF text or be reported as
 * skipped/failed. */
async function ingestSeedMetadataDocument(
  workspaceDir: string,
  source: ClassifiedSource,
): Promise<FulltextResult> {
  const rel = `fulltext/${source.id}.md`;
  const sourceRel = `sources/documents/${source.id}.seed.json`;
  const excerpt = [
    `# ${source.title}`,
    "",
    "Source: deterministic LongWrite seed corpus (development fixture; not an external publication)",
    "Format: seed-metadata",
    "",
    "---",
    "",
    "## Synthetic metadata-grounded excerpt",
    "",
    source.abstract,
    "",
    "This local fixture exists only to exercise LongWrite's evidence packet, citation locator, and dry-run contracts without asserting that the text is a retrieved paper.",
    "",
  ].join("\n");
  await fs.mkdir(path.join(workspaceDir, "sources", "documents"), { recursive: true });
  await fs.writeFile(path.join(workspaceDir, rel), excerpt, "utf-8");
  const raw = JSON.stringify(source, null, 2);
  await fs.writeFile(path.join(workspaceDir, sourceRel), `${raw}\n`, "utf-8");
  return {
    sourceId: source.id,
    status: "ingested",
    detail: "deterministic seed metadata excerpt (development fixture; not external full text)",
    path: rel,
    sourcePath: sourceRel,
    sha256: crypto.createHash("sha256").update(raw).digest("hex"),
    chars: excerpt.length,
  };
}

async function fetchText(fetchImpl: FulltextFetch, url: string): Promise<ExtractedContent | null> {
  try {
    const response = await fetchImpl(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!response.ok) return null;
    const body = await response.text();
    const text = htmlToText(body);
    // Under ~2k chars is an abs page or an error shell, not a paper.
    return text.length >= 2_000 ? { text, raw: body, extension: "html" } : null;
  } catch {
    return null;
  }
}

async function extractPdfWithPdftotext(pdf: Buffer, sourceId: string, workspaceDir: string): Promise<string | null> {
  const safeId = sourceId.replace(/[^A-Za-z0-9._-]/g, "_");
  const tempPath = path.join(workspaceDir, "fulltext", `.extract-${safeId}-${Date.now()}.pdf`);
  try {
    await fs.writeFile(tempPath, pdf);
    const { stdout } = await execFileAsync("pdftotext", ["-layout", tempPath, "-"], {
      maxBuffer: MAX_CHARS * 4,
      timeout: TIMEOUT_MS,
    });
    const text = stdout.trim();
    return text.length >= 2_000 ? text : null;
  } catch {
    return null;
  } finally {
    await fs.rm(tempPath, { force: true });
  }
}

async function fetchPdfText(
  fetchImpl: FulltextFetch,
  extractor: PdfTextExtractor,
  url: string,
  sourceId: string,
  workspaceDir: string,
): Promise<ExtractedContent | null> {
  try {
    const response = await fetchImpl(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!response.ok) return null;
    const raw = Buffer.from(await response.arrayBuffer());
    const text = await extractor(raw, sourceId, workspaceDir);
    return text ? { text, raw, extension: "pdf" } : null;
  } catch {
    return null;
  }
}

export async function ingestFulltext(
  workspaceDir: string,
  fetchImpl: FulltextFetch = fetch,
  pdfExtractor: PdfTextExtractor = extractPdfWithPdftotext,
  opts: FulltextOptions = {},
): Promise<{ results: FulltextResult[]; written: string[] }> {
  const raw = await fs.readFile(path.join(workspaceDir, "sources", "classified_sources.jsonl"), "utf-8");
  const sources = parseJsonl<ClassifiedSource>(raw);
  // Agentic semantic screening is optional. When present and already
  // validated, it decides *which* bounded sources deserve deep reading;
  // access rank still breaks ties so the retrieval budget is not spent on
  // unreadable publisher landing pages when an equivalent candidate is open.
  let screenings = new Map<string, { fulltext_priority: boolean; semantic_relevance: "high" | "medium" | "low"; recommended_depth: "A" | "B" | "C" | "D" }>();
  try {
    const screen = SemanticScreen.parse(JSON.parse(await fs.readFile(path.join(workspaceDir, SEMANTIC_SCREEN_PATH), "utf-8")));
    screenings = new Map(screen.screenings.map((item) => [item.source_id, item]));
  } catch {
    // Stable V2 and pre-screen workspaces retain the original metadata order.
  }
  function semanticRank(source: ClassifiedSource): number {
    const screening = screenings.get(source.id);
    if (!screening?.fulltext_priority || screening.semantic_relevance === "low") return 0;
    return (screening.semantic_relevance === "high" ? 8 : 4) + (screening.recommended_depth === "A" ? 2 : screening.recommended_depth === "B" ? 1 : 0);
  }
  const depthRank: Record<ClassifiedSource["citation_depth"], number> = { A: 0, B: 1, C: 2, D: 3 };
  const ranked = [...sources].sort((a, b) =>
    // An arXiv identifier is a stronger access signal than a metadata
    // provider's `open_access_pdf`: the latter is frequently a landing page,
    // not a downloadable PDF. Prefer arXiv before that fallback so a broad
    // multi-provider corpus cannot exhaust its ingestion cap on unreadable
    // publisher records while reachable primary text is available.
    semanticRank(b) - semanticRank(a) ||
    accessibilityRank(b) - accessibilityRank(a) ||
    depthRank[a.citation_depth] - depthRank[b.citation_depth] ||
    b.quality_score - a.quality_score,
  );
  // Prefer established A/B sources, then admit C candidates. C means
  // incomplete metadata, not that its full text lacks value; retrieving it is
  // how a keyless arXiv-only corpus can gain direct evidence. Only fall back
  // to D when no stronger candidate exists.
  const eligible = (ranked.filter((source) => source.citation_depth !== "D").length > 0
    ? ranked.filter((source) => source.citation_depth !== "D")
    : ranked)
    .slice(0, opts.maxSources ?? MAX_SOURCES);

  const results: FulltextResult[] = [];
  const written: string[] = [];
  await fs.mkdir(path.join(workspaceDir, "fulltext"), { recursive: true });
  let prior = new Map<string, FulltextResult>();
  if (!opts.refresh) {
    try {
      const previous = JSON.parse(await fs.readFile(path.join(workspaceDir, "fulltext", "manifest.json"), "utf-8")) as { results?: FulltextResult[] };
      prior = new Map((previous.results ?? []).map((result) => [result.sourceId, result]));
    } catch {
      prior = new Map();
    }
  }

  for (const source of eligible) {
    const cached = prior.get(source.id);
    if (cached?.status === "ingested" && cached.path && cached.sourcePath) {
      try {
        await Promise.all([
          fs.access(path.join(workspaceDir, cached.path)),
          fs.access(path.join(workspaceDir, cached.sourcePath)),
        ]);
        results.push({ ...cached, detail: `cached: ${cached.detail}` });
        written.push(cached.path, cached.sourcePath);
        continue;
      } catch {
        // Cache is incomplete; re-fetch and replace it below.
      }
    }
    if (source.source === "seed") {
      const seeded = await ingestSeedMetadataDocument(workspaceDir, source);
      results.push(seeded);
      written.push(seeded.path!, seeded.sourcePath!);
      continue;
    }
    const urls = candidateUrls(source, opts.allowPdfDownload !== false);
    if (urls.length === 0) {
      results.push({
        sourceId: source.id,
        status: "skipped",
        detail: "no arXiv id or open-access PDF link",
      });
      continue;
    }
    let ingested = false;
    for (const candidate of urls) {
      const extracted = candidate.kind === "html"
        ? await fetchText(fetchImpl, candidate.url)
        : await fetchPdfText(fetchImpl, pdfExtractor, candidate.url, source.id, workspaceDir);
      if (!extracted) continue;
      const rel = `fulltext/${source.id}.md`;
      const clipped = extracted.text.slice(0, MAX_CHARS);
      const sourceRel = `sources/documents/${source.id}.${extracted.extension}`;
      await fs.mkdir(path.join(workspaceDir, "sources", "documents"), { recursive: true });
      await fs.writeFile(path.join(workspaceDir, sourceRel), extracted.raw);
      await fs.writeFile(
        path.join(workspaceDir, rel),
        `# ${source.title}\n\nSource: ${candidate.url}\nFormat: ${candidate.kind}\nRetrieved: ${new Date().toISOString()}\n\n---\n\n${clipped}\n`,
        "utf-8",
      );
      results.push({
        sourceId: source.id,
        status: "ingested",
        detail: candidate.url,
        path: rel,
        sourcePath: sourceRel,
        sha256: crypto.createHash("sha256").update(extracted.raw).digest("hex"),
        chars: clipped.length,
      });
      written.push(rel, sourceRel);
      ingested = true;
      break;
    }
    if (!ingested) {
      results.push({ sourceId: source.id, status: "failed", detail: `no readable HTML/PDF at ${urls.map((candidate) => candidate.url).join(", ")}` });
    }
  }

  const manifest = {
    version: 1,
    generated_at: new Date().toISOString(),
    results,
  };
  await fs.writeFile(path.join(workspaceDir, "fulltext", "manifest.json"), JSON.stringify(manifest, null, 2), "utf-8");
  const report = [
    "# Full-Text Ingestion Report",
    "",
    `Eligible sources: ${eligible.length} (verified arXiv endpoints first, then open-access links; citation depth breaks ties; cap ${opts.maxSources ?? MAX_SOURCES}).`,
    `Ingested: ${results.filter((r) => r.status === "ingested").length} · ` +
    `skipped: ${results.filter((r) => r.status === "skipped").length} · ` +
    `failed: ${results.filter((r) => r.status === "failed").length}`,
    "",
    ...results.map((r) => `- [${r.status}] ${r.sourceId}: ${r.detail}${r.chars ? ` (${r.chars.toLocaleString("en-US")} chars)` : ""}`),
    "",
    "Drafting stages receive fulltext/*.md as optional inputs. Sections",
    "citing a source WITHOUT ingested full text are working from metadata",
    "and abstract only — the assessment stage flags this distinction.",
    "",
  ].join("\n");
  await fs.mkdir(path.join(workspaceDir, "reports"), { recursive: true });
  await fs.writeFile(path.join(workspaceDir, "reports", "fulltext.md"), report, "utf-8");
  written.push("fulltext/manifest.json", "reports/fulltext.md");
  return { results, written };
}

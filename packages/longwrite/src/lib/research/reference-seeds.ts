import fs from "node:fs/promises";
import path from "node:path";
import { normalizeArxivAtom } from "./arxiv.js";
import { normalizeCrossrefResponse } from "./crossref.js";
import { loadProjectConfig } from "../project-config.js";
import type { RawSource } from "./types.js";

export type ScholarlyReferenceSeed =
  | { kind: "arxiv"; value: string; url: string }
  | { kind: "doi"; value: string; url: string }
  | { kind: "openreview"; value: string; url: string };

export function scholarlyReferenceSeed(value: string): ScholarlyReferenceSeed | null {
  const input = value.trim();
  let parsed: URL;
  try { parsed = new URL(input); } catch { return null; }
  const host = parsed.hostname.toLowerCase().replace(/^www\./, "");
  if (host === "arxiv.org") {
    const match = parsed.pathname.match(/^\/(?:abs|pdf)\/([^/?#]+?)(?:\.pdf)?$/i);
    if (match) return { kind: "arxiv", value: decodeURIComponent(match[1]!), url: input };
  }
  if (host === "doi.org" || host === "dx.doi.org") {
    const doi = decodeURIComponent(parsed.pathname.replace(/^\/+/, "")).toLowerCase();
    if (/^10\.\d{4,9}\/.+/.test(doi)) return { kind: "doi", value: doi, url: input };
  }
  if (host === "openreview.net") {
    const id = parsed.searchParams.get("id")?.trim();
    if (id && /^\/?(?:forum|pdf|attachment)/i.test(parsed.pathname)) return { kind: "openreview", value: id, url: input };
  }
  return null;
}

function contentValue(content: unknown, key: string): unknown {
  if (!content || typeof content !== "object") return undefined;
  const field = (content as Record<string, unknown>)[key];
  if (field && typeof field === "object" && "value" in field) return (field as { value?: unknown }).value;
  return field;
}

function openReviewSource(payload: unknown, seed: Extract<ScholarlyReferenceSeed, { kind: "openreview" }>, topic: string): RawSource {
  const notes = payload && typeof payload === "object" && Array.isArray((payload as { notes?: unknown }).notes)
    ? (payload as { notes: Array<Record<string, unknown>> }).notes : [];
  const note = notes.find((candidate) => candidate.id === seed.value) ?? notes[0];
  if (!note) throw new Error(`OpenReview returned no note for ${seed.value}`);
  const title = String(contentValue(note.content, "title") ?? "").trim();
  if (!title) throw new Error(`OpenReview note ${seed.value} has no title`);
  const authorValue = contentValue(note.content, "authors");
  const authors = Array.isArray(authorValue) ? authorValue.filter((item): item is string => typeof item === "string" && item.trim().length > 0) : [];
  const abstract = String(contentValue(note.content, "abstract") ?? "").trim();
  const venue = String(contentValue(note.content, "venue") ?? contentValue(note.content, "venueid") ?? "OpenReview").trim();
  const timestamp = typeof note.cdate === "number" ? note.cdate : typeof note.pdate === "number" ? note.pdate : undefined;
  const year = timestamp ? new Date(timestamp).getUTCFullYear() : new Date().getUTCFullYear();
  const pdf = contentValue(note.content, "pdf");
  return {
    id: `openreview-${seed.value.replace(/[^A-Za-z0-9]/g, "").slice(0, 20)}`,
    title, authors: authors.length ? authors : ["Unknown OpenReview Author"], year, venue,
    url: `https://openreview.net/forum?id=${encodeURIComponent(seed.value)}`,
    abstract, source: "openreview",
    topics: [...new Set(topic.toLowerCase().split(/\s+/).map((term) => term.replace(/[^a-z0-9-]/g, "")).filter(Boolean))],
    identifiers: { openreview_id: seed.value },
    links: typeof pdf === "string" && pdf.trim() ? { open_access_pdf: new URL(pdf, "https://openreview.net").toString(), canonical_url: seed.url } : { canonical_url: seed.url },
  };
}

async function resolveSeed(seed: ScholarlyReferenceSeed, topic: string, fetchImpl: typeof fetch): Promise<RawSource> {
  if (seed.kind === "arxiv") {
    const url = new URL("https://export.arxiv.org/api/query");
    url.searchParams.set("id_list", seed.value);
    url.searchParams.set("max_results", "1");
    const response = await fetchImpl(url, { headers: { accept: "application/atom+xml" }, signal: AbortSignal.timeout(20_000) });
    if (!response.ok) throw new Error(`arXiv reference seed ${seed.value} failed: HTTP ${response.status}`);
    const source = normalizeArxivAtom(await response.text(), topic)[0];
    if (!source || source.identifiers?.arxiv_id?.replace(/v\d+$/, "") !== seed.value.replace(/v\d+$/, "")) throw new Error(`arXiv reference seed ${seed.value} did not resolve exactly`);
    return { ...source, links: { ...source.links, canonical_url: seed.url } };
  }
  if (seed.kind === "doi") {
    const response = await fetchImpl(`https://api.crossref.org/works/${encodeURIComponent(seed.value)}`, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(20_000) });
    if (!response.ok) throw new Error(`DOI reference seed ${seed.value} failed: HTTP ${response.status}`);
    const payload = await response.json() as { message?: unknown };
    const source = normalizeCrossrefResponse({ message: { items: payload.message ? [payload.message] : [] } }, topic)[0];
    if (!source || source.identifiers?.doi !== seed.value) throw new Error(`DOI reference seed ${seed.value} did not resolve exactly`);
    return { ...source, links: { ...source.links, canonical_url: seed.url } };
  }
  const response = await fetchImpl(`https://api2.openreview.net/notes?id=${encodeURIComponent(seed.value)}`, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(20_000) });
  if (!response.ok) throw new Error(`OpenReview reference seed ${seed.value} failed: HTTP ${response.status}`);
  return openReviewSource(await response.json(), seed, topic);
}

/** Resolve recognized scholarly reference links exactly and fail closed. Other
 * links remain project context and are deliberately not promoted to evidence. */
export async function resolveWorkspaceReferenceSeeds(workspaceDir: string, topic: string, fetchImpl: typeof fetch = fetch, resolve = true): Promise<{ sources: RawSource[]; written: string[] }> {
  const configPath = path.join(workspaceDir, "longwrite.yaml");
  const referenceLinks = await fs.access(configPath).then(async () => (await loadProjectConfig(workspaceDir)).writing.reference_links).catch((error) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  });
  const seeds = referenceLinks.flatMap((link) => {
    const seed = scholarlyReferenceSeed(link);
    return seed ? [seed] : [];
  });
  const sources: RawSource[] = [];
  const failures: string[] = [];
  for (const seed of resolve ? seeds : []) {
    try { sources.push(await resolveSeed(seed, topic, fetchImpl)); }
    catch (error) { failures.push(`${seed.url}: ${error instanceof Error ? error.message : String(error)}`); }
  }
  await fs.mkdir(path.join(workspaceDir, "sources"), { recursive: true });
  await fs.mkdir(path.join(workspaceDir, "reports"), { recursive: true });
  await fs.writeFile(path.join(workspaceDir, "sources", "reference-seeds.json"), `${JSON.stringify({ version: 1, seeds, resolved_source_ids: sources.map((source) => source.id), failures }, null, 2)}\n`, "utf8");
  await fs.writeFile(path.join(workspaceDir, "reports", "reference-seeds.md"), [
    "# Authoritative scholarly reference seeds", "", `Recognized links: ${seeds.length}`, `Resolved exactly: ${sources.length}`, `Failures: ${failures.length}`, "",
    ...failures.map((failure) => `- ${failure}`),
    ...(seeds.length === 0 ? ["No arXiv, DOI, or OpenReview reference links were supplied. Other reference links remain unverified project context."] : []),
    ...(!resolve && seeds.length > 0 ? ["Resolution deferred because this is an offline seed-provider rehearsal; live runs fail closed if an authoritative seed cannot be resolved."] : []), "",
  ].join("\n"), "utf8");
  if (resolve && failures.length > 0) throw new Error(`failed to resolve ${failures.length} authoritative scholarly reference link(s); see reports/reference-seeds.md`);
  return { sources, written: ["sources/reference-seeds.json", "reports/reference-seeds.md"] };
}

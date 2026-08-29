import fs from "node:fs/promises";
import path from "node:path";
import { parseJsonl } from "./jsonl.js";
import { citationMarkers } from "./citation-markers.js";
import type { ClassifiedSource } from "./types.js";

export type CitationUrlVerification = {
  version: 1;
  source_id: string;
  url: string;
  status: "live" | "redirect" | "dead" | "unknown";
  http_status?: number;
  final_url?: string;
  checked_at: string;
  detail?: string;
};

export type VerifySourceOptions = {
  maxSources?: number;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  /**
   * Verify only the sources a single drafted section cites.
   *
   * Batching every citation into one check at the release gate means a
   * systemic problem — a provider that rewrote its URLs, a run of fabricated
   * records — is discovered after the whole manuscript is written. Scoping the
   * check to a section lets it run as that section is drafted, so the same
   * defect surfaces while there is still cheap work to redo.
   */
  section?: string;
};

const OUTPUT = "sources/citation-verification.jsonl";
const REPORT = "reports/source-verification.md";

async function readJsonl<T>(workspaceDir: string, rel: string): Promise<T[]> {
  return parseJsonl<T>(await fs.readFile(path.join(workspaceDir, rel), "utf-8"));
}

async function citedIds(workspaceDir: string, section?: string): Promise<Set<string>> {
  const dir = path.join(workspaceDir, "chapters");
  let names: string[] = [];
  try {
    names = (await fs.readdir(dir)).filter((name) => name.endsWith(".md"));
  } catch {
    return new Set();
  }
  if (section) names = names.filter((name) => name === `${section}.md`);
  const ids = new Set<string>();
  for (const name of names) {
    const content = await fs.readFile(path.join(dir, name), "utf-8");
    for (const marker of citationMarkers(content)) ids.add(marker.sourceId);
  }
  return ids;
}

async function verifyUrl(
  source: ClassifiedSource,
  fetchImpl: typeof fetch,
  timeoutMs: number,
): Promise<CitationUrlVerification> {
  const checked_at = new Date().toISOString();
  const base = { version: 1 as const, source_id: source.id, url: source.url, checked_at };
  if (!source.url || !/^https?:\/\//i.test(source.url)) {
    return { ...base, status: "unknown", detail: "source has no HTTP(S) URL" };
  }
  // DOI resolvers and scholarly CDNs occasionally time out while a known
  // canonical/open-access URL for the same classified record remains
  // reachable. Verify that evidence-preserving fallback before reporting an
  // operationally live citation as unknown.
  const urls = [...new Set([source.url, source.links?.open_access_pdf]
    .filter((url): url is string => typeof url === "string" && /^https?:\/\//i.test(url)))];
  const request = async (url: string, method: "HEAD" | "GET") => fetchImpl(url, {
    method,
    redirect: "follow",
    signal: AbortSignal.timeout(timeoutMs),
    ...(method === "GET" ? { headers: { range: "bytes=0-0" } } : {}),
  });
  let lastFailure: CitationUrlVerification | undefined;
  for (const url of urls) {
    try {
      let response = await request(url, "HEAD");
      // Common scholarly hosts deny HEAD but serve GET; a one-byte range keeps
      // verification from downloading a paper body.
      if ([403, 405, 501].includes(response.status)) response = await request(url, "GET");
      const final_url = response.url || url;
      if (response.ok) {
        return {
          ...base,
          status: final_url !== source.url ? "redirect" : "live",
          http_status: response.status,
          ...(final_url !== source.url ? { final_url } : {}),
        };
      }
      lastFailure = { ...base, status: "dead", http_status: response.status, ...(final_url !== source.url ? { final_url } : {}) };
    } catch (error) {
      lastFailure = { ...base, status: "unknown", detail: error instanceof Error ? error.message : String(error) };
    }
  }
  return lastFailure ?? { ...base, status: "unknown", detail: "no usable citation URL" };
}

export async function verifyCitedSourceUrls(
  workspaceDir: string,
  opts: VerifySourceOptions = {},
): Promise<{ results: CitationUrlVerification[]; written: string[] }> {
  const sources = await readJsonl<ClassifiedSource>(workspaceDir, "sources/classified_sources.jsonl");
  const cited = await citedIds(workspaceDir, opts.section);
  const selected = (cited.size > 0 ? sources.filter((source) => cited.has(source.id)) : sources)
    .slice(0, opts.maxSources ?? 30);
  const fetchImpl = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? 8_000;
  const results: CitationUrlVerification[] = [];
  // Small fixed concurrency avoids overloading provider/CDN endpoints.
  for (let index = 0; index < selected.length; index += 4) {
    results.push(...await Promise.all(selected.slice(index, index + 4).map((source) => verifyUrl(source, fetchImpl, timeoutMs))));
  }
  await fs.mkdir(path.join(workspaceDir, "sources"), { recursive: true });
  await fs.mkdir(path.join(workspaceDir, "reports"), { recursive: true });
  const outputPath = opts.section ? OUTPUT.replace(/\.jsonl$/, `-${opts.section}.jsonl`) : OUTPUT;
  const reportPath = opts.section ? REPORT.replace(/\.md$/, `-${opts.section}.md`) : REPORT;
  await fs.writeFile(path.join(workspaceDir, outputPath), results.map((result) => JSON.stringify(result)).join("\n") + (results.length ? "\n" : ""), "utf-8");
  const counts = Object.fromEntries(["live", "redirect", "dead", "unknown"].map((status) => [status, results.filter((result) => result.status === status).length]));
  await fs.writeFile(path.join(workspaceDir, reportPath), [
    "# Citation URL Verification",
    "",
    `Checked ${results.length} ${cited.size > 0 ? "cited" : "available"} source URL(s).`,
    `Live: ${counts.live} · redirects: ${counts.redirect} · dead: ${counts.dead} · unknown: ${counts.unknown}`,
    "",
    ...results.map((result) => `- [${result.status}] ${result.source_id}: ${result.url}${result.http_status ? ` (HTTP ${result.http_status})` : ""}${result.detail ? `: ${result.detail}` : ""}`),
    "",
  ].join("\n"), "utf-8");
  return { results, written: [outputPath, reportPath] };
}

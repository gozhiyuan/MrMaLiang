import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
export type PaperSourceKind = "arxiv" | "openreview" | "doi" | "local_pdf";
export type PaperSource = { kind: PaperSourceKind; locator: string; checksum: string; title?: string };
function kindFor(locator: string): PaperSourceKind {
  if (/^https?:\/\/(?:www\.)?arxiv\.org\//i.test(locator)) return "arxiv";
  if (/^https?:\/\/openreview\.net\//i.test(locator)) return "openreview";
  if (/^https?:\/\/(?:dx\.)?doi\.org\//i.test(locator) || /^10\.\d{4,9}\//i.test(locator)) return "doi";
  if (locator.toLowerCase().endsWith(".pdf")) return "local_pdf";
  throw new Error("paper source must be an arXiv, OpenReview, DOI, or local PDF reference");
}
export async function intakePaperSource(locator: string, title?: string): Promise<PaperSource> {
  const kind = kindFor(locator); const bytes = kind === "local_pdf" ? await fs.readFile(path.resolve(locator)) : Buffer.from(locator, "utf8");
  return { kind, locator, checksum: "sha256:" + crypto.createHash("sha256").update(bytes).digest("hex"), ...(title ? { title } : {}) };
}

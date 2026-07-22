import type { ClassifiedSource } from "./types.js";

function decodeHtmlEntities(value: string): string {
  return value
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&(apos|#39);/gi, "'");
}

/** Escape metadata for a BibTeX field after normalizing common HTML entity
 * leakage from scholarly provider APIs. A raw ampersand in a rendered .bbl
 * is an alignment token in TeX, so it must never reach the source bundle. */
export function escapeBibtex(value: string): string {
  return decodeHtmlEntities(value)
    .replace(/[{}]/g, "")
    .replace(/\\/g, "\\textbackslash{}")
    .replace(/([%&_#$])/g, "\\$1")
    .replace(/~/g, "\\textasciitilde{}")
    .replace(/\^/g, "\\textasciicircum{}");
}

export function bibtexKey(source: Pick<ClassifiedSource, "id" | "authors" | "year">): string {
  const author = source.authors[0]?.split(/\s+/).at(-1)?.toLowerCase().replace(/[^a-z0-9]/g, "") || "source";
  return `${author}${source.year}${source.id.replace(/[^a-z0-9]/gi, "").slice(0, 12)}`;
}

/** Serialized BibTeX keys are stable identifiers. Consumers must validate
 * them rather than display titles, which are normalized and TeX-escaped. */
export function bibtexKeys(bibliography: string): Set<string> {
  return new Set([...bibliography.matchAll(/@\w+\s*\{\s*([^,\s]+)\s*,/g)].map((match) => match[1]!));
}

export function writeBibtex(sources: ClassifiedSource[]): string {
  return sources.map((source) => {
    const fields = [
      `  title = {${escapeBibtex(source.title)}}`,
      `  author = {${source.authors.map(escapeBibtex).join(" and ")}}`,
      `  year = {${source.year}}`,
      `  venue = {${escapeBibtex(source.venue)}}`,
      `  url = {${escapeBibtex(source.url)}}`,
    ];
    return `@misc{${bibtexKey(source)},\n${fields.join(",\n")}\n}`;
  }).join("\n\n") + "\n";
}

import type { ClassifiedSource } from "./types.js";

function escapeBibtex(value: string): string {
  return value.replace(/[{}]/g, "");
}

export function bibtexKey(source: Pick<ClassifiedSource, "id" | "authors" | "year">): string {
  const author = source.authors[0]?.split(/\s+/).at(-1)?.toLowerCase().replace(/[^a-z0-9]/g, "") || "source";
  return `${author}${source.year}${source.id.replace(/[^a-z0-9]/gi, "").slice(0, 12)}`;
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

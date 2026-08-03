import type { ClassifiedSource } from "./types.js";

const TAXONOMY_STOP_WORDS = new Set(["and", "for", "from", "into", "the", "with"]);

export function normalizedTaxonomyTerms(value: string): string[] {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .split(/\s+/)
    .filter((term) => term.length > 1 && !TAXONOMY_STOP_WORDS.has(term));
}

/** Taxonomy cells are human-readable labels, not verbatim paper titles.
 * Requiring two meaningful terms retains an inspectable lexical gate while
 * avoiding the impossible requirement that a source repeat a whole label. */
export function sourceMatchesTaxonomy(source: ClassifiedSource, cell: string): boolean {
  const terms = normalizedTaxonomyTerms(cell);
  if (terms.length === 0) return false;
  // `topics` may include the query terms used to retrieve a record. Counting
  // them here would let every result from a broad search satisfy the same
  // taxonomy cell without evidence in its own title or abstract.
  const sourceTerms = new Set(normalizedTaxonomyTerms(`${source.title} ${source.abstract}`));
  const matched = terms.filter((term) => sourceTerms.has(term)).length;
  return matched >= Math.min(2, terms.length);
}

/**
 * A writing stage may cite a whole source (`[source:paper-a]`) or a precise
 * evidence chunk (`[source:paper-a:p12]`). The latter keeps paragraph-level
 * provenance in Markdown, but source catalogues and BibTeX are keyed by the
 * base source id. Keep the parsing rule in one place so those consumers do
 * not accidentally treat an evidence locator as an unknown source.
 */
const MARKER = /\[source:([^\]\s]+)\]/g;
const EVIDENCE_SUFFIX = /^(.*):(p\d+(?:-\d+)?)$/;

export type CitationMarker = {
  raw: string;
  sourceId: string;
  evidenceChunkId?: string;
};

export function parseCitationMarker(raw: string): CitationMarker {
  const locator = raw.match(EVIDENCE_SUFFIX);
  return locator
    ? { raw, sourceId: locator[1], evidenceChunkId: raw }
    : { raw, sourceId: raw };
}

export function citationMarkers(markdown: string): CitationMarker[] {
  return [...markdown.matchAll(MARKER)].map((match) => parseCitationMarker(match[1]));
}

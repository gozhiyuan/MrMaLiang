import type { CitationPlanEntry, ClassifiedSource } from "./types.js";

export function buildCitationPlan(sources: ClassifiedSource[]): CitationPlanEntry[] {
  const ranked = sources.filter((source) => source.citation_depth !== "D");
  const top = ranked.length > 0 ? ranked : sources;
  return [
    {
      section_id: "section-1",
      section_title: "Background and Motivation",
      source_ids: top.slice(0, 3).map((source) => source.id),
    },
    {
      section_id: "section-2",
      section_title: "Workflow Architecture and Evaluation",
      source_ids: top.slice(3, 6).map((source) => source.id),
    },
  ].filter((entry) => entry.source_ids.length > 0);
}

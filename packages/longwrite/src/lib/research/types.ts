export type CitationDepth = "A" | "B" | "C" | "D";

export type SourceProvider = "seed" | "arxiv" | "semantic_scholar" | "dblp" | "crossref" | "openalex" | "openreview";

export type SourceIdentity = {
  canonical_url?: string;
  doi?: string;
  arxiv_id?: string;
  arxiv_version?: string;
  semantic_scholar_id?: string;
  dblp_key?: string;
  openalex_id?: string;
  openreview_id?: string;
  publisher_url?: string;
  accepted_version_url?: string;
  venue?: string;
  publication_status?: string;
  citation_count?: number;
  citation_count_source?: string;
  confidence?: number;
  provenance?: Array<{ field: string; provider: string; value: string; confidence?: number }>;
};

export type RawSource = {
  id: string;
  title: string;
  authors: string[];
  year: number;
  venue: string;
  url: string;
  abstract: string;
  source: SourceProvider;
  topics: string[];
  identifiers?: {
    doi?: string;
    arxiv_id?: string;
    semantic_scholar_id?: string;
    dblp_key?: string;
    openalex_id?: string;
    openreview_id?: string;
  };
  metrics?: {
    citation_count?: number;
  };
  links?: {
    open_access_pdf?: string;
    canonical_url?: string;
    publisher_url?: string;
    accepted_version?: string;
  };
  identity?: SourceIdentity;
  merged_from?: string[];
  /** Retrieval provenance: how and when this record entered the corpus. */
  provenance?: {
    query: string;
    provider: string;
    retrieved_at: string;
  };
};

export type ScoredSource = RawSource & {
  quality_score: number;
  score_rationale: string;
};

export type ClassifiedSource = ScoredSource & {
  citation_depth: CitationDepth;
  citation_depth_rationale: string;
};

export type CitationPlanEntry = {
  section_id: string;
  section_title: string;
  source_ids: string[];
};

export type ResearchArtifacts = {
  raw: RawSource[];
  deduped: RawSource[];
  scored: ScoredSource[];
  classified: ClassifiedSource[];
  citationPlan: CitationPlanEntry[];
  bibliographyBibtex: string;
  reportMarkdown: string;
};

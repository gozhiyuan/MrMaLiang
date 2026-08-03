import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";

/**
 * MrMaLiang research workspace (plan section 14).
 *
 * These pages read one normalized projection from the extension server rather
 * than fetching raw evidence corpora, so the browser never parses a JSONL
 * source index and never re-derives a release gate the pipeline already
 * decided.
 */
export type ResearchProjection = {
  phase: string;
  evidence: { sources: number; coverage: Record<string, number>; depth: Record<string, number>; unresolved: string[] };
  manuscript: {
    chapters: Array<{ id: string; title?: string; words: number; targetWords?: number; sourceCount: number; state: "drafted" | "pending" | "unknown" }>;
    totalWords: number;
    draftTargetWords?: number;
    projectTargetWords?: number;
    pdf: { status: "compiled" | "not_built"; warningCount: number };
  };
  release: { gates: Array<{ id: string; status: "passed" | "failed" | "unknown"; detail?: string }>; ready: boolean };
  score: { review?: number; claimSupport?: number };
};

function useResearch() {
  // Keep the summary tabs on the same public MrMaLiang workspace selected on
  // the main tab. Without this query parameter the extension server receives
  // no directory at all and reports that no LongWrite workspace is available.
  const dir = localStorage.getItem("maliang-workspace-dir") ?? localStorage.getItem("longwrite-dir") ?? "";
  return useQuery<ResearchProjection>({
    queryKey: ["longwrite", "research", dir],
    queryFn: async () => {
      if (!dir) throw new Error("No MrMaLiang workspace is selected");
      const response = await fetch(`/api/longwrite/research?dir=${encodeURIComponent(dir)}`);
      if (!response.ok) throw new Error((await response.json().catch(() => ({ error: response.statusText }))).error ?? response.statusText);
      return response.json();
    },
    refetchInterval: 30_000,
  });
}

function Frame({ title, intro, children }: { title: string; intro: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="page-intro"><div><h1 className="page-title">{title}</h1><p>{intro}</p></div></div>
      {children}
    </div>
  );
}

function Guard({ query, children }: { query: ReturnType<typeof useResearch>; children: (data: ResearchProjection) => React.ReactNode }) {
  if (query.isLoading) return <div className="ui-skeleton" role="status" aria-busy="true"><span className="sr-only">Loading research state</span><span className="ui-skeleton-row" /><span className="ui-skeleton-row" /></div>;
  if (query.isError || !query.data) {
    return (
      <div className="ui-state ui-state-error" role="alert">
        <p className="ui-state-title">No MrMaLiang workspace is available</p>
        <p className="ui-state-hint">Open a workspace containing longwrite.yaml, or run <code className="ui-mono">maliang init</code>.</p>
      </div>
    );
  }
  return <>{children(query.data)}</>;
}

/** Status is conveyed by text, matching the core dashboard's badge contract. */
function GateBadge({ status }: { status: "passed" | "failed" | "unknown" }) {
  const tone = status === "passed" ? "success" : status === "failed" ? "danger" : "idle";
  return <span className={`ui-badge ui-badge-${tone}`}><span className="ui-badge-dot" aria-hidden="true" />{status}</span>;
}

export function ResearchOverview() {
  const research = useResearch();
  return (
    <Frame title="Research overview" intro="Paper phase, evidence health, manuscript progress, and release readiness in one projection.">
      <Guard query={research}>{(data) => (
        <>
          <section className="overview-section metric-row" aria-label="Research state">
            <article className="ui-metric-card"><h3>Phase</h3><p className="ui-metric-value">{data.phase}</p><p className="ui-metric-source">exact · reports/metrics.json</p></article>
            <article className="ui-metric-card"><h3>Sources</h3><p className="ui-metric-value">{data.evidence.sources}</p><p className="ui-metric-source">exact · reports/corpus-gates.json</p></article>
            <article className="ui-metric-card"><h3>Words</h3><p className="ui-metric-value">{data.manuscript.totalWords.toLocaleString()}{data.manuscript.projectTargetWords ? ` / ${data.manuscript.projectTargetWords.toLocaleString()}` : ""}</p><p className="ui-metric-source">exact · chapter files / longwrite.yaml</p></article>
            <article className="ui-metric-card"><h3>Review score</h3><p className="ui-metric-value">{data.score.review ?? "—"}</p><p className="ui-metric-source">exact · reports/metrics.json</p></article>
            <article className="ui-metric-card"><h3>Claim support</h3><p className="ui-metric-value">{data.score.claimSupport ?? "—"}</p><p className="ui-metric-source">exact · reports/metrics.json</p></article>
            <article className="ui-metric-card"><h3>Release</h3><p className="ui-metric-value">{data.release.ready ? "ready" : "blocked"}</p><p className="ui-metric-source">exact · reports/release-gates.json</p></article>
          </section>
          <section className="overview-section"><h2>Release gates</h2>
            <ul className="artifact-list">{data.release.gates.map((gate) => <li key={gate.id}><span className="ui-mono">{gate.id}</span> <GateBadge status={gate.status} /></li>)}</ul>
          </section>
        </>
      )}</Guard>
    </Frame>
  );
}

export function Evidence() {
  const research = useResearch();
  return (
    <Frame title="Evidence" intro="Corpus size, taxonomy coverage, citation-depth distribution, and unresolved evidence findings.">
      <Guard query={research}>{(data) => (
        <>
          <section className="overview-section"><h2>Citation depth</h2>
            {Object.keys(data.evidence.depth).length === 0
              ? <p className="ui-state-hint">No depth classification has been recorded yet.</p>
              : <ul className="artifact-list">{Object.entries(data.evidence.depth).map(([depth, count]) => <li key={depth}><span className="ui-mono">{depth}</span> <small>{count} source{count === 1 ? "" : "s"}</small></li>)}</ul>}
          </section>
          <section className="overview-section"><h2>Taxonomy coverage</h2>
            {Object.keys(data.evidence.coverage).length === 0
              ? <p className="ui-state-hint">No taxonomy-to-source mapping has been produced yet.</p>
              : <ul className="artifact-list">{Object.entries(data.evidence.coverage).map(([section, count]) => <li key={section}><span className="ui-mono">{section}</span> <small>{count} source{count === 1 ? "" : "s"}</small></li>)}</ul>}
          </section>
          <section className="overview-section"><h2>Unresolved findings</h2>
            {data.evidence.unresolved.length === 0
              ? <p className="ui-state-hint">No unresolved evidence findings.</p>
              : <ol className="event-list">{data.evidence.unresolved.map((finding, index) => <li key={index}>{finding}</li>)}</ol>}
          </section>
        </>
      )}</Guard>
    </Frame>
  );
}

export function Manuscript() {
  const research = useResearch();
  return (
    <Frame title="Current manuscript" intro="The live canonical draft: chapter files and the PDF are replaced as review-loop revisions are accepted. “Drafted” means a chapter exists; it is not a quality or release verdict.">
      <Guard query={research}>{(data) => (
        <>
          <section className="overview-section metric-row" aria-label="Manuscript progress">
            <article className="ui-metric-card"><h3>Current draft</h3><p className="ui-metric-value">{data.manuscript.totalWords.toLocaleString()} words</p><p className="ui-metric-source">exact · chapters/*.md</p></article>
            <article className="ui-metric-card"><h3>Planned draft</h3><p className="ui-metric-value">{data.manuscript.draftTargetWords?.toLocaleString() ?? "—"} words</p><p className="ui-metric-source">exact · outline.json</p></article>
            <article className="ui-metric-card"><h3>Project target</h3><p className="ui-metric-value">{data.manuscript.projectTargetWords?.toLocaleString() ?? "—"} words</p><p className="ui-metric-source">exact · longwrite.yaml</p></article>
            <article className="ui-metric-card"><h3>Rendered PDF</h3><p className="ui-metric-value">{data.manuscript.pdf.status === "compiled" ? "compiled" : "not built"}</p><p className="ui-metric-source">{data.manuscript.pdf.warningCount} LaTeX warning{data.manuscript.pdf.warningCount === 1 ? "" : "s"}</p></article>
          </section>
          <section className="overview-section">
            <h2>Current chapter version</h2>
            {data.manuscript.chapters.length === 0
              ? <p className="ui-state-hint">The outline has not been produced yet.</p>
              : (
                <div className="ui-table-scroll">
                  <table className="ui-table">
                    <caption className="sr-only">Chapters</caption>
                    <thead><tr><th scope="col">Chapter</th><th scope="col">Draft state</th><th scope="col">Words</th><th scope="col">Evidence</th></tr></thead>
                    <tbody>{data.manuscript.chapters.map((chapter) => {
                      const progress = chapter.targetWords ? Math.round((chapter.words / chapter.targetWords) * 100) : undefined;
                      return <tr key={chapter.id}>
                        <td><span className="ui-mono">{chapter.id}</span>{chapter.title && <><br /><small>{chapter.title}</small></>}</td>
                        <td><GateBadge status={chapter.state === "drafted" ? "passed" : "unknown"} /> <small>{chapter.state}</small></td>
                        <td>{chapter.words.toLocaleString()}{chapter.targetWords ? ` / ${chapter.targetWords.toLocaleString()} (${progress}%)` : ""}</td>
                        <td>{chapter.sourceCount} planned source{chapter.sourceCount === 1 ? "" : "s"}</td>
                      </tr>;
                    })}</tbody>
                  </table>
                </div>
              )}
            <p className="ui-state-hint">Open the compiled paper from <Link to="/artifacts">Artifacts</Link> → <span className="ui-mono">build/manuscript.pdf</span>. Compilation alone is not a release verdict.</p>
          </section>
        </>
      )}</Guard>
    </Frame>
  );
}

export function Release() {
  const research = useResearch();
  return (
    <Frame title="Release" intro="Every deterministic gate that stands between the current draft and a submission package.">
      <Guard query={research}>{(data) => (
        <section className="overview-section">
          <h2>{data.release.ready ? "Release gates pass" : "Release is blocked"}</h2>
          <p className="ui-state-hint">An absent report reads as unknown, never as passed.</p>
          <div className="ui-table-scroll">
            <table className="ui-table">
              <caption className="sr-only">Release gates</caption>
              <thead><tr><th scope="col">Gate</th><th scope="col">Status</th><th scope="col">Detail</th></tr></thead>
              <tbody>{data.release.gates.map((gate) => (
                <tr key={gate.id}><td className="ui-mono">{gate.id}</td><td><GateBadge status={gate.status} /></td><td>{gate.detail ?? "—"}</td></tr>
              ))}</tbody>
            </table>
          </div>
        </section>
      )}</Guard>
    </Frame>
  );
}

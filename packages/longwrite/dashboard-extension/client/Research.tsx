import { useQuery } from "@tanstack/react-query";

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
  manuscript: { chapters: Array<{ id: string; words: number; targetWords?: number; state: string }>; totalWords: number; targetWords?: number; pdfBuilt: boolean };
  release: { gates: Array<{ id: string; status: "passed" | "failed" | "unknown"; detail?: string }>; ready: boolean };
  score: { review?: number; claimSupport?: number };
};

function useResearch() {
  return useQuery<ResearchProjection>({
    queryKey: ["longwrite", "research"],
    queryFn: async () => {
      const response = await fetch("/api/longwrite/research");
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
            <article className="ui-metric-card"><h3>Sources</h3><p className="ui-metric-value">{data.evidence.sources}</p><p className="ui-metric-source">exact · evidence/coverage.json</p></article>
            <article className="ui-metric-card"><h3>Words</h3><p className="ui-metric-value">{data.manuscript.totalWords.toLocaleString()}{data.manuscript.targetWords ? ` / ${data.manuscript.targetWords.toLocaleString()}` : ""}</p><p className="ui-metric-source">exact · reports/structure-audit.json</p></article>
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
    <Frame title="Evidence" intro="Corpus size, section coverage, citation-depth distribution, and unresolved evidence findings.">
      <Guard query={research}>{(data) => (
        <>
          <section className="overview-section"><h2>Citation depth</h2>
            {Object.keys(data.evidence.depth).length === 0
              ? <p className="ui-state-hint">No depth classification has been recorded yet.</p>
              : <ul className="artifact-list">{Object.entries(data.evidence.depth).map(([depth, count]) => <li key={depth}><span className="ui-mono">{depth}</span> <small>{count} source{count === 1 ? "" : "s"}</small></li>)}</ul>}
          </section>
          <section className="overview-section"><h2>Section coverage</h2>
            {Object.keys(data.evidence.coverage).length === 0
              ? <p className="ui-state-hint">No section-to-source mapping has been produced yet.</p>
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
    <Frame title="Manuscript" intro="Outline state, per-chapter word counts against target, and build status.">
      <Guard query={research}>{(data) => (
        <section className="overview-section">
          <h2>Chapters</h2>
          {data.manuscript.chapters.length === 0
            ? <p className="ui-state-hint">No structure audit has been produced yet.</p>
            : (
              <div className="ui-table-scroll">
                <table className="ui-table">
                  <caption className="sr-only">Chapters</caption>
                  <thead><tr><th scope="col">Chapter</th><th scope="col">State</th><th scope="col">Words</th><th scope="col">Target</th></tr></thead>
                  <tbody>{data.manuscript.chapters.map((chapter) => (
                    <tr key={chapter.id}>
                      <td className="ui-mono">{chapter.id}</td>
                      <td><GateBadge status={chapter.state === "complete" ? "passed" : "unknown"} /></td>
                      <td>{chapter.words.toLocaleString()}</td>
                      <td>{chapter.targetWords?.toLocaleString() ?? "—"}</td>
                    </tr>
                  ))}</tbody>
                </table>
              </div>
            )}
          <p className="ui-state-hint">PDF: {data.manuscript.pdfBuilt ? "built" : "not built"}. A placeholder build is never release-ready.</p>
        </section>
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

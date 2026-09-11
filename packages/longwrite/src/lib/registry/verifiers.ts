import { createHash } from "node:crypto";
import { gateFamily, gateId, type GateId } from "./ids.js";

/** What a verifier reports.
 *
 * `unavailable` is not a soft failure. "The check could not run" and "the
 * check found a defect" send a round in different directions: one needs the
 * environment repaired, the other needs the artifact repaired. Collapsing them
 * would let a workspace where nothing could be measured look like one where
 * everything was measured and found wanting — or, worse, invent a pass. */
export type VerifierStatus = "passed" | "failed" | "unavailable";
export type VerifierResult = { status: VerifierStatus; diagnostic?: string };
export type VerifierFn = (ctx: { workspaceDir: string; scopeKey: string }) => Promise<VerifierResult>;

/** Bumped when a verifier's decision changes.
 *
 * The kernel records it beside every result, so a pass recorded by an older
 * verifier is never silently treated as interchangeable with a newer one. */
export const VERIFIER_VERSION = "2";

type ReportLike = {
  checks: Array<{
    id: string; pass: boolean; blocked?: boolean;
    findings?: Array<{ diagnostic?: string }>;
  }>;
};

/** A runner that says WHICH producer it asks.
 *
 * The tag is the identity the verifier digest is built from. Hashing the
 * runner's own source instead — which is what this did — hashed a closure whose
 * text is identical for every verifier and never changes when the validation
 * code it calls changes: a digest that stayed put across exactly the edits it
 * exists to notice. */
type Runner = ((workspaceDir: string) => Promise<ReportLike>) & { module: string };

function producer(module: string, run: (workspaceDir: string) => Promise<ReportLike>): Runner {
  return Object.assign(run, { module });
}

/** Which producers answer each verification, recorded as the verifiers are
 * declared so the two cannot drift. */
const VERIFIER_SOURCES = new Map<string, readonly string[]>();

/** Builds a verifier that runs a producer and reports ONE gate's verdict.
 *
 * It never re-decides the gate: it runs the code that owns it and reads the
 * answer. A second implementation of the same rule is a second thing to keep
 * in step, and the two would disagree exactly when it mattered. */
function fromProducer(gate: string, runners: Runner[]): VerifierFn {
  VERIFIER_SOURCES.set(gate, runners.map((runner) => runner.module).sort());
  return async ({ workspaceDir }) => {
    const verdicts: boolean[] = [];
    const diagnostics: string[] = [];
    let reached = false;
    for (const run of runners) {
      let report: ReportLike;
      try {
        report = await run(workspaceDir);
      } catch (error) {
        // Could not look. That is not a finding about the artifact.
        diagnostics.push(error instanceof Error ? error.message.split("\n")[0]! : String(error));
        continue;
      }
      const checks = report.checks.filter((check) => gateFamily(gateId(check.id)) === gate);
      if (checks.length === 0) continue;
      for (const check of checks) {
        // A gate that reports itself blocked did not run. Counting it as a
        // failure would answer a question nobody asked: the artifact was never
        // examined.
        if (check.blocked) {
          for (const finding of check.findings ?? []) {
            if (finding.diagnostic) diagnostics.push(finding.diagnostic);
          }
          continue;
        }
        reached = true;
        verdicts.push(check.pass);
        if (!check.pass) {
          for (const finding of check.findings ?? []) {
            if (finding.diagnostic) diagnostics.push(finding.diagnostic);
          }
        }
      }
    }
    if (!reached) {
      return { status: "unavailable",
        diagnostic: diagnostics.length > 0 ? diagnostics.slice(0, 4).join("; ")
          : `${gate} did not run in this workspace` };
    }
    return verdicts.every(Boolean)
      ? { status: "passed" }
      : { status: "failed", diagnostic: diagnostics.slice(0, 4).join("; ") || `${gate} reported findings` };
  };
}

const figures = () => import("../validation/figures.js");
const latex = () => import("../validation/latex.js");
const longform = () => import("../validation/longform.js");
const publication = () => import("../publication.js");
const research = () => import("../validation/research.js");

/** Every gate that can emit a finding with no acceptance metric.
 *
 * A null metric says the defect is real and no registered metric tracks it, so
 * its acceptance is a verification: the gate that found it has to run again and
 * come back clean. Without an entry here that criterion is unsatisfiable — the
 * action would be dispatched against a target nothing could ever confirm. */
export const VERIFIERS: Record<string, VerifierFn> = {
  bibliography_consistent: fromProducer("bibliography_consistent", [
    producer("research.validateResearchWorkspace", async (ws) => (await research()).validateResearchWorkspace(ws)),
  ]),
  chapter_contract_coverage: fromProducer("chapter_contract_coverage", [
    producer("longform.validateTechnicalBookWorkspace", async (ws) => (await longform()).validateTechnicalBookWorkspace(ws)),
  ]),
  code_validation: fromProducer("code_validation", [
    producer("longform.validateTechnicalBookWorkspace", async (ws) => (await longform()).validateTechnicalBookWorkspace(ws)),
  ]),
  codebase_evidence: fromProducer("codebase_evidence", [
    producer("research.validateResearchWorkspace", async (ws) => (await research()).validateResearchWorkspace(ws)),
  ]),
  citation_evidence_ledger: fromProducer("citation_evidence_ledger", [
    producer("research.validateResearchWorkspace", async (ws) => (await research()).validateResearchWorkspace(ws)),
  ]),
  citation_markers_present: fromProducer("citation_markers_present", [
    producer("research.validateResearchWorkspace", async (ws) => (await research()).validateResearchWorkspace(ws)),
  ]),
  citation_plan_consistent: fromProducer("citation_plan_consistent", [
    producer("research.validateResearchWorkspace", async (ws) => (await research()).validateResearchWorkspace(ws)),
  ]),
  citation_url_liveness: fromProducer("citation_url_liveness", [
    producer("research.validateResearchWorkspace", async (ws) => (await research()).validateResearchWorkspace(ws)),
  ]),
  figure_references: fromProducer("figure_references", [
    producer("figures.validateFigureWorkspace", async (ws) => (await figures()).validateFigureWorkspace(ws)),
  ]),
  full_research_contracts: fromProducer("full_research_contracts", [
    producer("research.validateResearchWorkspace", async (ws) => (await research()).validateResearchWorkspace(ws)),
  ]),
  full_source_identity: fromProducer("full_source_identity", [
    producer("research.validateResearchWorkspace", async (ws) => (await research()).validateResearchWorkspace(ws)),
  ]),
  latex_sources: fromProducer("latex_sources", [
    producer("latex.validateLatexWorkspace", async (ws) => (await latex()).validateLatexWorkspace(ws)),
  ]),
  publication_article_layout: fromProducer("publication_article_layout", [
    producer("publication.validatePublicationWorkspace", async (ws) => (await publication()).validatePublicationWorkspace(ws)),
  ]),
  publication_custom_template: fromProducer("publication_custom_template", [
    producer("publication.validatePublicationWorkspace", async (ws) => (await publication()).validatePublicationWorkspace(ws)),
  ]),
  publication_layout: fromProducer("publication_layout", [
    producer("figures.validateFigureWorkspace", async (ws) => (await figures()).validateFigureWorkspace(ws)),
  ]),
  publication_min_pages: fromProducer("publication_min_pages", [
    producer("publication.validatePublicationWorkspace", async (ws) => (await publication()).validatePublicationWorkspace(ws)),
  ]),
  publication_page_limit: fromProducer("publication_page_limit", [
    producer("publication.validatePublicationWorkspace", async (ws) => (await publication()).validatePublicationWorkspace(ws)),
  ]),
  publication_release_gates: fromProducer("publication_release_gates", [
    producer("publication.validatePublicationWorkspace", async (ws) => (await publication()).validatePublicationWorkspace(ws)),
  ]),
  reader_facing_publication: fromProducer("reader_facing_publication", [
    producer("latex.validateLatexWorkspace", async (ws) => (await latex()).validateLatexWorkspace(ws)),
  ]),
  // Two producers emit this gate: the longform novel path and the research
  // path. Both are asked, and the verdict is the conjunction — a length
  // contract satisfied in one surface and broken in the other is not met.
  target_length: fromProducer("target_length", [
    producer("longform.validateNovelWorkspace", async (ws) => (await longform()).validateNovelWorkspace(ws)),
    producer("research.validateResearchWorkspace", async (ws) => (await research()).validateResearchWorkspace(ws)),
  ]),
};

/** The kernel asks for a verification by gate id. `verification_id` IS the
 * gate id: the thing being re-verified is precisely the gate that emitted the
 * finding, and any other naming would need a second mapping to drift from. */
export async function runVerification(
  verificationId: string, ctx: { workspaceDir: string; scopeKey: string },
): Promise<VerifierResult> {
  const verifier = VERIFIERS[verificationId];
  if (!verifier) {
    return { status: "unavailable", diagnostic: `no verifier is registered for ${verificationId}` };
  }
  try {
    return await verifier(ctx);
  } catch (error) {
    return { status: "unavailable",
      diagnostic: error instanceof Error ? error.message.split("\n")[0] : String(error) };
  }
}

export function verifierIds(): GateId[] {
  return Object.keys(VERIFIERS).sort().map((id) => gateId(id));
}

/** Identifies the code that answers a verification.
 *
 * The kernel stores it beside every result and uses it as a FILTER: a pass
 * recorded by verifier code that has since changed says nothing about the check
 * as it exists now. So the digest has to move when the checking code moves.
 *
 * It covers two things and deliberately not a third. The PRODUCERS this
 * verification asks are its real inputs — rewire one and the check is answering
 * a different question. `VERIFIER_VERSION` is the registry's build identity,
 * bumped when a verifier's decision changes for any reason this file cannot
 * see: the validation logic inside those producers is ordinary imported code,
 * and no digest computable here moves when it does. The third thing — the
 * runner closure's own source text — is excluded because it is identical for
 * every verifier and constant across exactly the edits that matter, so
 * including it made the digest look derived from the code while being
 * effectively a constant per id.
 *
 * An unregistered id still gets a stable digest: the `unavailable` verdict it
 * produces is itself an answer worth not confusing with a later real one. */
export function verifierDigest(verificationId: string): string {
  const sources = VERIFIER_SOURCES.get(verificationId) ?? ["(unregistered)"];
  return createHash("sha256")
    .update(`v${VERIFIER_VERSION}\n${verificationId}\n${sources.join(",")}`)
    .digest("hex");
}

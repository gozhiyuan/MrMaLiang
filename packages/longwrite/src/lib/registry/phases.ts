import { capabilityIds, CAPABILITY_TEMPLATES } from "./capabilities.js";

/** Where each capability is dispatched from, in one place.
 *
 * Four lists used to have to agree by hand: the plan splitter's phase groups,
 * each dispatcher's `allowed_actions` and `max_actions`, and the tool catalog.
 * A capability present in three of them and missing from the fourth was
 * invisible — the planner could select it, validation accepted it, the splitter
 * wrote it into no file, and the dispatcher had nothing to run. Nothing errored
 * anywhere; the recovery loop simply diagnosed the same objective every round.
 *
 * Everything downstream is DERIVED from this table, so the four lists cannot
 * disagree: there is only one of them now. */
export type PhaseId = "research" | "outline" | "revision";

export type PhaseRoute = {
  phase: PhaseId;
  /** The file the splitter writes and the dispatcher reads. One name, used by
   * both — the previous arrangement had the splitter choose a filename and the
   * dispatcher choose one independently. */
  planPath: string;
  dispatchId: string;
  /** Where the dispatcher writes its execution report. Named here rather than
   * derived from the phase id because downstream stages and the dashboard read
   * these paths, and renaming one silently detaches its reader. */
  reportPath: string;
  title: string;
  /** Shown as the phase heading wherever a run is presented to a human. */
  label: string;
};

const PHASES: Record<PhaseId, PhaseRoute> = {
  // Corpus-side repairs run FIRST: a bibliography or a source record that is
  // wrong is wrong for every citation the later phases write, and repairing
  // prose against a broken record repairs the wrong artifact.
  research: {
    phase: "research",
    planPath: "reviews/research-action-plan.json",
    dispatchId: "research_action_dispatch",
    reportPath: "reports/action-dispatch-research.json",
    title: "Execute evidence-expansion and corpus repairs before revision",
    label: "Evidence and corpus",
  },
  outline: {
    phase: "outline",
    planPath: "reviews/outline-action-plan.json",
    dispatchId: "outline_action_dispatch",
    reportPath: "reports/action-dispatch-outline.json",
    title: "Execute structural outline-reopen actions after evidence refresh",
    label: "Structure",
  },
  revision: {
    phase: "revision",
    planPath: "reviews/revision-action-plan.json",
    dispatchId: "action_dispatch",
    // The unsuffixed name, because it predates the phase split and several
    // stages plus the dashboard already read it.
    reportPath: "reports/action-dispatch.json",
    title: "Execute prose and visual repair actions from refreshed evidence",
    label: "Prose and visuals",
  },
};

/** Exactly one phase per capability. A capability in two phases would have its
 * actions written to two plan files and dispatched twice; one in none is
 * dropped silently, which is the failure this table exists to make impossible. */
const CAPABILITY_PHASE: Record<string, PhaseId> = {
  targeted_research_expansion: "research",
  repair_source_metadata: "research",
  repair_bibliography: "research",
  repair_citation_plan: "research",
  reopen_outline: "outline",
  revise_sections: "revision",
  revise_visual_plan: "revision",
  request_operator_clarification: "revision",
};

/** Checked at module load, so adding a capability without routing it fails
 * where it is added rather than in whichever run first selects it. */
for (const id of capabilityIds().map(String)) {
  if (CAPABILITY_PHASE[id] === undefined) {
    throw new Error(
      `capability ${id} belongs to no dispatch phase; add it to CAPABILITY_PHASE in ` +
      `registry/phases.ts so the splitter writes its actions somewhere a dispatcher reads`);
  }
}
for (const id of Object.keys(CAPABILITY_PHASE)) {
  if (!CAPABILITY_TEMPLATES.has(id)) {
    throw new Error(`registry/phases.ts routes ${id}, which has no capability template`);
  }
}

export function phaseOf(capability: string): PhaseRoute {
  const phase = CAPABILITY_PHASE[capability];
  if (phase === undefined) throw new Error(`capability ${capability} belongs to no dispatch phase`);
  return PHASES[phase];
}

export function phaseRoutes(): PhaseRoute[] {
  return (Object.keys(PHASES) as PhaseId[]).map((id) => PHASES[id]);
}

/** The capabilities one phase dispatches, in registry order. Used for the
 * splitter's grouping, the dispatcher's allowlist and its action ceiling — all
 * three from the same source, so a capability cannot be permitted by one and
 * refused by another. */
export function capabilitiesOfPhase(phase: PhaseId): string[] {
  return capabilityIds().map(String).filter((id) => CAPABILITY_PHASE[id] === phase);
}

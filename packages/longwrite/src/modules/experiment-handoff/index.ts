/**
 * Experiment handoff module (MM-1.5).
 *
 * A THIN consumer of the audited experiment bundle produced by LongExperiment.
 *
 * ## Deliberately not owned here
 *
 * The manifest schemas stay in `@mr-maliang/research-protocol`. Duplicating
 * them in LongWrite would create two definitions of the empirical contract
 * that could drift — and the whole point of the handoff is that the writing
 * side consumes only what the experiment side certified. This module imports
 * and validates; it never redefines.
 *
 * ## Status
 *
 * Facade over `src/lib/research/experiment.ts`.
 */

export type { LongExperimentManifest } from "../../lib/research/experiment.js";
export {
  importLongExperiment,
  prepareExperimentEvidence,
  validateImportedExperiment,
} from "../../lib/research/experiment.js";

export const EXPERIMENT_HANDOFF_SUBCOMMANDS = {
  prepare: ["research", "prepare-experiment"],
} as const satisfies Record<string, readonly string[]>;

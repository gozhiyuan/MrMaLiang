import { ARTIFACT_EVALUATORS } from "./artifacts.js";
import { CORPUS_EVALUATORS, type EvaluatorFn } from "./corpus.js";
import { MANUSCRIPT_EVALUATORS } from "./manuscript.js";

/** Bumped when any evaluator's arithmetic changes. It enters the evaluator
 * digest, so a measurement taken by older code is not silently treated as
 * interchangeable with one taken by newer code. */
export const EVALUATOR_VERSION = "1";

/** Every deterministic evaluator, keyed by the metric it measures.
 *
 * tests/registry-evaluator-coverage.test.ts holds this in exact
 * correspondence with the script metrics in the registry — no script metric
 * without an evaluator, no evaluator without a registered metric, and nothing
 * here for a metric whose value comes from a model or an external toolchain. */
export const SCRIPT_EVALUATORS: Record<string, EvaluatorFn> = {
  ...CORPUS_EVALUATORS,
  ...MANUSCRIPT_EVALUATORS,
  ...ARTIFACT_EVALUATORS,
};

export type { EvaluatorContext, EvaluatorFn, ScopedValue } from "./corpus.js";
export { MeasurementUnavailable } from "./corpus.js";

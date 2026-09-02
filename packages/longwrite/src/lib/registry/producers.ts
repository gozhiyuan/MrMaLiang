import { registerProducers } from "./routing.js";
import { PRODUCER as research } from "../validation/research.js";
import { PRODUCER as figures } from "../validation/figures.js";
import { PRODUCER as latex } from "../validation/latex.js";
import { PRODUCER as longform } from "../validation/longform.js";
import { PRODUCER as corpusGates } from "../research/corpus-gates.js";
import { PRODUCER as surveyContract } from "../research/survey-contract.js";
import { PRODUCER as visualReview } from "../ops/visual-review.js";
import { PRODUCER as publication } from "../publication.js";
import { PRODUCER as preflight } from "../../commands/preflight.js";

/** The authoritative inventory. A module that emits a gate without declaring it
 * on its own PRODUCER fails tests/routing-coverage.test.ts — declaration beside
 * the code is the only mechanism a dynamically built gate id cannot defeat. */
export const PRODUCERS = [
  research, figures, latex, longform, corpusGates,
  surveyContract, visualReview, publication, preflight,
];

export const REGISTRY = registerProducers(PRODUCERS);

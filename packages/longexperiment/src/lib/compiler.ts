/**
 * Stable LongExperiment compiler API.
 *
 * Workflow composition is intentionally kept outside `lib/`: domain fragments
 * can be extracted without changing callers or the compiled MalaClaw IR.
 */
export { compileExperimentToManifest, manifestYaml } from "../workflow/composition.js";

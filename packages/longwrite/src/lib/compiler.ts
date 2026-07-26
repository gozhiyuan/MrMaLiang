/**
 * LongWrite's stable compiler API.
 *
 * The composition implementation lives under `workflow/` so domain workflow
 * fragments can evolve behind this deliberately small compatibility boundary.
 * Keep consumers importing this module; generated MalaClaw YAML remains the
 * public execution contract.
 */
export {
  compileModeToManifest,
  manifestToYaml,
  type CompileOptions,
  type CompileResearchPolicy,
  type CompileRunLimits,
  type CompileStageOverride,
} from "../workflow/composition.js";

/**
 * Manuscript LaTeX module (MM-1.4).
 *
 * Owns the LaTeX workspace, engine detection, compilation, and the LaTeX
 * gates.
 *
 * ## Non-negotiable this module preserves
 *
 *  - **A placeholder PDF is explicitly NOT release-ready.** When LaTeX is
 *    unavailable the build may still emit something inspectable, but it must
 *    never satisfy a release gate — shipping a placeholder as a finished paper
 *    is the failure this rule exists to prevent.
 *
 * ## Status
 *
 * Facade over `src/lib/writing/` and `src/lib/validation/`.
 */

export type { LatexEngine, LatexCompileResult } from "../../lib/writing/latex-compile.js";
export { buildLatexWorkspace } from "../../lib/writing/latex.js";
export {
  detectLatexEngine,
  extractLatexFindings,
  compileLatex,
  writeLatexBuildReport,
} from "../../lib/writing/latex-compile.js";
export { validateLatexWorkspace } from "../../lib/validation/latex.js";

export const LATEX_SUBCOMMANDS = {
  build: ["build", "research"],
} as const satisfies Record<string, readonly string[]>;

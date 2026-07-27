/**
 * Manuscript figures module (MM-1.4).
 *
 * Owns figure planning, placement, rendering backends, and the figure gates.
 *
 * ## Non-negotiables this module preserves
 *
 *  - **Placement sanitization stays fail-closed.** A placement plan that
 *    cannot be sanitized is rejected, never silently coerced — a figure
 *    landing in the wrong section is a correctness bug in a paper.
 *  - **The visual-review render hash stays bound to the inspected pages.** A
 *    review is only valid for the exact render it looked at; rebinding it to a
 *    later render would launder an unreviewed figure through an old approval.
 *
 * ## Status
 *
 * Facade over `src/lib/writing/` and `src/lib/validation/`.
 */

export type { FigureBackendId, BackendStatus, FigureBackendResult } from "../../lib/writing/figure-backends.js";
export type { FigureManifest } from "../../lib/writing/figures.js";
export {
  figureManifestSchema,
  readFigureManifest,
  sanitizePlacementPlanFile,
  buildFigureWorkspace,
} from "../../lib/writing/figures.js";
export {
  mermaidBin,
  pythonBin,
  detectMermaid,
  renderMermaidFile,
  cropPdfFile,
  detectPython,
  researchPipelineMermaid,
  sourceYearsPlotScript,
  renderFigureBackends,
} from "../../lib/writing/figure-backends.js";
export { validateFigureWorkspace } from "../../lib/validation/figures.js";

export const FIGURE_SUBCOMMANDS = {
  visualReview: ["build", "visual-review"],
} as const satisfies Record<string, readonly string[]>;

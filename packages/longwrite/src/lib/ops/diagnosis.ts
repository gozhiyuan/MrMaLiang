import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { RequiredEffectSchema } from "../registry/ids.js";
import { REGISTRY } from "../registry/producers.js";

/** What diagnosis may conclude.
 *
 * A closed vocabulary, because the kernel dispatches on the decision: "try
 * harder" names no next move, and a free-text verdict would be a pause an
 * operator cannot act on. */
export const DIAGNOSIS_DECISIONS = [
  "retry_with_different_effect",
  "escalate_capability",
  "operator_required",
  "target_infeasible",
] as const;

export const Diagnosis = z.object({
  version: z.literal(1),
  /** The objective that could not be met. */
  objective: z.string().min(1),
  decision: z.enum(DIAGNOSIS_DECISIONS),
  detail: z.string().min(1).max(8_000),
  next_effect: RequiredEffectSchema.optional(),
  next_capability: z.string().min(1).optional(),
  operator_question: z.string().min(1).max(2_000).optional(),
})
  // Strict is the mechanism, not decoration: it is what rejects a smuggled
  // `new_target`. Diagnosis chooses a STRATEGY; a diagnosis that could lower
  // the target would let an unmet objective be met by redefining it.
  .strict()
  .superRefine((diagnosis, ctx) => {
    if (diagnosis.decision === "retry_with_different_effect" && !diagnosis.next_effect) {
      ctx.addIssue({ code: "custom", path: ["next_effect"],
        message: "retry_with_different_effect must name the next_effect to try" });
    }
    if (diagnosis.decision === "escalate_capability") {
      if (!diagnosis.next_capability) {
        ctx.addIssue({ code: "custom", path: ["next_capability"],
          message: "escalate_capability must name the next_capability" });
      } else if (![...REGISTRY.capabilities()].map(String).includes(diagnosis.next_capability)) {
        // A capability nothing owns is not a strategy; it is a typo that would
        // dispatch nothing at all.
        ctx.addIssue({ code: "custom", path: ["next_capability"],
          message: `${diagnosis.next_capability} is not a registered capability` });
      }
    }
    if (diagnosis.decision === "operator_required" && !diagnosis.operator_question) {
      ctx.addIssue({ code: "custom", path: ["operator_question"],
        message: "operator_required must carry the operator_question to ask" });
    }
  });
export type Diagnosis = z.infer<typeof Diagnosis>;

export const DIAGNOSIS_PATH = path.join("reviews", "diagnosis.json");

export async function validateDiagnosis(workspaceDir: string): Promise<Diagnosis> {
  const file = path.join(workspaceDir, DIAGNOSIS_PATH);
  const raw = await fs.readFile(file, "utf-8");
  const parsed = Diagnosis.safeParse(JSON.parse(raw));
  if (!parsed.success) {
    throw new Error(
      `${DIAGNOSIS_PATH}: invalid diagnosis; ` +
      parsed.error.issues.map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`).join("; "));
  }
  return parsed.data;
}

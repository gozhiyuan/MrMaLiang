import { z } from "zod";

/** A LongWrite writing mode: the domain layer over a MalaClaw workflow.
 *  The `workflow` block is deliberately opaque. MalaClaw owns that schema
 *  and `malaclaw validate` is the gate. LongWrite validates only the domain
 *  fields it owns, strictly. */
export const LongWriteModeDef = z
  .object({
    id: z.string().regex(/^[a-z0-9][a-z0-9_-]*$/),
    version: z.number().default(1),
    name: z.string(),
    description: z.string().optional(),
    // Internal modes may be inheritance bases or backwards-compatible aliases.
    // They remain loadable by existing workspaces but are omitted from mode
    // discovery so new projects have one supported public workflow.
    internal: z.boolean().default(false),
    artifact_type: z.string(),
    default_runtime: z
      .object({
        executor: z.string().default("malaclaw"),
        agent_runtime: z.enum(["openclaw", "claude-code", "codex", "clawteam"]).default("codex"),
      })
      .strict()
      .default({}),
    default_agents: z.array(z.string()).default([]),
    pack: z.string().default("manuscript-writing"),
    entry_team: z.string().default("manuscript-writing"),
    artifacts: z
      .object({
        required: z.array(z.string()).default([]),
        optional: z.array(z.string()).default([]),
      })
      .strict()
      .default({}),
    // A mode may inherit another mode's workflow instead of duplicating it.
    // Derived modes can share a workflow while changing their domain defaults.
    extends: z.string().optional(),
    default_workflow_profile: z.enum(["fast", "standard", "deep"]).optional(),
    // Optional when `extends` supplies the workflow; required otherwise
    // (enforced in loadMode after inheritance resolves).
    workflow: z.object({ stages: z.array(z.unknown()).min(1) }).passthrough().optional(),
  })
  .strict();

export type LongWriteModeDef = z.infer<typeof LongWriteModeDef>;

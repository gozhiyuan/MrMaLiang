import { z } from "zod";

const RoleId = z.string().regex(/^[a-z][a-z0-9_-]*$/);
export const ResearchTeamRole = z.object({
  id: RoleId,
  responsibility: z.string().min(8),
  max_instances: z.number().int().min(1).max(4),
  allowed_actions: z.array(z.string().min(1)).min(1).max(12),
}).strict();
export type ResearchTeamRole = z.infer<typeof ResearchTeamRole>;

/** LLMs may recommend a roster, but it must fit a finite declared envelope. */
export const ResearchTeamRoster = z.object({
  version: z.literal(1),
  objective: z.string().min(12),
  roles: z.array(ResearchTeamRole).min(2).max(6),
  rationale: z.string().min(20),
}).strict().superRefine((roster, ctx) => {
  const ids = new Set<string>();
  roster.roles.forEach((role, index) => {
    if (ids.has(role.id)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["roles", index, "id"], message: `duplicate role ${role.id}` });
    ids.add(role.id);
  });
  if (!ids.has("critic")) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["roles"], message: "every research roster needs an independent critic" });
});
export type ResearchTeamRoster = z.infer<typeof ResearchTeamRoster>;

export function validateTeamRoster(input: unknown, allowedActions: Iterable<string>, maxPeople = 8): ResearchTeamRoster {
  const roster = ResearchTeamRoster.parse(input);
  const allowed = new Set(allowedActions);
  const requested = roster.roles.reduce((sum, role) => sum + role.max_instances, 0);
  if (requested > maxPeople) throw new Error(`team requests ${requested} workers but the configured cap is ${maxPeople}`);
  for (const role of roster.roles) for (const action of role.allowed_actions) {
    if (!allowed.has(action)) throw new Error(`role ${role.id} requests undeclared action ${action}`);
  }
  return roster;
}

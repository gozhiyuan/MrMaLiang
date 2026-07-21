export const RESERVED_INIT_FLAGS = ["--mode", "--research-paper-kind", "--research-paper-profile", "--topic", "--repository", "--reference-link", "--experiment-authoring", "--id", "--name"] as const;

export type PassthroughOption = { arity: "boolean" | "single" | "variadic"; repeatable: boolean };

// Keep synchronized with operator-documented customization flags (Task 8 lint).
export const INIT_PASSTHROUGH_OPTIONS: Record<string, PassthroughOption> = {
  "--author": { arity: "variadic", repeatable: false },
  "--email": { arity: "variadic", repeatable: false },
  "--audience": { arity: "single", repeatable: false },
  "--style": { arity: "single", repeatable: false },
  "--genre": { arity: "single", repeatable: false },
  "--language": { arity: "single", repeatable: false },
  "--taxonomy": { arity: "variadic", repeatable: false },
  "--target-length-words": { arity: "single", repeatable: false },
  "--citation-style": { arity: "single", repeatable: false },
  "--output-format": { arity: "variadic", repeatable: false },
  "--research-provider": { arity: "single", repeatable: false },
  "--research-workflow-profile": { arity: "single", repeatable: false },
  "--research-target-candidates": { arity: "single", repeatable: false },
  "--research-query-budget": { arity: "single", repeatable: false },
  "--research-writing-strategy": { arity: "single", repeatable: false },
  "--review-cadence": { arity: "single", repeatable: false },
  "--review-time": { arity: "single", repeatable: false },
  "--review-interval-hours": { arity: "single", repeatable: false },
  "--batch-approvals": { arity: "boolean", repeatable: false },
  "--runtime-profile": { arity: "single", repeatable: false },
  "--max-unit-minutes": { arity: "single", repeatable: false },
  "--max-active-run-minutes": { arity: "single", repeatable: false },
  "--max-recorded-tokens": { arity: "single", repeatable: false },
  "--reference-file": { arity: "variadic", repeatable: false },
  "--reference-instructions": { arity: "single", repeatable: false },
  "--submission-target": { arity: "single", repeatable: false },
  "--anonymous": { arity: "boolean", repeatable: false },
  "--page-limit": { arity: "single", repeatable: false },
  "--required-section": { arity: "variadic", repeatable: false },
  "--submission-template-dir": { arity: "single", repeatable: false },
  "--document-class": { arity: "single", repeatable: false },
  "--document-class-option": { arity: "variadic", repeatable: false },
};

export function validateInitPassthrough(afterDashDash: readonly string[], ctx: { hasWriting: boolean }): { ok: true; args: string[] } | { ok: false; message: string } {
  if (afterDashDash.length === 0) return { ok: true, args: [] };
  if (!ctx.hasWriting) return { ok: false, message: `This is an experiment-only template with no writing component; LongWrite customization after -- is not accepted.` };

  const args: string[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < afterDashDash.length; i++) {
    const token = afterDashDash[i];
    if ((RESERVED_INIT_FLAGS as readonly string[]).includes(token)) {
      return { ok: false, message: `${token} is reserved to the maliang template/native options; set it via 'maliang init' options or choose another template, not after --.` };
    }
    const spec = INIT_PASSTHROUGH_OPTIONS[token];
    if (!spec) return { ok: false, message: `Unknown init passthrough option ${token}. Allowed: ${Object.keys(INIT_PASSTHROUGH_OPTIONS).join(", ")}` };
    if (seen.has(token) && !spec.repeatable) return { ok: false, message: `${token} may be supplied only once after --` };
    seen.add(token);
    args.push(token);
    if (spec.arity === "boolean") continue;
    // Consume value(s): single takes one; variadic takes until the next option.
    if (spec.arity === "single") {
      if (afterDashDash[i + 1] === undefined || afterDashDash[i + 1].startsWith("--")) return { ok: false, message: `${token} requires a value` };
      args.push(afterDashDash[++i]);
    } else {
      if (afterDashDash[i + 1] === undefined || afterDashDash[i + 1].startsWith("--")) return { ok: false, message: `${token} requires at least one value` };
      while (afterDashDash[i + 1] !== undefined && !afterDashDash[i + 1].startsWith("--")) args.push(afterDashDash[++i]);
    }
  }
  return { ok: true, args };
}

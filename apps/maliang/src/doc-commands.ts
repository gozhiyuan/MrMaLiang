export type DocumentCommand = {
  kind: "maliang" | "malaclaw" | "internal" | "component" | "other";
  tokens: string[];
};

/** Extract command starts from shell fences. Continuation lines are joined so
 * a multi-line `maliang init` is checked as one invocation. */
export function extractShellCommands(markdown: string): string[] {
  const commands: string[] = [];
  let inFence = false;
  let pending = "";
  for (const raw of markdown.split("\n")) {
    const line = raw.trim();
    if (/^```(?:bash|sh|shell|console)\s*$/.test(line)) { inFence = true; continue; }
    if (inFence && line.startsWith("```")) {
      if (pending) commands.push(pending.trim());
      pending = "";
      inFence = false;
      continue;
    }
    if (!inFence || !line || line.startsWith("#")) continue;
    const normalized = line.replace(/^\$\s+/, "");
    pending += `${pending ? " " : ""}${normalized.replace(/\\$/, "").trim()}`;
    if (!normalized.endsWith("\\")) {
      commands.push(pending.trim());
      pending = "";
    }
  }
  return commands;
}

export function classifyCommand(line: string): DocumentCommand {
  if (line.includes("dist/cli.js")) return { kind: "internal", tokens: [] };
  const tokens = line.split(/\s+/).filter(Boolean);
  if (tokens[0] === "malaclaw") return { kind: "malaclaw", tokens };
  if (tokens[0] === "maliang") return { kind: "maliang", tokens };
  if (tokens[0] === "longwrite" || tokens[0] === "longexperiment") return { kind: "component", tokens };
  return { kind: "other", tokens };
}

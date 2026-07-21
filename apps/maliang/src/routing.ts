export type Component = "writing" | "experiment";

export type VerbContract = {
  commandPath: readonly string[];
  components: readonly Component[];
  defaultComponent: Component;
  /** Index of the workspace among positionals after commandPath, or null for inspection commands. */
  workspacePosition: number | null;
  operatorVisible: true;
};

const writingOnly: readonly Component[] = ["writing"];

/** Workspace-bound writing command with the workspace as the first positional. */
function w(commandPath: readonly string[]): VerbContract {
  return { commandPath, components: writingOnly, defaultComponent: "writing", workspacePosition: 0, operatorVisible: true };
}
/** Workspace-bound command implemented by both components. */
function shared(commandPath: readonly string[]): VerbContract {
  return { commandPath, components: ["writing", "experiment"], defaultComponent: "writing", workspacePosition: 0, operatorVisible: true };
}
/** Workspace-bound command implemented only by the experiment component. */
function x(commandPath: readonly string[]): VerbContract {
  return { commandPath, components: ["experiment"], defaultComponent: "experiment", workspacePosition: 0, operatorVisible: true };
}
/** Inspection command with no workspace positional. */
function inspect(commandPath: string[], components: readonly Component[] = writingOnly): VerbContract {
  return { commandPath, components, defaultComponent: components[0], workspacePosition: null, operatorVisible: true };
}

// NOTE: this is the public operator surface. Completeness is enforced by the
// docs command-lint test in Task 7 (every documented proxied command MUST map
// to an entry here). Add entries as docs are migrated.
export const ROUTING_REGISTRY: readonly VerbContract[] = [
  shared(["sync"]),
  x(["validate"]),
  w(["validate", "config"]),
  w(["validate", "research"]),
  w(["validate", "figures"]),
  w(["validate", "latex"]),
  w(["validate", "search-plan"]),
  w(["validate", "scorecard"]),
  w(["outline", "revise"]),
  w(["research", "prepare"]),
  w(["research", "assess"]),
  w(["research", "prepare-experiment"]),
  w(["research", "import-experiment"]),
  w(["research", "refresh"]),
  w(["research", "recall"]),
  w(["research", "enrich"]),
  w(["research", "fulltext"]),
  w(["research", "snowball"]),
  w(["research", "corpus-gates"]),
  w(["research", "reconcile-identities"]),
  w(["research", "verify"]),
  w(["research", "survey-contract"]),
  w(["research", "codebases"]),
  w(["research", "github-codebase-recall"]),
  w(["research", "repair-github-codebase-selection"]),
  w(["evidence", "index"]),
  w(["evidence", "search"]),
  w(["evidence", "consolidate"]),
  w(["evidence", "allocate"]),
  w(["review", "agenda"]),
  w(["review", "score"]),
  w(["review", "route"]),
  w(["review", "claims"]),
  w(["report", "packet"]),
  w(["report", "schedule"]),
  w(["report", "daily"]),
  w(["publication", "validate"]),
  w(["publication", "package"]),
  w(["workspace", "prune"]),
  w(["workspace", "archive"]),
  w(["workspace", "keep"]),
  w(["metrics", "words"]),
  w(["feedback", "add"]),
  w(["approve"]),
  w(["retry"]),
  w(["env", "init"]),
  w(["build", "research"]),
  w(["build", "figures"]),
  w(["build", "latex"]),
  w(["supervise"]),
  w(["status"]),
  w(["runtimes"]),
  inspect(["mode", "list"]),
  inspect(["mode", "show"]),
  inspect(["runtime-profile", "list"]),
  inspect(["runtime-profile", "show"]),
  inspect(["dashboard"]),
];

export function findContract(tokens: readonly string[]): VerbContract | null {
  let best: VerbContract | null = null;
  for (const contract of ROUTING_REGISTRY) {
    const path = contract.commandPath;
    if (path.length > tokens.length) continue;
    if (path.every((segment, index) => tokens[index] === segment)) {
      if (!best || path.length > best.commandPath.length) best = contract;
    }
  }
  return best;
}

export type Resolution =
  | { kind: "route"; component: Component; contract: VerbContract; componentTokens: string[]; workspaceName: string | null; workspaceTokenIndex: number | null }
  | { kind: "error"; message: string };

export function resolveInvocation(rawArgs: readonly string[], opts: { forcedComponent?: Component }): Resolution {
  const contract = findContract(rawArgs);
  if (!contract) return { kind: "error", message: `Unknown command '${rawArgs.join(" ")}'. Run: maliang --help` };

  // Split --component out of the forwarded tokens.
  const rest = rawArgs.slice(contract.commandPath.length);
  let flagComponent: Component | undefined;
  const componentTokens: string[] = [];
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === "--component") {
      const value = rest[i + 1];
      if (value !== "writing" && value !== "experiment") return { kind: "error", message: `--component must be writing or experiment` };
      flagComponent = value;
      i++;
      continue;
    }
    componentTokens.push(rest[i]);
  }

  if (opts.forcedComponent && flagComponent && opts.forcedComponent !== flagComponent) {
    return { kind: "error", message: `--component ${flagComponent} conflicts with the ${opts.forcedComponent} namespace` };
  }
  const component = opts.forcedComponent ?? flagComponent ?? contract.defaultComponent;
  if (!contract.components.includes(component)) {
    return { kind: "error", message: `${contract.commandPath.join(" ")} is not available for the ${component} component` };
  }

  if (contract.workspacePosition === null) {
    return { kind: "route", component, contract, componentTokens, workspaceName: null, workspaceTokenIndex: null };
  }

  // Positionals are the leading non-option tokens; the workspace must appear before options.
  let positionalCount = 0;
  let workspaceTokenIndex: number | null = null;
  let workspaceName: string | null = null;
  for (let i = 0; i < componentTokens.length; i++) {
    if (componentTokens[i].startsWith("-")) break;
    if (positionalCount === contract.workspacePosition) {
      workspaceTokenIndex = i;
      workspaceName = componentTokens[i];
      break;
    }
    positionalCount++;
  }
  if (workspaceName === null) {
    return { kind: "error", message: `${contract.commandPath.join(" ")} requires a workspace argument before any options` };
  }
  return { kind: "route", component, contract, componentTokens, workspaceName, workspaceTokenIndex };
}

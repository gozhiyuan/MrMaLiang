export const MINIMUM_NODE_MAJOR = 22;

/** Fail before a workflow is generated or launched with a runtime that cannot
 * build the SQLite evidence index used by LongWrite research workspaces. */
export function requireSupportedNode(action: string): void {
  const major = Number.parseInt(process.versions.node.split(".")[0] ?? "0", 10);
  if (major >= MINIMUM_NODE_MAJOR) return;
  throw new Error(
    `${action} requires Node.js ${MINIMUM_NODE_MAJOR}+ (current: v${process.versions.node}). ` +
    "Switch your shell to Node 22+, then run the command again.",
  );
}

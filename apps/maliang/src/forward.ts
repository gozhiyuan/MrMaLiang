import type { Component, Resolution } from "./routing.js";
import type { MaliangProject } from "./project.js";

export function componentSubdir(project: MaliangProject, component: Component): string {
  const entry = project.components[component];
  if (!entry) {
    const present = Object.keys(project.components).join(", ") || "none";
    throw new Error(`This workspace has no ${component} component (present: ${present})`);
  }
  return entry.workspace;
}

export function buildForwardArgs(resolution: Extract<Resolution, { kind: "route" }>, absoluteComponentDir: string): string[] {
  const args = [...resolution.contract.commandPath, ...resolution.componentTokens];
  if (resolution.workspaceTokenIndex !== null) {
    args[resolution.contract.commandPath.length + resolution.workspaceTokenIndex] = absoluteComponentDir;
  }
  return args;
}

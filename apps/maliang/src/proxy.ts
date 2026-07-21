import fs from "node:fs/promises";
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildForwardArgs, componentSubdir } from "./forward.js";
import { resolveInvocation, type Component } from "./routing.js";
import { readMaliangProject } from "./project.js";

const sourceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

export function componentCli(component: "longwrite" | "longexperiment"): string {
  return path.join(sourceRoot, "packages", component, "dist", "cli.js");
}

const cliFor: Record<Component, "longwrite" | "longexperiment"> = { writing: "longwrite", experiment: "longexperiment" };

/**
 * Translates a child process's exit outcome into a shell-style exit status.
 * A signal-terminated child maps to 128 + the platform's signal number
 * (falling back to 15/SIGTERM's usual number if the signal is unrecognized);
 * otherwise the child's own exit code is used, defaulting to 1 if neither
 * a code nor a signal is available.
 */
export function childExitStatus(code: number | null, signal: NodeJS.Signals | null): number {
  if (signal) return 128 + (os.constants.signals[signal] ?? 15);
  return code ?? 1;
}

export type ForwardOptions = {
  forcedComponent?: Component;
  notify?: boolean;
  /** Test seam only: production callers always use the built component CLI. */
  componentCliPath?: Partial<Record<Component, string>>;
};

export async function forwardCommand(rawArgs: string[], opts: ForwardOptions): Promise<number> {
  const resolution = resolveInvocation(rawArgs, opts);
  if (resolution.kind === "error") {
    throw new Error(resolution.message);
  }

  if (opts.notify) {
    console.error(
      `maliang: forwarding '${resolution.contract.commandPath.join(" ")}' to ${resolution.component} (${cliFor[resolution.component]})`,
    );
  }

  let forwardArgs: string[];
  if (resolution.workspaceName === null) {
    forwardArgs = buildForwardArgs(resolution, "");
  } else {
    const workspace = path.resolve(resolution.workspaceName);
    const project = await readMaliangProject(workspace).catch(() => {
      const kind = resolution.component === "writing" ? "longwrite" : "longexperiment";
      throw new Error(
        `${resolution.workspaceName} is not a MrMaLiang workspace (no maliang.yaml). Create a fresh workspace with \`maliang init\`; direct ${kind} workspace adoption is no longer supported.`,
      );
    });
    const subdir = componentSubdir(project, resolution.component);
    forwardArgs = buildForwardArgs(resolution, path.resolve(workspace, subdir));
  }

  const cliPath = opts.componentCliPath?.[resolution.component] ?? componentCli(cliFor[resolution.component]);
  await fs.access(cliPath).catch(() => {
    throw new Error("MrMaLiang is not built. Run: npm run build");
  });
  const child = spawn(process.execPath, [cliPath, ...forwardArgs], { stdio: "inherit" });
  const forward = (signal: NodeJS.Signals) => {
    if (!child.killed) child.kill(signal);
  };
  process.on("SIGINT", forward);
  process.on("SIGTERM", forward);

  return await new Promise<number>((resolve, reject) => {
    child.once("error", (error) => {
      process.off("SIGINT", forward);
      process.off("SIGTERM", forward);
      reject(error);
    });
    child.once("exit", (code, signal) => {
      process.off("SIGINT", forward);
      process.off("SIGTERM", forward);
      resolve(childExitStatus(code, signal));
    });
  });
}

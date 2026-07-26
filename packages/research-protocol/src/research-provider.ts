import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);

/** A narrow boundary for literature enrichment providers. Consumers ask for a
 * research operation; they never resolve another product's build output. */
export type ResearchProvider = {
  run(args: readonly string[], options: { cwd: string; env?: NodeJS.ProcessEnv }): Promise<void>;
};

export class CliResearchProvider implements ResearchProvider {
  constructor(private readonly bin = process.env.LONGEXPERIMENT_RESEARCH_PROVIDER_BIN ?? "longwrite") {}

  async run(args: readonly string[], options: { cwd: string; env?: NodeJS.ProcessEnv }): Promise<void> {
    try {
      await execFile(this.bin, [...args], { cwd: options.cwd, env: options.env ?? process.env, maxBuffer: 20 * 1024 * 1024 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new Error(`Research provider \"${this.bin}\" is unavailable. Install a compatible provider or set LONGEXPERIMENT_RESEARCH_PROVIDER_BIN.`);
      }
      throw error;
    }
  }
}

import { spawn } from "node:child_process";
import type { ExperimentComputeAdapter, ExperimentRunHandle, ExperimentRunSpec, ExperimentRunStatus, ComputeHealth, LogChunk, ResultBundle } from "./types.js";
import { ComputeHealth as ComputeHealthSchema, ExperimentRunHandle as HandleSchema, ExperimentRunStatus as StatusSchema, LogChunk as LogChunkSchema, ResultBundle as ResultBundleSchema } from "./types.js";

type AdapterOperation = "check" | "submit" | "status" | "logs" | "collect" | "cancel";
export type SubprocessAdapterOptions = { id: string; command: string; args?: string[]; cwd?: string };

/**
 * JSON-lines adapter bridge. The final non-empty stdout line is the only
 * protocol result, so providers may stream human-readable diagnostics before
 * it without corrupting durable remote-job state.
 */
export class SubprocessComputeAdapter implements ExperimentComputeAdapter {
  readonly id: string;
  constructor(private readonly options: SubprocessAdapterOptions) { this.id = options.id; }

  async checkAvailable(): Promise<ComputeHealth> { return ComputeHealthSchema.parse(await this.call("check", {})); }
  async submit(spec: ExperimentRunSpec): Promise<ExperimentRunHandle> { return HandleSchema.parse(await this.call("submit", { spec })); }
  async status(handle: ExperimentRunHandle): Promise<ExperimentRunStatus> { return StatusSchema.parse(await this.call("status", { handle })); }
  async logs(handle: ExperimentRunHandle, cursor?: string): Promise<LogChunk> { return LogChunkSchema.parse(await this.call("logs", { handle, ...(cursor ? { cursor } : {}) })); }
  async collect(handle: ExperimentRunHandle, targetDir: string): Promise<ResultBundle> { return ResultBundleSchema.parse(await this.call("collect", { handle, target_dir: targetDir })); }
  async cancel(handle: ExperimentRunHandle): Promise<void> { await this.call("cancel", { handle }); }

  private async call(operation: AdapterOperation, payload: Record<string, unknown>): Promise<unknown> {
    const { command, args = [], cwd } = this.options;
    return new Promise((resolve, reject) => {
      const child = spawn(command, args, { cwd, stdio: ["pipe", "pipe", "pipe"] });
      let stdout = ""; let stderr = "";
      child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => { stdout += chunk; });
      child.stderr.on("data", (chunk: string) => { stderr += chunk; });
      child.once("error", reject);
      child.once("close", (code) => {
        const line = stdout.trim().split(/\r?\n/).filter(Boolean).at(-1);
        if (code !== 0) return reject(new Error(`compute adapter ${this.id} ${operation} exited ${code}: ${stderr.trim() || line || "no diagnostics"}`));
        if (!line) return reject(new Error(`compute adapter ${this.id} ${operation} produced no protocol JSON`));
        try { resolve(JSON.parse(line)); } catch { reject(new Error(`compute adapter ${this.id} ${operation} final stdout line is not JSON`)); }
      });
      child.stdin.end(`${JSON.stringify({ version: 1, operation, ...payload })}\n`);
    });
  }
}

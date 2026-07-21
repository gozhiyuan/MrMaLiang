import { spawn } from "node:child_process";
import path from "node:path";

export type MalaClawRunResult = {
  code: number;
  output: string;
};

export type MalaClawRunOptions = {
  stream?: boolean;
};

function malaclawBin(): string {
  return process.env.LONGWRITE_MALACLAW_BIN ?? "malaclaw";
}

export async function runMalaClaw(
  workspaceDir: string,
  args: string[],
  opts: MalaClawRunOptions = {},
): Promise<MalaClawRunResult> {
  const cwd = path.resolve(workspaceDir);
  return await new Promise((resolve, reject) => {
    const child = spawn(malaclawBin(), args, {
      cwd,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";

    child.stdout.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      output += text;
      if (opts.stream) process.stdout.write(text);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      output += text;
      if (opts.stream) process.stderr.write(text);
    });
    child.on("error", (err) => {
      reject(new Error(`Failed to start malaclaw: ${err.message}`));
    });
    child.on("close", (code) => {
      const result = { code: code ?? 1, output };
      if (result.code === 0) resolve(result);
      else reject(new Error(`malaclaw ${args.join(" ")} failed with exit code ${result.code}\n${output}`.trim()));
    });
  });
}

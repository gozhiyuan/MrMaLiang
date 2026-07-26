import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ComputeAdapterRegistry } from "../src/lib/compute/registry.js";
import { SubprocessComputeAdapter } from "../src/lib/compute/adapter.js";
import { cancelPersistedRemoteJob, collectPersistedRemoteJob, persistRemoteHandle, readRemoteHandle } from "../src/lib/compute/handles.js";

const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true }))); });

async function fakeAdapter(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "compute-adapter-")); dirs.push(dir);
  const file = path.join(dir, "adapter.mjs");
  await fs.writeFile(file, `let input=""; process.stdin.on("data", c => input += c); process.stdin.on("end", () => { const q=JSON.parse(input); console.log("diagnostic"); if (q.operation === "check") console.log(JSON.stringify({available:true})); else if (q.operation === "submit") console.log(JSON.stringify({version:1,adapter_id:"fake",job_id:"job-1"})); else if (q.operation === "status") console.log(JSON.stringify({state:process.env.FAKE_DONE ? "succeeded" : "running"})); else if (q.operation === "logs") console.log(JSON.stringify({text:"hello",complete:false})); else if (q.operation === "collect") console.log(JSON.stringify({result_path:"results/raw.json",artifacts:[]})); else console.log(JSON.stringify({ok:true})); });`);
  return file;
}

describe("provider-neutral compute adapters", () => {
  it("keeps opaque handles and supports the durable lifecycle", async () => {
    const file = await fakeAdapter();
    const adapter = new SubprocessComputeAdapter({ id: "fake", command: process.execPath, args: [file] });
    const registry = new ComputeAdapterRegistry(); registry.register(adapter);
    expect(registry.ids()).toEqual(["fake"]);
    expect(await adapter.checkAvailable()).toMatchObject({ available: true });
    const handle = await adapter.submit({ version: 1, candidate_id: "c1", git: { source: "https://example.com/repo.git", revision: "a".repeat(40) }, image: "python:3.12", command: ["python", "run.py"], timeout_seconds: 60, resources: {}, evaluator: { protected_paths: ["evaluator.py"], result_path: "results/raw.json" } });
    expect(handle.job_id).toBe("job-1");
    expect(await registry.resolve("fake").status(handle)).toMatchObject({ state: "running" });
    expect(await adapter.collect(handle, "results")).toMatchObject({ result_path: "results/raw.json" });
    await expect(adapter.cancel(handle)).resolves.toBeUndefined();
  });

  it("refuses unknown adapters", () => {
    expect(() => new ComputeAdapterRegistry().resolve("modal")).toThrow(/unknown compute adapter/);
  });

  it("reconnects and cancels from a persisted opaque remote handle", async () => {
    const file = await fakeAdapter(); const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "remote-handle-")); dirs.push(workspace);
    const running = new SubprocessComputeAdapter({ id: "fake", command: process.execPath, args: [file] });
    const handle = await running.submit({ version: 1, candidate_id: "c1", git: { source: "https://example.com/repo.git", revision: "a".repeat(40) }, image: "python:3.12", command: ["python", "run.py"], timeout_seconds: 60, resources: {}, evaluator: { protected_paths: [], result_path: "results/raw.json" } });
    await persistRemoteHandle(workspace, "primary", handle);
    expect((await readRemoteHandle(workspace, "primary")).handle.job_id).toBe("job-1");
    await expect(collectPersistedRemoteJob(running, workspace, "primary", "results")).rejects.toThrow(/running/);
    const done = new SubprocessComputeAdapter({ id: "fake", command: "env", args: ["FAKE_DONE=1", process.execPath, file] });
    await expect(collectPersistedRemoteJob(done, workspace, "primary", "results")).resolves.toMatchObject({ result_path: "results/raw.json" });
    await expect(cancelPersistedRemoteJob(done, workspace, "primary")).resolves.toBeUndefined();
  });
});

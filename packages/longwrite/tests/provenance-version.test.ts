import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { publicationProvenanceSummary } from "../src/lib/ops/workspace-lifecycle.js";

const tempDirs: string[] = [];
const savedBin = process.env.LONGWRITE_MALACLAW_BIN;
const savedSource = process.env.MALACLAW_SOURCE_DIR;

async function tempDir(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  if (savedBin === undefined) delete process.env.LONGWRITE_MALACLAW_BIN;
  else process.env.LONGWRITE_MALACLAW_BIN = savedBin;
  if (savedSource === undefined) delete process.env.MALACLAW_SOURCE_DIR;
  else process.env.MALACLAW_SOURCE_DIR = savedSource;
  while (tempDirs.length > 0) await fs.rm(tempDirs.pop()!, { recursive: true, force: true });
});

describe("publicationProvenanceSummary MalaClaw version", () => {
  it("falls back to MALACLAW_SOURCE_DIR/package.json when the binary is not resolvable", async () => {
    // The runtime bin is deliberately unresolvable, mirroring CI where MalaClaw
    // is built from source but never linked onto PATH.
    process.env.LONGWRITE_MALACLAW_BIN = path.join(os.tmpdir(), "no-such-malaclaw-binary-xyz");
    const source = await tempDir("malaclaw-source-");
    await fs.writeFile(path.join(source, "package.json"), JSON.stringify({ name: "malaclaw", version: "1.2.3" }), "utf-8");
    process.env.MALACLAW_SOURCE_DIR = source;

    const summary = await publicationProvenanceSummary(await tempDir("lw-ws-"));
    expect(summary.malaclaw).toBe("MalaClaw 1.2.3");
  });

  it("omits the MalaClaw line when neither the binary nor a source checkout is available", async () => {
    process.env.LONGWRITE_MALACLAW_BIN = path.join(os.tmpdir(), "no-such-malaclaw-binary-xyz");
    delete process.env.MALACLAW_SOURCE_DIR;

    const summary = await publicationProvenanceSummary(await tempDir("lw-ws-"));
    expect(summary.malaclaw).toBeUndefined();
  });
});

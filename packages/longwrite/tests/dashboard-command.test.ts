import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
import { ensureLongWriteDashboardExtensionRegistered } from "../src/commands/dashboard.js";

const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "longwrite-dashboard-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  while (tempDirs.length > 0) await fs.rm(tempDirs.pop()!, { recursive: true, force: true });
});

describe("LongWrite dashboard command", () => {
  it("creates dashboard.yaml and registers the LongWrite extension", async () => {
    const dir = await makeTempDir();
    const configPath = path.join(dir, "dashboard.yaml");
    const extensionPath = path.join(dir, "extension.js");
    await fs.writeFile(extensionPath, "export default {}", "utf-8");

    const result = await ensureLongWriteDashboardExtensionRegistered({ configPath, extensionPath });
    const parsed = parseYaml(await fs.readFile(configPath, "utf-8")) as { dashboard: { server_extensions: string[] } };

    expect(result.added).toBe(true);
    expect(parsed.dashboard.server_extensions).toEqual([extensionPath]);
  });

  it("preserves existing extensions and does not duplicate LongWrite", async () => {
    const dir = await makeTempDir();
    const configPath = path.join(dir, "dashboard.yaml");
    const extensionPath = path.join(dir, "longwrite.js");
    const otherPath = path.join(dir, "other.js");
    await fs.writeFile(extensionPath, "export default {}", "utf-8");
    await fs.writeFile(configPath, [
      "dashboard:",
      "  theme: dark",
      "  server_extensions:",
      `    - ${otherPath}`,
      `    - ${extensionPath}`,
      "other:",
      "  keep: true",
      "",
    ].join("\n"), "utf-8");

    const result = await ensureLongWriteDashboardExtensionRegistered({ configPath, extensionPath });
    const parsed = parseYaml(await fs.readFile(configPath, "utf-8")) as {
      dashboard: { theme: string; server_extensions: string[] };
      other: { keep: boolean };
    };

    expect(result.added).toBe(false);
    expect(parsed.dashboard.theme).toBe("dark");
    expect(parsed.other.keep).toBe(true);
    expect(parsed.dashboard.server_extensions).toEqual([otherPath, extensionPath]);
  });

  it("fails clearly when the built extension file is missing", async () => {
    const dir = await makeTempDir();
    await expect(ensureLongWriteDashboardExtensionRegistered({
      configPath: path.join(dir, "dashboard.yaml"),
      extensionPath: path.join(dir, "missing.js"),
    })).rejects.toThrow(/dashboard extension not found/);
  });

  it("refuses malformed existing dashboard extension config without rewriting it", async () => {
    const dir = await makeTempDir();
    const configPath = path.join(dir, "dashboard.yaml");
    const extensionPath = path.join(dir, "extension.js");
    const original = "dashboard:\n  server_extensions: not-a-list\n";
    await fs.writeFile(extensionPath, "export default {}", "utf-8");
    await fs.writeFile(configPath, original, "utf-8");

    await expect(ensureLongWriteDashboardExtensionRegistered({ configPath, extensionPath }))
      .rejects.toThrow(/server_extensions must be a YAML list/);
    expect(await fs.readFile(configPath, "utf-8")).toBe(original);
  });
});

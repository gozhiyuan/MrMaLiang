import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { packageRoot } from "../lib/paths.js";
import { runMalaClaw } from "../lib/malaclaw.js";

export type DashboardOptions = {
  port?: string;
  host?: string;
  authToken?: string;
  installOnly?: boolean;
};

export type DashboardRegistrationOptions = {
  configPath?: string;
  extensionPath?: string;
  requireExtensionFile?: boolean;
};

export type DashboardRegistrationResult = {
  configPath: string;
  extensionPath: string;
  added: boolean;
};

type DashboardConfig = {
  dashboard?: {
    server_extensions?: unknown;
    [key: string]: unknown;
  };
  [key: string]: unknown;
};

export function defaultDashboardConfigPath(): string {
  const root = process.env.MALACLAW_DIR ?? path.join(os.homedir(), ".malaclaw");
  return path.join(root, "dashboard.yaml");
}

export function defaultLongWriteDashboardExtensionPath(): string {
  return path.join(packageRoot(), "dashboard-extension", "dist", "server", "index.js");
}

async function readConfig(configPath: string): Promise<DashboardConfig> {
  let raw: string;
  try {
    raw = await fs.readFile(configPath, "utf-8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw err;
  }

  try {
    const parsed = parseYaml(raw);
    if (parsed === null || parsed === undefined) return {};
    if (typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("dashboard config root must be a YAML mapping");
    }
    return parsed as DashboardConfig;
  } catch (err) {
    throw new Error(`Failed to parse ${configPath}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

export async function ensureLongWriteDashboardExtensionRegistered(
  opts: DashboardRegistrationOptions = {},
): Promise<DashboardRegistrationResult> {
  const configPath = opts.configPath ?? defaultDashboardConfigPath();
  const extensionPath = path.resolve(opts.extensionPath ?? defaultLongWriteDashboardExtensionPath());
  const requireExtensionFile = opts.requireExtensionFile ?? true;

  if (requireExtensionFile) {
    try {
      await fs.access(extensionPath);
    } catch {
      throw new Error(`LongWrite dashboard extension not found at ${extensionPath}. Run \`npm run build\` in the MrMaLiang checkout, or reinstall the longwrite package.`);
    }
  }

  const config = await readConfig(configPath);
  if (config.dashboard !== undefined && (typeof config.dashboard !== "object" || Array.isArray(config.dashboard))) {
    throw new Error(`Failed to update ${configPath}: dashboard must be a YAML mapping`);
  }
  const dashboard = config.dashboard ?? {};
  if (dashboard.server_extensions !== undefined && !Array.isArray(dashboard.server_extensions)) {
    throw new Error(`Failed to update ${configPath}: dashboard.server_extensions must be a YAML list of paths`);
  }
  const rawExtensions = dashboard.server_extensions ?? [];
  if (rawExtensions.some((entry) => typeof entry !== "string" || entry.trim().length === 0)) {
    throw new Error(`Failed to update ${configPath}: dashboard.server_extensions must contain non-empty path strings`);
  }
  const existing = rawExtensions;

  const normalized = existing.map((entry) => entry.trim());
  const added = !normalized.includes(extensionPath);
  const serverExtensions = added ? [...normalized, extensionPath] : normalized;

  config.dashboard = {
    ...dashboard,
    server_extensions: serverExtensions,
  };

  await fs.mkdir(path.dirname(configPath), { recursive: true });
  await fs.writeFile(configPath, stringifyYaml(config), "utf-8");
  return { configPath, extensionPath, added };
}

export async function runDashboard(opts: DashboardOptions): Promise<void> {
  const registration = await ensureLongWriteDashboardExtensionRegistered();
  console.log(`${registration.added ? "Registered" : "Found"} LongWrite dashboard extension: ${registration.extensionPath}`);
  console.log(`Dashboard config: ${registration.configPath}`);

  if (opts.installOnly) return;

  const args = ["dashboard"];
  if (opts.port) args.push("--port", opts.port);
  if (opts.host) args.push("--host", opts.host);
  if (opts.authToken) args.push("--auth-token", opts.authToken);
  await runMalaClaw(process.cwd(), args, { stream: true });
}

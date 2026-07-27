import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { z } from "zod";
import { parse as parseYaml } from "yaml";
import { ExperimentConfig } from "./schema.js";

/**
 * Unattended authorization lease (LE-1.2).
 *
 * "Unattended" means PRE-AUTHORIZED AND BOUNDED, never unrestricted. A lease
 * is a human's explicit, time-limited, budget-capped grant to run agent-
 * authored code without further prompting.
 *
 * The lease is bound to a hash of the normalized `experiment.yaml`. Any change
 * to the config — a new mutable path, a bigger suite, a different runner —
 * changes that hash and invalidates the lease. Without this binding, a lease
 * granted for a small ablation would silently authorize whatever the config
 * became afterwards.
 */

export const AUTHORIZATION_PATH = path.join(".longexperiment", "authorization.json");
export const AUTHORIZATION_HISTORY_PATH = path.join(".longexperiment", "authorization-history.jsonl");

export const AuthorizationLease = z.object({
  version: z.literal(1),
  config_sha256: z.string().regex(/^[a-f0-9]{64}$/),
  issued_at: z.string().datetime(),
  expires_at: z.string().datetime(),
  max_trials: z.number().int().positive(),
  max_gpu_hours: z.number().positive(),
  max_cost_usd: z.number().positive().optional(),
  max_wall_hours: z.number().positive(),
  max_storage_gb: z.number().positive(),
  max_recorded_tokens: z.number().int().positive().optional(),
  network_policy: z.enum(["none", "allowlist", "unrestricted"]),
  allowed_hosts: z.array(z.string()).default([]),
  allowed_secret_names: z.array(z.string()).default([]),
  approved_by: z.string().min(1),
}).strict();
export type AuthorizationLease = z.infer<typeof AuthorizationLease>;

/**
 * Hash the SEMANTIC config, not the file bytes.
 *
 * Parsing through ExperimentConfig first means a reformat, a comment, or a
 * reordered key does not invalidate a valid lease, while any change the engine
 * would actually act on does.
 */
export function hashExperimentConfig(config: ExperimentConfig): string {
  return crypto.createHash("sha256").update(stableStringify(config)).digest("hex");
}

/** Deterministic JSON: key order must not affect the hash. */
function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(",")}}`;
  }
  return JSON.stringify(value ?? null);
}

export async function readExperimentConfig(workspaceDir: string): Promise<ExperimentConfig> {
  const raw = await fs.readFile(path.join(workspaceDir, "experiment.yaml"), "utf-8");
  return ExperimentConfig.parse(parseYaml(raw));
}

export type IssueLeaseOptions = {
  maxTrials: number;
  maxGpuHours: number;
  maxWallHours: number;
  maxStorageGb?: number;
  maxCostUsd?: number;
  maxRecordedTokens?: number;
  expiresInHours: number;
  networkPolicy?: AuthorizationLease["network_policy"];
  allowedHosts?: string[];
  allowedSecretNames?: string[];
  approvedBy: string;
};

/** Default allowlist: the hosts a training job realistically needs. */
export const DEFAULT_ALLOWED_HOSTS = ["huggingface.co", "github.com", "pypi.org"];

export async function issueLease(
  workspaceDir: string,
  options: IssueLeaseOptions,
): Promise<AuthorizationLease> {
  const config = await readExperimentConfig(workspaceDir);
  const now = new Date();
  const lease = AuthorizationLease.parse({
    version: 1,
    config_sha256: hashExperimentConfig(config),
    issued_at: now.toISOString(),
    expires_at: new Date(now.getTime() + options.expiresInHours * 3_600_000).toISOString(),
    max_trials: options.maxTrials,
    max_gpu_hours: options.maxGpuHours,
    max_wall_hours: options.maxWallHours,
    max_storage_gb: options.maxStorageGb ?? 50,
    ...(options.maxCostUsd !== undefined ? { max_cost_usd: options.maxCostUsd } : {}),
    ...(options.maxRecordedTokens !== undefined ? { max_recorded_tokens: options.maxRecordedTokens } : {}),
    network_policy: options.networkPolicy ?? "allowlist",
    allowed_hosts: options.allowedHosts ?? DEFAULT_ALLOWED_HOSTS,
    allowed_secret_names: options.allowedSecretNames ?? [],
    approved_by: options.approvedBy,
  });

  const target = path.join(workspaceDir, AUTHORIZATION_PATH);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, `${JSON.stringify(lease, null, 2)}\n`, "utf-8");

  // Append-only history: a superseded lease stays auditable, so "what were we
  // authorized to spend at the time?" is answerable after the fact.
  await fs.appendFile(
    path.join(workspaceDir, AUTHORIZATION_HISTORY_PATH),
    `${JSON.stringify({ ...lease, recorded_at: now.toISOString() })}\n`,
    "utf-8",
  );
  return lease;
}

export async function readLease(workspaceDir: string): Promise<AuthorizationLease | null> {
  try {
    const raw = await fs.readFile(path.join(workspaceDir, AUTHORIZATION_PATH), "utf-8");
    return AuthorizationLease.parse(JSON.parse(raw));
  } catch {
    return null;
  }
}

export type LeaseValidation =
  | { valid: true; lease: AuthorizationLease }
  | { valid: false; problems: string[] };

/**
 * Validate a lease against the workspace it claims to authorize.
 *
 * Fails closed: a missing, expired, malformed, or config-mismatched lease is
 * not authorization.
 */
export async function validateLease(
  workspaceDir: string,
  now: Date = new Date(),
): Promise<LeaseValidation> {
  const problems: string[] = [];

  let config: ExperimentConfig;
  try {
    config = await readExperimentConfig(workspaceDir);
  } catch (error) {
    return { valid: false, problems: [`cannot read experiment.yaml: ${error instanceof Error ? error.message.split("\n")[0] : String(error)}`] };
  }

  const lease = await readLease(workspaceDir);
  if (!lease) {
    return {
      valid: false,
      problems: [
        `no authorization lease at ${AUTHORIZATION_PATH}. ` +
        "Issue one with `maliang experiment authorize <workspace> --unattended …`.",
      ],
    };
  }

  const expected = hashExperimentConfig(config);
  if (lease.config_sha256 !== expected) {
    problems.push(
      "experiment.yaml changed since this lease was issued " +
      `(lease ${lease.config_sha256.slice(0, 12)}…, config ${expected.slice(0, 12)}…). ` +
      "Re-authorize after reviewing the change.",
    );
  }

  if (Date.parse(lease.expires_at) <= now.getTime()) {
    problems.push(`lease expired at ${lease.expires_at}.`);
  }
  if (Date.parse(lease.issued_at) > now.getTime()) {
    problems.push(`lease is issued in the future (${lease.issued_at}); refusing to trust it.`);
  }

  // A lease cannot authorize more trials than the config will even run, and a
  // config that wants more than the lease permits is not covered.
  if (config.execution.max_trials > lease.max_trials) {
    problems.push(
      `config allows ${config.execution.max_trials} trials but the lease caps them at ${lease.max_trials}.`,
    );
  }

  if (lease.network_policy === "allowlist" && lease.allowed_hosts.length === 0) {
    problems.push("network_policy is allowlist but allowed_hosts is empty; use \"none\" to mean no network.");
  }

  return problems.length === 0 ? { valid: true, lease } : { valid: false, problems };
}

/**
 * Gate an unattended run.
 *
 * Interactive workspaces need no lease. Unattended ones need a valid one, and
 * the declared `lease_path` must be the path this module actually manages —
 * otherwise a config could point authorization at a file nobody validates.
 */
export async function assertAuthorizedForUnattendedRun(workspaceDir: string): Promise<AuthorizationLease | null> {
  const config = await readExperimentConfig(workspaceDir);
  const authorization = config.execution.authorization;
  if (!authorization || authorization.mode === "interactive") return null;

  if (path.normalize(authorization.lease_path) !== path.normalize(AUTHORIZATION_PATH)) {
    throw new Error(
      `execution.authorization.lease_path must be "${AUTHORIZATION_PATH}" ` +
      `(got "${authorization.lease_path}"); authorization is only read from the managed path.`,
    );
  }

  const result = await validateLease(workspaceDir);
  if (!result.valid) {
    throw new Error(
      `Unattended execution is not authorized:\n${result.problems.map((p) => `  - ${p}`).join("\n")}`,
    );
  }
  return result.lease;
}

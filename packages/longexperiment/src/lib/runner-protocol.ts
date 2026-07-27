import { z } from "zod";

const relativeArtifact = z.string().min(1).refine((value) => !value.startsWith("/") && !value.split(/[\\/]/).includes(".."), "artifact_dir must be workspace-relative");
export const RunnerRequest = z.object({
  protocol: z.literal(1), operation: z.literal("run_trial"), study_id: z.string().min(1), condition: z.string().min(1), seed: z.number().int().nonnegative(), primary_metric: z.string().min(1), artifact_dir: relativeArtifact,
}).strict();
export type RunnerRequest = z.infer<typeof RunnerRequest>;
export const RunnerResponse = z.object({
  protocol: z.literal(1), status: z.literal("completed"), metrics: z.record(z.number().finite()), artifacts: z.array(relativeArtifact).default([]),
}).strict();
export type RunnerResponse = z.infer<typeof RunnerResponse>;

/** Retained during the protocol migration so existing runner templates work. */
export function legacyRunnerEnvironment(request: RunnerRequest, workspace: string, smoke = false): NodeJS.ProcessEnv {
  return {
    LONGEXPERIMENT_WORKSPACE: workspace, LONGEXPERIMENT_STUDY_ID: request.study_id, LONGEXPERIMENT_CONDITION: request.condition,
    LONGEXPERIMENT_SEED: String(request.seed), LONGEXPERIMENT_SMOKE: smoke ? "1" : "0", LONGEXPERIMENT_ARTIFACT_DIR: request.artifact_dir,
    LONGEXPERIMENT_PRIMARY_METRIC: request.primary_metric, LONGEXPERIMENT_PROTOCOL_REQUEST: JSON.stringify(request),
  };
}

/** Read the final stdout line, accepting the legacy metric shape for one
 * migration window while canonicalizing successful protocol responses. */
export function parseRunnerResponse(stdout: string, primaryMetric: string): RunnerResponse {
  const line = stdout.split(/\r?\n/).map((value) => value.trim()).filter(Boolean).at(-1);
  if (!line) throw new Error("runner produced no JSON result");
  const row = JSON.parse(line) as Record<string, unknown>;
  const protocol = RunnerResponse.safeParse(row);
  if (protocol.success) {
    if (protocol.data.metrics[primaryMetric] === undefined) throw new Error(`runner protocol response omits primary metric ${primaryMetric}`);
    return protocol.data;
  }
  const metrics = typeof row.metrics === "object" && row.metrics !== null ? row.metrics as Record<string, unknown> : {};
  const metric = typeof row.metric === "number" ? row.metric : metrics[primaryMetric];
  if (typeof metric !== "number" || !Number.isFinite(metric)) throw new Error(`runner must report finite metric ${primaryMetric}`);
  const artifacts = row.artifacts === undefined ? [] : z.array(relativeArtifact).parse(row.artifacts);
  return { protocol: 1, status: "completed", metrics: { [primaryMetric]: metric }, artifacts };
}

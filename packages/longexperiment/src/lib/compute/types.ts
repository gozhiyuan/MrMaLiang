import { z } from "zod";

/** Provider-neutral remote compute contract. Provider handles are opaque. */
export const ExperimentRunSpec = z.object({
  version: z.literal(1),
  candidate_id: z.string().min(1),
  git: z.object({ source: z.string().url(), revision: z.string().regex(/^[a-f0-9]{7,64}$/) }).strict(),
  image: z.string().min(1),
  command: z.array(z.string().min(1)).min(1),
  timeout_seconds: z.number().int().positive(),
  resources: z.object({ gpu: z.string().min(1).optional(), cpu: z.number().positive().optional(), memory_mb: z.number().int().positive().optional() }).strict(),
  evaluator: z.object({ protected_paths: z.array(z.string().min(1)), result_path: z.string().min(1) }).strict(),
  environment: z.record(z.string()).default({}),
  allowed_secret_names: z.array(z.string().min(1)).default([]),
}).strict();
export type ExperimentRunSpec = z.infer<typeof ExperimentRunSpec>;

export const ExperimentRunHandle = z.object({
  version: z.literal(1), adapter_id: z.string().min(1), job_id: z.string().min(1), opaque: z.record(z.unknown()).default({}),
}).strict();
export type ExperimentRunHandle = z.infer<typeof ExperimentRunHandle>;

export const ExperimentRunStatus = z.object({
  state: z.enum(["queued", "running", "succeeded", "failed", "cancelled"]), message: z.string().optional(), updated_at: z.string().datetime().optional(),
}).strict();
export type ExperimentRunStatus = z.infer<typeof ExperimentRunStatus>;

export const ComputeHealth = z.object({ available: z.boolean(), message: z.string().optional() }).strict();
export type ComputeHealth = z.infer<typeof ComputeHealth>;
export const LogChunk = z.object({ text: z.string(), cursor: z.string().optional(), complete: z.boolean().default(false) }).strict();
export type LogChunk = z.infer<typeof LogChunk>;
export const ResultBundle = z.object({ result_path: z.string().min(1), artifacts: z.array(z.string().min(1)).default([]) }).strict();
export type ResultBundle = z.infer<typeof ResultBundle>;

export interface ExperimentComputeAdapter {
  readonly id: string;
  checkAvailable(): Promise<ComputeHealth>;
  submit(spec: ExperimentRunSpec): Promise<ExperimentRunHandle>;
  status(handle: ExperimentRunHandle): Promise<ExperimentRunStatus>;
  logs(handle: ExperimentRunHandle, cursor?: string): Promise<LogChunk>;
  collect(handle: ExperimentRunHandle, targetDir: string): Promise<ResultBundle>;
  cancel(handle: ExperimentRunHandle): Promise<void>;
}

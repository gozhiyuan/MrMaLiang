import { describe, expect, it } from "vitest";
import { RunnerRequest, legacyRunnerEnvironment, parseRunnerResponse } from "../src/lib/runner-protocol.js";
describe("scientific runner protocol", () => {
  const request = RunnerRequest.parse({ protocol: 1, operation: "run_trial", study_id: "primary", condition: "candidate", seed: 23, primary_metric: "validation_loss", artifact_dir: "artifacts/trials/primary/candidate/23" });
  it("maps the canonical request to legacy environment fields", () => {
    const env = legacyRunnerEnvironment(request, "/workspace");
    expect(env).toMatchObject({ LONGEXPERIMENT_STUDY_ID: "primary", LONGEXPERIMENT_SEED: "23", LONGEXPERIMENT_ARTIFACT_DIR: request.artifact_dir });
    expect(JSON.parse(env.LONGEXPERIMENT_PROTOCOL_REQUEST!)).toEqual(request);
  });
  it("accepts both canonical and migration legacy final JSON lines", () => {
    expect(parseRunnerResponse('{"protocol":1,"status":"completed","metrics":{"validation_loss":1.234},"artifacts":[]}', "validation_loss").metrics.validation_loss).toBe(1.234);
    expect(parseRunnerResponse('{"metric":1.25,"artifacts":["artifacts/x.json"]}', "validation_loss").metrics.validation_loss).toBe(1.25);
  });
});

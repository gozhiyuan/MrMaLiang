import { TaskProfileRegistry } from "../lib/task-profile.js";
import { paperReproductionProfile } from "./paper-reproduction.js";
import { repositoryOptimizationProfile } from "./repository-optimization.js";
import { surveyPilotStudyProfile } from "./survey-pilot-study.js";

export function createTaskProfileRegistry(): TaskProfileRegistry {
  const registry = new TaskProfileRegistry();
  registry.register(repositoryOptimizationProfile);
  registry.register(surveyPilotStudyProfile);
  registry.register(paperReproductionProfile);
  return registry;
}

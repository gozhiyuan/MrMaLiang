import { describe, expect, it } from "vitest";
import { initArgs } from "../dashboard-extension/server/routes.js";

describe("LongWrite dashboard initialization contract", () => {
  it("routes dashboard repository creation through the public survey template", () => {
    const { args, componentDir } = initArgs({
      dir: "/tmp/dashboard-repository-survey",
      mode: "auto_research_agentic",
      topic: "Repository architecture",
      repositories: ["https://github.com/example/demo.git"],
      outputFormats: ["markdown", "pdf"],
    });
    expect(args).toEqual(expect.arrayContaining([
      "--template", "paper.survey",
      "--repository", "https://github.com/example/demo.git",
      "--output-format", "markdown", "pdf",
    ]));
    expect(componentDir).toBe("/tmp/dashboard-repository-survey/writing");
  });

  it("keeps a topic-only dashboard research project on the public survey template", () => {
    const { args } = initArgs({ dir: "/tmp/dashboard-literature-survey", mode: "auto_research_agentic", topic: "Agent memory" });
    expect(args).toEqual(expect.arrayContaining(["--template", "paper.survey", "--topic", "Agent memory"]));
    expect(args).not.toContain("--repository");
  });

  it("forwards bounded GitHub discovery through the public Maliang facade", () => {
    const { args } = initArgs({
      dir: "/tmp/dashboard-discovery-survey", mode: "auto_research_agentic", topic: "Agent repositories",
      discoverRepositories: true, repositoryQueryBudget: 3, repositoryMaxCandidates: 20,
      repositoryMaxReadmes: 5, repositoryMaxSelected: 2, repositoryLanguages: ["Python"],
      includeArchivedRepositories: true, allowUnlicensedRepositories: true,
    });
    expect(args).toEqual(expect.arrayContaining([
      "--template", "paper.survey", "--discover-repositories", "--repository-query-budget", "3",
      "--repository-max-candidates", "20", "--repository-max-readmes", "5", "--repository-max-selected", "2",
      "--repository-language", "Python", "--include-archived-repositories", "--allow-unlicensed-repositories",
    ]));
  });
});

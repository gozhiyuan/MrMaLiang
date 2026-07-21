import { describe, expect, it } from "vitest";
import { parseProjectConfig, projectConfigErrorToFindings } from "../src/lib/project-config.js";

describe("LongWriteProjectConfig", () => {
  it("parses generated longwrite.yaml shape and applies defaults", () => {
    const config = parseProjectConfig({
      version: 1,
      project: {
        id: "real-survey",
        artifact_type: "research_paper",
        mode: "auto_research_agentic",
      },
    });
    expect(config.research.provider).toBe("seed");
    expect(config.research.paper_kind).toBe("survey");
    expect(config.research.paper_profile).toBe("literature_survey");
    expect(config.project.authors).toEqual([]);
    expect(config.writing).toEqual({
      reference_links: [],
      reference_files: [],
      output_formats: ["markdown"],
    });
    expect(config.review).toEqual({
      cadence: "manual",
      time: "08:00",
      interval_hours: 4,
      batch_approvals: false,
    });
  });

  it("requires a codebase or discovery for repository-study papers", () => {
    expect(() => parseProjectConfig({
      version: 1,
      project: { id: "repo-paper", artifact_type: "research_paper", mode: "auto_research_agentic" },
      research: { paper_profile: "repository_study" },
    })).toThrow(/repository_study requires at least one codebase/i);
  });

  it("rejects a disclosure that would be silently suppressed for anonymous submission", () => {
    expect(() => parseProjectConfig({
      version: 1,
      project: { id: "anonymous-paper", artifact_type: "research_paper", mode: "auto_research_agentic" },
      publication: { anonymous: true, presentation: { disclosure: { enabled: true } } },
    })).toThrow(/anonymous publication cannot include/i);
  });

  it("rejects unknown keys and invalid review/provider values", () => {
    expect(() =>
      parseProjectConfig({
        version: 1,
        project: {
          id: "real-survey",
          artifact_type: "research_paper",
          mode: "auto_research_agentic",
          typo: true,
        },
      }),
    ).toThrow(/unrecognized key/i);

    try {
      parseProjectConfig({
        version: 1,
        project: { id: "real-survey", artifact_type: "research_paper", mode: "auto_research_agentic" },
        research: { provider: "web" },
        writing: { target_length_words: 0, output_formats: ["docx"] },
        review: { cadence: "whenever", time: "25:99", interval_hours: 0 },
      });
      throw new Error("expected config parse to fail");
    } catch (err) {
      const findings = projectConfigErrorToFindings(err).join("\n");
      expect(findings).toContain("research.provider");
      expect(findings).toContain("writing.target_length_words");
      expect(findings).toContain("writing.output_formats");
      expect(findings).toContain("review.cadence");
      expect(findings).toContain("review.time");
      expect(findings).toContain("review.interval_hours");
    }
  });
});

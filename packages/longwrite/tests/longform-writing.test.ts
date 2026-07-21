import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { stringify as stringifyYaml } from "yaml";
import { writeNovelStage } from "../src/lib/writing/novel.js";
import { writeTechnicalBookStage } from "../src/lib/writing/technical-book.js";
import { validateNovelWorkspace, validateTechnicalBookWorkspace } from "../src/lib/validation/longform.js";
import { addUserFeedback } from "../src/lib/ops/feedback.js";

const tempDirs: string[] = [];

async function makeWorkspace(config: Record<string, unknown>): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "longwrite-longform-"));
  tempDirs.push(dir);
  await fs.writeFile(path.join(dir, "longwrite.yaml"), stringifyYaml(config), "utf-8");
  return dir;
}

async function readJson<T>(workspace: string, rel: string): Promise<T> {
  return JSON.parse(await fs.readFile(path.join(workspace, rel), "utf-8")) as T;
}

afterEach(async () => {
  delete process.env.MALACLAW_UNIT_KEY;
  while (tempDirs.length > 0) await fs.rm(tempDirs.pop()!, { recursive: true, force: true });
});

describe("novel deterministic baseline", () => {
  it("creates bibles, chapter arcs, chapters, reviews, and a valid manuscript", async () => {
    const ws = await makeWorkspace({
      version: 1,
      project: { id: "novel", name: "Memory City", artifact_type: "novel", mode: "novel", authors: [{ name: "Ada Lovelace" }] },
      research: { provider: "seed", topic: "A city that externalizes memory" },
      writing: {
        target_length_words: 12000,
        genre: "speculative mystery",
        audience: "adult fiction readers",
        style_instructions: "quiet, concrete, precise",
        output_formats: ["markdown", "pdf"],
      },
    });

    await writeNovelStage(ws, ["project_brief.md"]);
    await writeNovelStage(ws, ["bibles/world_bible.md"]);
    await writeNovelStage(ws, ["bibles/character_bible.md"]);
    await writeNovelStage(ws, ["outline/plot_outline.md", "outline/chapter_arcs.json", "outline.json"]);
    const outline = await readJson<{ chapters: Array<{ id: string }> }>(ws, "outline.json");
    for (const chapter of outline.chapters) {
      await writeNovelStage(ws, [`chapters/${chapter.id}.md`]);
      await writeNovelStage(ws, [`reviews/${chapter.id}-continuity.md`]);
    }
    await writeNovelStage(ws, ["reviews/continuity-review.md"]);
    await writeNovelStage(ws, ["reviews/style-drift.md"]);
    await writeNovelStage(ws, ["build/manuscript.md"]);
    await fs.appendFile(path.join(ws, "chapters", outline.chapters[0].id + ".md"), "\n- 人物圣经校验：process note should not appear.\n");
    await addUserFeedback(ws, { message: "Make Mira's uncertainty more visible in chapter-003." });
    await writeNovelStage(ws, ["feedback/user-feedback.md", "feedback/revision-request.json", "reviews/revision-plan.md", "reports/metrics.json"]);
    process.env.MALACLAW_UNIT_KEY = "quality_loop-r1-revise";
    await writeNovelStage(ws, ["reviews/revision-report.md", "build/manuscript.md", "reports/metrics.json"]);
    delete process.env.MALACLAW_UNIT_KEY;

    const report = await validateNovelWorkspace(ws);
    expect(report.pass).toBe(true);
    const manuscript = await fs.readFile(path.join(ws, "build/manuscript.md"), "utf-8");
    expect(manuscript).toContain("By Ada Lovelace");
    expect(manuscript).toContain("Mira");
    expect(manuscript).not.toContain("人物圣经校验");
    expect(manuscript).not.toContain("Continuity Anchors");
    await fs.access(path.join(ws, "build", "preview.md"));
    await fs.access(path.join(ws, "build", "highlights.md"));
    await fs.access(path.join(ws, "build", "manuscript.pdf"));
    expect(await fs.readFile(path.join(ws, "chapters", outline.chapters[0].id + ".md"), "utf-8")).toContain("Revision Pass");
  });
});

describe("technical_book deterministic baseline", () => {
  it("creates reader profile, TOC contracts, examples, reviews, and a valid manuscript", async () => {
    const ws = await makeWorkspace({
      version: 1,
      project: { id: "book", artifact_type: "book", mode: "technical_book" },
      research: { provider: "seed", topic: "MalaClaw workflow orchestration" },
      writing: {
        target_length_words: 20000,
        audience: "platform engineers",
        style_instructions: "example-led and operational",
      },
    });

    await writeTechnicalBookStage(ws, ["reader_profile.md"]);
    await writeTechnicalBookStage(ws, ["outline/toc.md", "outline.json"]);
    await writeTechnicalBookStage(ws, ["outline/chapter_contracts.json"]);
    const outline = await readJson<{ chapters: Array<{ id: string }> }>(ws, "outline.json");
    for (const chapter of outline.chapters) {
      await writeTechnicalBookStage(ws, [`chapters/${chapter.id}.md`]);
    }
    await writeTechnicalBookStage(ws, ["reports/examples.md", "reports/code-validation.md"]);
    await writeTechnicalBookStage(ws, ["reviews/consistency-review.md"]);
    await writeTechnicalBookStage(ws, ["reports/edit-report.md"]);
    await writeTechnicalBookStage(ws, ["build/manuscript.md"]);
    await addUserFeedback(ws, { message: "Make examples more operational." });
    await writeTechnicalBookStage(ws, ["feedback/user-feedback.md", "feedback/revision-request.json", "reviews/revision-plan.md", "reports/metrics.json"]);
    process.env.MALACLAW_UNIT_KEY = "quality_loop-r1-revise";
    await writeTechnicalBookStage(ws, ["reviews/revision-report.md", "build/manuscript.md", "reports/metrics.json"]);
    delete process.env.MALACLAW_UNIT_KEY;

    const report = await validateTechnicalBookWorkspace(ws);
    expect(report.pass).toBe(true);
    expect(await fs.readFile(path.join(ws, "reports/code-validation.md"), "utf-8")).toContain("Status: pass");
  });
});

describe("feedback artifacts", () => {
  it("appends user feedback to the project feedback file", async () => {
    const ws = await makeWorkspace({
      version: 1,
      project: { id: "feedback", artifact_type: "novel", mode: "novel" },
    });
    await addUserFeedback(ws, { message: "Tighten the ending." });
    await addUserFeedback(ws, { message: "Add more scene texture." });
    const feedback = await fs.readFile(path.join(ws, "feedback", "user-feedback.md"), "utf-8");
    expect(feedback).toContain("Tighten the ending.");
    expect(feedback).toContain("Add more scene texture.");
  });
});

describe("bible-derived continuity helpers", () => {
  it("extracts character names from level-2 headings, skipping generic sections", async () => {
    const { bibleCharacterNames } = await import("../src/lib/validation/longform.js");
    const bible = "# Character Bible\n\n## Overview\n\n## Mira\n\nDetective.\n\n## Jon\n\nArchivist.\n\n## Relationships\n";
    expect(bibleCharacterNames(bible)).toEqual(["Mira", "Jon"]);
  });

  it("flags style drift only for >40% deviation from the median", async () => {
    const { styleDriftFindings } = await import("../src/lib/validation/longform.js");
    const uniform = (n: number) => Array.from({ length: n }, () => "One two three four five six seven. ").join("");
    const chapters = [
      { rel: "chapters/a.md", content: uniform(10) },
      { rel: "chapters/b.md", content: uniform(10) },
      { rel: "chapters/c.md", content: "Extremely long meandering sentences that go on and on with many words each time and never seem to stop at all here. ".repeat(10) },
    ];
    const findings = styleDriftFindings(chapters);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toContain("chapters/c.md");
    expect(styleDriftFindings(chapters.slice(0, 2))).toEqual([]); // <3 chapters: skip
  });
});

describe("artifact-type scorecard dimensions", () => {
  it("selects novel dimensions from longwrite.yaml artifact_type", async () => {
    const { dimensionsForArtifact } = await import("../src/lib/writing/scorecard.js");
    expect(dimensionsForArtifact("novel")).toContain("plot_coherence");
    expect(dimensionsForArtifact("technical_book")).toContain("example_quality");
    expect(dimensionsForArtifact("research_paper", "survey")).toContain("scope_coverage");
    expect(dimensionsForArtifact("research_paper", "survey")).not.toContain("experimental_validation");
    expect(dimensionsForArtifact("research_paper", "empirical")).toContain("experimental_validation");
    expect(dimensionsForArtifact(undefined)).toContain("novelty"); // fallback
  });

  it("validates and scores a novel scorecard against novel dimensions", async () => {
    const { scorecardSchema, computeReviewScore, dimensionsForArtifact } = await import("../src/lib/writing/scorecard.js");
    const dims = dimensionsForArtifact("novel");
    const card = scorecardSchema(dims).parse({
      personas: ["continuity-editor", "line-editor", "first-reader"].map((id) => ({
        id,
        scores: Object.fromEntries(dims.map((d) => [d, 6])),
        weaknesses: [{ category: "pacing", detail: "act two drags" }],
      })),
    });
    const result = computeReviewScore(card, [], dims);
    expect(result.reviewScore).toBe(6);
    expect(Object.keys(result.dimensionMedians)).toEqual([...dims]);
    // A research scorecard must NOT validate against novel dimensions.
    expect(scorecardSchema(dims).safeParse({
      personas: [{ id: "a", scores: { novelty: 6 } }],
    }).success).toBe(false);
  });
});

describe("CJK-aware length metrics", () => {
  it("detects CJK dominance and counts characters as words", async () => {
    const { isCjkDominant, textLength, meanSentenceLength } = await import("../src/lib/validation/longform.js");
    const zh = "雨停在凌晨四点十七分。林澈到旧城区的时候，路面还亮着一层薄水。他检查了门牌下方的记忆层编号。";
    expect(isCjkDominant(zh)).toBe(true);
    expect(isCjkDominant("The rain stopped at 4:17 in the morning.")).toBe(false);
    // ~40 CJK chars, not 1 whitespace "word".
    expect(textLength(zh)).toBeGreaterThan(30);
    // Sentences split on 。；characters averaged per sentence, not 200+.
    const mean = meanSentenceLength(zh.repeat(3));
    expect(mean).toBeGreaterThan(5);
    expect(mean).toBeLessThan(40);
  });

  it("does not flag style drift purely from CJK whitespace artifacts", async () => {
    const { styleDriftFindings } = await import("../src/lib/validation/longform.js");
    const evenChapter = (n: number) => ({
      rel: `chapters/chapter-00${n}.md`,
      content: "他沿着走廊走到尽头，在档案柜前停下。编号与记录不符。他把偏差写进复核单。".repeat(6),
    });
    expect(styleDriftFindings([evenChapter(1), evenChapter(2), evenChapter(3)])).toEqual([]);
  });
});

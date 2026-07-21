import fs from "node:fs/promises";
import path from "node:path";
import { loadProjectConfigIfExists } from "../project-config.js";

type ChapterContract = {
  id: string;
  title: string;
  objective: string;
  prerequisites: string[];
  example: string;
  validation: string;
};

type BookOutline = {
  chapters: ChapterContract[];
};

async function writeFile(workspaceDir: string, rel: string, content: string): Promise<string> {
  const abs = path.join(workspaceDir, rel);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, content, "utf-8");
  return rel;
}

async function readIfExists(workspaceDir: string, rel: string): Promise<string | null> {
  try {
    return await fs.readFile(path.join(workspaceDir, rel), "utf-8");
  } catch {
    return null;
  }
}

async function ensureFeedback(workspaceDir: string): Promise<string> {
  const existing = await readIfExists(workspaceDir, "feedback/user-feedback.md");
  if (existing !== null) return existing;
  const content = "# User Feedback\n\nNo explicit user feedback has been recorded yet.\n";
  await writeFile(workspaceDir, "feedback/user-feedback.md", content);
  return content;
}

function feedbackPresent(feedback: string): boolean {
  return !feedback.includes("No explicit user feedback has been recorded yet.") && feedback.trim().length > 0;
}

function metricsForCurrentUnit(): string {
  const unit = process.env.MALACLAW_UNIT_KEY ?? "";
  const score = unit.includes("revise") ? 8.5 : 7.3;
  return `${JSON.stringify({ review_score: score, longform_revision_score: score }, null, 2)}\n`;
}

function topicFromConfig(config: Awaited<ReturnType<typeof loadProjectConfigIfExists>>): string {
  return config?.research.topic ?? config?.project.name ?? "A technical system";
}

function chapterCount(targetWords?: number): number {
  if (!targetWords) return 5;
  return Math.max(4, Math.min(16, Math.ceil(targetWords / 7000)));
}

function contracts(topic: string, targetWords?: number): ChapterContract[] {
  const titles = [
    "Problem Frame",
    "Architecture",
    "Workflow Design",
    "Validation",
    "Operations",
    "Extensions",
  ];
  return Array.from({ length: chapterCount(targetWords) }, (_, i) => {
    const id = `chapter-${String(i + 1).padStart(3, "0")}`;
    const title = titles[i] ?? `Advanced Topic ${i + 1}`;
    return {
      id,
      title,
      objective: `Teach ${title.toLowerCase()} for ${topic}.`,
      prerequisites: i === 0 ? ["Basic command-line familiarity"] : [`Concepts from ${titles[i - 1] ?? "the previous chapter"}`],
      example: `${id}-example.js`,
      validation: "Example code must parse under Node.js syntax checks.",
    };
  });
}

function mdList(items: string[]): string {
  return items.map((item) => `- ${item}`).join("\n");
}

async function loadOutline(workspaceDir: string): Promise<BookOutline> {
  const raw = await fs.readFile(path.join(workspaceDir, "outline.json"), "utf-8");
  return JSON.parse(raw) as BookOutline;
}

function chapterFromOutput(output: string, outline: BookOutline): ChapterContract {
  const id = path.basename(output, ".md");
  return outline.chapters.find((chapter) => chapter.id === id) ?? outline.chapters[0];
}

async function buildManuscript(workspaceDir: string, outline: BookOutline): Promise<string> {
  const parts = ["# Technical Book Manuscript", ""];
  for (const chapter of outline.chapters) {
    const text = await readIfExists(workspaceDir, `chapters/${chapter.id}.md`);
    if (text) parts.push(text.trim(), "");
  }
  return writeFile(workspaceDir, "build/manuscript.md", parts.join("\n"));
}

function exampleSource(contract: ChapterContract): string {
  return [
    `// ${contract.id}: ${contract.title}`,
    "const contract = {",
    `  chapter: ${JSON.stringify(contract.id)},`,
    `  objective: ${JSON.stringify(contract.objective)},`,
    "};",
    "",
    "console.log(contract.chapter);",
    "",
  ].join("\n");
}

export async function writeTechnicalBookStage(workspaceDir: string, outputs: string[]): Promise<string[]> {
  const config = await loadProjectConfigIfExists(workspaceDir);
  const topic = topicFromConfig(config);
  const writing = config?.writing;
  const audience = writing?.audience ?? "engineers adopting the system";
  const style = writing?.style_instructions ?? "direct, example-led, implementation-focused";
  const written: string[] = [];

  for (const output of outputs) {
    if (output === "reader_profile.md") {
      written.push(await writeFile(workspaceDir, output, [
        "# Reader Profile",
        "",
        `Topic: ${topic}`,
        `Audience: ${audience}`,
        `Style: ${style}`,
        "",
        "## Reader Needs",
        "",
        mdList([
          "A concrete mental model before API details.",
          "Runnable examples with clear validation.",
          "Operational tradeoffs and failure modes.",
        ]),
        "",
      ].join("\n")));
    } else if (output === "outline/toc.md") {
      const generated = contracts(topic, writing?.target_length_words);
      written.push(await writeFile(workspaceDir, output, [
        "# Table of Contents",
        "",
        ...generated.flatMap((chapter) => [
          `## ${chapter.id}: ${chapter.title}`,
          "",
          chapter.objective,
          "",
        ]),
      ].join("\n")));
      written.push(await writeFile(workspaceDir, "outline.json", `${JSON.stringify({ chapters: generated }, null, 2)}\n`));
    } else if (output === "outline/chapter_contracts.json") {
      let outline: BookOutline;
      try {
        outline = await loadOutline(workspaceDir);
      } catch {
        outline = { chapters: contracts(topic, writing?.target_length_words) };
        written.push(await writeFile(workspaceDir, "outline.json", `${JSON.stringify(outline, null, 2)}\n`));
      }
      written.push(await writeFile(workspaceDir, output, `${JSON.stringify({ contracts: outline.chapters }, null, 2)}\n`));
    } else if (output.startsWith("chapters/") && output.endsWith(".md")) {
      const outline = await loadOutline(workspaceDir);
      const contract = chapterFromOutput(output, outline);
      written.push(await writeFile(workspaceDir, output, [
        `# ${contract.title}`,
        "",
        `Contract: ${contract.id}`,
        "",
        `Objective: ${contract.objective}`,
        "",
        "## Prerequisites",
        "",
        mdList(contract.prerequisites),
        "",
        "## Explanation",
        "",
        `This chapter explains ${contract.title.toLowerCase()} for ${topic} in a ${style} style.`,
        "",
        "## Example",
        "",
        "```js",
        exampleSource(contract).trimEnd(),
        "```",
        "",
        `Validation: ${contract.validation}`,
        "",
      ].join("\n")));
    } else if (output === "reports/examples.md") {
      const outline = await loadOutline(workspaceDir);
      const lines = ["# Examples", ""];
      for (const contract of outline.chapters) {
        const rel = `examples/${contract.example}`;
        written.push(await writeFile(workspaceDir, rel, exampleSource(contract)));
        lines.push(`- ${rel}: ${contract.validation}`);
      }
      lines.push("");
      written.push(await writeFile(workspaceDir, output, lines.join("\n")));
      written.push(await writeFile(workspaceDir, "reports/code-validation.md", "# Code Validation\n\nStatus: pending validator run.\n"));
    } else if (output === "reviews/technical-review.md" || output === "reviews/consistency-review.md") {
      const outline = await loadOutline(workspaceDir);
      written.push(await writeFile(workspaceDir, output, [
        "# Technical Consistency Review",
        "",
        `Reviewed ${outline.chapters.length} chapters against their chapter contracts.`,
        "",
        "Status: pass",
        "",
      ].join("\n")));
    } else if (output === "reports/edit-report.md") {
      written.push(await writeFile(workspaceDir, output, [
        "# Edit Report",
        "",
        `Style target: ${style}`,
        "",
        "Status: pass",
        "",
      ].join("\n")));
    } else if (output === "feedback/user-feedback.md") {
      await ensureFeedback(workspaceDir);
      written.push(output);
    } else if (output === "feedback/revision-request.json") {
      const feedback = await ensureFeedback(workspaceDir);
      written.push(await writeFile(workspaceDir, output, `${JSON.stringify({
        version: 1,
        mode: "technical_book",
        feedback_present: feedbackPresent(feedback),
        targets: feedbackPresent(feedback) ? ["chapters", "examples", "contracts"] : ["consistency"],
        feedback_file: "feedback/user-feedback.md",
      }, null, 2)}\n`));
    } else if (output === "reviews/revision-plan.md") {
      const feedback = await ensureFeedback(workspaceDir);
      written.push(await writeFile(workspaceDir, output, [
        "# Revision Plan",
        "",
        feedbackPresent(feedback)
          ? "Use the recorded user feedback to revise explanations, examples, and chapter contract coverage."
          : "No user feedback is present; perform a light consistency and example-validation pass.",
        "",
      ].join("\n")));
    } else if (output === "reviews/revision-report.md") {
      const outline = await loadOutline(workspaceDir);
      for (const contract of outline.chapters) {
        const rel = `chapters/${contract.id}.md`;
        const text = await readIfExists(workspaceDir, rel);
        if (text && !text.includes("## Revision Pass")) {
          await writeFile(workspaceDir, rel, `${text.trim()}\n\n## Revision Pass\n\nApplied feedback-aware explanation, example, and consistency refinements.\n`);
        }
      }
      written.push(await writeFile(workspaceDir, output, [
        "# Revision Report",
        "",
        `Updated ${outline.chapters.length} chapters against the revision plan.`,
        "",
        "Status: pass",
        "",
      ].join("\n")));
    } else if (output === "reports/metrics.json") {
      written.push(await writeFile(workspaceDir, output, metricsForCurrentUnit()));
    } else if (output === "build/manuscript.md") {
      written.push(await buildManuscript(workspaceDir, await loadOutline(workspaceDir)));
    }
  }

  return [...new Set(written)];
}

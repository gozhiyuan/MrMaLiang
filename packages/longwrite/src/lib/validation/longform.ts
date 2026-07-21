import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export type LongformCheck = {
  id: string;
  pass: boolean;
  findings: string[];
};

export type LongformValidationReport = {
  kind: "novel" | "technical_book";
  pass: boolean;
  checks: LongformCheck[];
};

async function readIfExists(workspaceDir: string, rel: string): Promise<string | null> {
  try {
    return await fs.readFile(path.join(workspaceDir, rel), "utf-8");
  } catch {
    return null;
  }
}

async function fileNonEmpty(workspaceDir: string, rel: string): Promise<boolean> {
  try {
    const stat = await fs.stat(path.join(workspaceDir, rel));
    return stat.isFile() && stat.size > 0;
  } catch {
    return false;
  }
}

async function parseJson<T>(workspaceDir: string, rel: string, findings: string[]): Promise<T | null> {
  const raw = await readIfExists(workspaceDir, rel);
  if (!raw) {
    findings.push(`${rel} is missing or empty`);
    return null;
  }
  try {
    return JSON.parse(raw) as T;
  } catch {
    findings.push(`${rel} is not valid JSON`);
    return null;
  }
}

function check(id: string, findings: string[]): LongformCheck {
  return { id, pass: findings.length === 0, findings };
}

/** Character names = level-2 headings of the character bible (excluding
 *  generic section headings). */
export function bibleCharacterNames(characterBible: string): string[] {
  return [...characterBible.matchAll(/^##\s+(.+)$/gm)]
    .map((match) => match[1].trim())
    .filter((name) => name.length > 0 && !/^(characters?|overview|notes|relationships)$/i.test(name));
}

const CJK_CHARS = /[\u3400-\u9fff\u3040-\u30ff\uac00-\ud7af]/g;

/** True when the text is dominated by CJK characters — whitespace-based
 *  word metrics are meaningless there (novel flagship finding #2). */
export function isCjkDominant(text: string): boolean {
  const cjk = text.match(CJK_CHARS)?.length ?? 0;
  const latinWords = text.split(/\s+/).filter((w) => /[a-zA-Z]/.test(w)).length;
  return cjk > latinWords * 2;
}

/** Length in "words": whitespace words for latin text, CJK characters plus
 *  latin words for CJK-dominant text (a character approximates a word). */
export function textLength(text: string): number {
  if (!isCjkDominant(text)) return text.split(/\s+/).filter(Boolean).length;
  const cjk = text.match(CJK_CHARS)?.length ?? 0;
  const latinWords = text.split(/\s+/).filter((w) => /[a-zA-Z0-9]/.test(w)).length;
  return cjk + latinWords;
}

export function meanSentenceLength(text: string): number {
  const cleaned = text.replace(/[#>*`_\[\]]/g, " ");
  const cjk = isCjkDominant(text);
  const sentences = (cjk ? cleaned.split(/[。！？；]+/) : cleaned.split(/[.!?]+\s/))
    .map((s) => s.trim())
    .filter((s) => (cjk ? textLength(s) >= 5 : s.split(/\s+/).length >= 3));
  if (sentences.length === 0) return 0;
  const units = sentences.reduce((sum, s) => sum + textLength(s), 0);
  return units / sentences.length;
}

/** Style-drift proxy: chapters whose mean sentence length deviates more than
 *  40% from the cross-chapter median. Deterministic and crude by design — it
 *  catches register jumps, not subtle voice issues. */
export function styleDriftFindings(chapters: Array<{ rel: string; content: string }>): string[] {
  if (chapters.length < 3) return [];
  const lengths = chapters.map((c) => ({ rel: c.rel, mean: meanSentenceLength(c.content) })).filter((c) => c.mean > 0);
  if (lengths.length < 3) return [];
  const sorted = [...lengths.map((l) => l.mean)].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  return lengths
    .filter((l) => Math.abs(l.mean - median) / median > 0.4)
    .map((l) => `style_drift: ${l.rel} mean sentence length ${l.mean.toFixed(1)} deviates >40% from manuscript median ${median.toFixed(1)}`);
}

async function configTargetLength(workspaceDir: string): Promise<number | undefined> {
  const raw = await readIfExists(workspaceDir, "longwrite.yaml");
  if (!raw) return undefined;
  // Cheap extraction: writing.target_length_words is a flat scalar.
  const match = raw.match(/target_length_words:\s*(\d+)/);
  const target = match ? Number(match[1]) : undefined;
  return target !== undefined && target > 0 ? target : undefined;
}

async function required(workspaceDir: string, files: string[]): Promise<LongformCheck> {
  const findings: string[] = [];
  for (const file of files) {
    if (!(await fileNonEmpty(workspaceDir, file))) findings.push(`${file} is missing or empty`);
  }
  return check("required_artifacts", findings);
}

type ChapterList = { chapters?: Array<{ id?: unknown; title?: unknown }> };

export async function validateNovelWorkspace(workspaceDir: string): Promise<LongformValidationReport> {
  const checks: LongformCheck[] = [];
  checks.push(await required(workspaceDir, [
    "project_brief.md",
    "bibles/world_bible.md",
    "bibles/character_bible.md",
    "outline/plot_outline.md",
    "outline/chapter_arcs.json",
    "outline.json",
    "reviews/continuity-review.md",
    "reviews/style-drift.md",
    "feedback/user-feedback.md",
    "feedback/revision-request.json",
    "reviews/revision-plan.md",
    "reviews/revision-report.md",
    "reports/metrics.json",
    "build/manuscript.md",
  ]));

  const outlineFindings: string[] = [];
  const outline = await parseJson<ChapterList>(workspaceDir, "outline.json", outlineFindings);
  const chapters = Array.isArray(outline?.chapters) ? outline.chapters : [];
  if (chapters.length === 0) outlineFindings.push("outline.json must contain a non-empty chapters array");
  for (const chapter of chapters) {
    if (typeof chapter.id !== "string" || chapter.id.length === 0) outlineFindings.push("each chapter needs a string id");
    if (typeof chapter.title !== "string" || chapter.title.length === 0) outlineFindings.push(`chapter ${String(chapter.id)} needs a title`);
  }
  checks.push(check("outline_chapter_arcs", outlineFindings));

  const coverageFindings: string[] = [];
  for (const chapter of chapters) {
    if (typeof chapter.id !== "string") continue;
    const rel = `chapters/${chapter.id}.md`;
    const text = await readIfExists(workspaceDir, rel);
    if (!text || text.trim().length === 0) coverageFindings.push(`${rel} is missing or empty`);
    if (text && !text.includes("## Continuity Anchors")) coverageFindings.push(`${rel} is missing continuity anchors`);
    const review = `reviews/${chapter.id}-continuity.md`;
    if (!(await fileNonEmpty(workspaceDir, review))) coverageFindings.push(`${review} is missing`);
  }
  checks.push(check("chapter_continuity_coverage", coverageFindings));

  // Character continuity is derived from the bible itself, not a fixed cast:
  // every '## <Name>' heading is a character, the manuscript must reference
  // the majority of them, and every chapter must mention at least one.
  const bibleFindings: string[] = [];
  const characterBible = await readIfExists(workspaceDir, "bibles/character_bible.md");
  const manuscript = await readIfExists(workspaceDir, "build/manuscript.md");
  const characters = characterBible ? bibleCharacterNames(characterBible) : [];
  if (characters.length < 2) {
    bibleFindings.push("bibles/character_bible.md must define at least 2 characters as '## <Name>' headings");
  }
  const referenced = characters.filter((name) => manuscript?.includes(name));
  if (characters.length >= 2 && referenced.length < Math.ceil(characters.length / 2)) {
    bibleFindings.push(
      `manuscript references only ${referenced.length}/${characters.length} bible characters (${characters.filter((n) => !referenced.includes(n)).join(", ")} unused)`,
    );
  }
  const chapterTexts: Array<{ rel: string; content: string }> = [];
  for (const chapter of chapters) {
    if (typeof chapter.id !== "string") continue;
    const rel = `chapters/${chapter.id}.md`;
    const text = await readIfExists(workspaceDir, rel);
    if (!text) continue;
    chapterTexts.push({ rel, content: text });
    if (characters.length >= 2 && !characters.some((name) => text.includes(name))) {
      bibleFindings.push(`character_continuity: ${rel} mentions no character from the bible`);
    }
  }
  checks.push(check("character_continuity", bibleFindings));

  // Target length and style drift are ADVISORY: they surface findings for
  // the review loop and the report but never fail the build — deterministic
  // scaffolds are legitimately short, and stylistic variation can be a
  // choice. The reviewer personas decide whether the advisories matter.
  const lengthFindings: string[] = [];
  const target = await configTargetLength(workspaceDir);
  if (target !== undefined && chapterTexts.length > 0) {
    const total = chapterTexts.reduce((sum, c) => sum + textLength(c.content), 0);
    if (total < target * 0.5 || total > target * 1.5) {
      lengthFindings.push(
        `advisory: manuscript is ${total} words; target ${target} (accepted ${Math.round(target * 0.5)}-${Math.round(target * 1.5)})`,
      );
    }
  }
  checks.push({ id: "target_length", pass: true, findings: lengthFindings });

  checks.push({
    id: "style_drift",
    pass: true,
    findings: styleDriftFindings(chapterTexts).map((f) => `advisory: ${f}`),
  });

  return { kind: "novel", checks, pass: checks.every((entry) => entry.pass) };
}

type ContractList = { contracts?: Array<{ id?: unknown; title?: unknown; example?: unknown; validation?: unknown }> };

export async function validateTechnicalBookWorkspace(workspaceDir: string): Promise<LongformValidationReport> {
  const checks: LongformCheck[] = [];
  checks.push(await required(workspaceDir, [
    "reader_profile.md",
    "outline/toc.md",
    "outline.json",
    "outline/chapter_contracts.json",
    "reports/examples.md",
    "reports/code-validation.md",
    "reviews/consistency-review.md",
    "reports/edit-report.md",
    "feedback/user-feedback.md",
    "feedback/revision-request.json",
    "reviews/revision-plan.md",
    "reviews/revision-report.md",
    "reports/metrics.json",
    "build/manuscript.md",
  ]));

  const contractFindings: string[] = [];
  const parsed = await parseJson<ContractList>(workspaceDir, "outline/chapter_contracts.json", contractFindings);
  const contracts = Array.isArray(parsed?.contracts) ? parsed.contracts : [];
  if (contracts.length === 0) contractFindings.push("chapter_contracts.json must contain a non-empty contracts array");
  for (const contract of contracts) {
    if (typeof contract.id !== "string" || contract.id.length === 0) contractFindings.push("each contract needs a string id");
    if (typeof contract.title !== "string" || contract.title.length === 0) contractFindings.push(`contract ${String(contract.id)} needs a title`);
    if (typeof contract.example !== "string" || contract.example.length === 0) contractFindings.push(`contract ${String(contract.id)} needs an example`);
    if (typeof contract.validation !== "string" || contract.validation.length === 0) contractFindings.push(`contract ${String(contract.id)} needs validation`);
  }
  checks.push(check("chapter_contracts", contractFindings));

  const chapterFindings: string[] = [];
  for (const contract of contracts) {
    if (typeof contract.id !== "string") continue;
    const rel = `chapters/${contract.id}.md`;
    const text = await readIfExists(workspaceDir, rel);
    if (!text) {
      chapterFindings.push(`${rel} is missing`);
      continue;
    }
    if (!text.includes(`Contract: ${contract.id}`)) chapterFindings.push(`${rel} does not name its contract id`);
    if (!text.includes("```js")) chapterFindings.push(`${rel} does not include a JavaScript example block`);
  }
  checks.push(check("chapter_contract_coverage", chapterFindings));

  const codeFindings: string[] = [];
  let exampleNames: string[];
  try {
    exampleNames = (await fs.readdir(path.join(workspaceDir, "examples"))).filter((entry) => entry.endsWith(".js")).sort();
  } catch {
    exampleNames = [];
  }
  for (const contract of contracts) {
    if (typeof contract.example !== "string") continue;
    if (!exampleNames.includes(contract.example)) {
      codeFindings.push(`examples/${contract.example} is missing`);
      continue;
    }
    try {
      await execFileAsync(process.execPath, ["--check", path.join(workspaceDir, "examples", contract.example)], {
        timeout: 30_000,
      });
    } catch (err) {
      codeFindings.push(`examples/${contract.example} failed node --check: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  if (codeFindings.length === 0) {
    await fs.mkdir(path.join(workspaceDir, "reports"), { recursive: true });
    await fs.writeFile(
      path.join(workspaceDir, "reports", "code-validation.md"),
      `# Code Validation\n\nStatus: pass\n\nChecked ${exampleNames.length} JavaScript example files with node --check.\n`,
      "utf-8",
    );
  }
  checks.push(check("code_validation", codeFindings));

  return { kind: "technical_book", checks, pass: checks.every((entry) => entry.pass) };
}

export function longformReportToMarkdown(report: LongformValidationReport): string {
  const lines = [
    "# LongWrite Long-Form Validation Report",
    "",
    `Kind: ${report.kind}`,
    `Status: ${report.pass ? "pass" : "fail"}`,
    "",
  ];
  for (const check of report.checks) {
    lines.push(`## ${check.id}`, "", `Status: ${check.pass ? "pass" : "fail"}`, "");
    if (check.findings.length === 0) lines.push("- No findings.", "");
    else lines.push(...check.findings.map((finding) => `- ${finding}`), "");
  }
  return `${lines.join("\n")}\n`;
}

export async function writeLongformValidationReport(
  workspaceDir: string,
  report: LongformValidationReport,
): Promise<string[]> {
  await fs.mkdir(path.join(workspaceDir, "reports"), { recursive: true });
  await fs.writeFile(path.join(workspaceDir, "reports", "longwrite-validation.json"), `${JSON.stringify(report, null, 2)}\n`, "utf-8");
  await fs.writeFile(path.join(workspaceDir, "reports", "longwrite-validation.md"), longformReportToMarkdown(report), "utf-8");
  return ["reports/longwrite-validation.json", "reports/longwrite-validation.md"];
}

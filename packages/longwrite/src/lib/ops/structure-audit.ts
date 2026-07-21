import fs from "node:fs/promises";
import path from "node:path";

const EXPECTED_SURVEY_AREAS = ["introduction", "background", "taxonomy", "comparison", "limitation", "future", "conclusion"];

/** A transparent structural audit. It reports gaps for the reviewer/router;
 * it does not pretend that keyword presence proves scholarly quality. */
export async function auditSurveyStructure(workspaceDir: string): Promise<{ pass: boolean; written: string[] }> {
  const outlinePath = path.join(workspaceDir, "outline.json");
  const raw = JSON.parse(await fs.readFile(outlinePath, "utf-8")) as { sections?: Array<{ id?: unknown; title?: unknown; keywords?: unknown }> };
  const sections = Array.isArray(raw.sections) ? raw.sections.filter((section): section is { id: string; title: string; keywords?: unknown } =>
    typeof section?.id === "string" && typeof section?.title === "string",
  ) : [];
  const titles = sections.map((section) => section.title.toLowerCase()).join(" ");
  const missingAreas = EXPECTED_SURVEY_AREAS.filter((area) => !titles.includes(area));
  const malformed = sections.filter((section) => section.title.trim().length < 3).map((section) => section.id);
  const report = {
    version: 1,
    sections: sections.length,
    expected_areas: EXPECTED_SURVEY_AREAS,
    missing_areas: missingAreas,
    malformed_section_ids: malformed,
    pass: sections.length >= 4 && malformed.length === 0,
  };
  const markdown = [
    "# Survey Structure Audit", "", `Status: ${report.pass ? "pass" : "review required"}`, "",
    `- Valid outline sections: ${sections.length}`,
    `- Missing standard survey areas (keyword heuristic): ${missingAreas.join(", ") || "none"}`,
    `- Malformed titles: ${malformed.join(", ") || "none"}`,
    "", "This is a deterministic prompt for human/LLM review, not proof that a manuscript has intellectual novelty.", "",
  ].join("\n");
  await fs.mkdir(path.join(workspaceDir, "reports"), { recursive: true });
  await Promise.all([
    fs.writeFile(path.join(workspaceDir, "reports", "structure-audit.json"), `${JSON.stringify(report, null, 2)}\n`, "utf-8"),
    fs.writeFile(path.join(workspaceDir, "reports", "structure-audit.md"), markdown, "utf-8"),
  ]);
  return { pass: report.pass, written: ["reports/structure-audit.json", "reports/structure-audit.md"] };
}

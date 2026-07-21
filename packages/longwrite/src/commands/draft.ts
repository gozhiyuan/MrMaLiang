import path from "node:path";
import { draftSectionWorkspace } from "../lib/writing/draft.js";
import { writeNovelStage } from "../lib/writing/novel.js";
import { writeTechnicalBookStage } from "../lib/writing/technical-book.js";

function declaredOutputs(): string[] {
  const raw = process.env.MALACLAW_STAGE_OUTPUTS;
  if (!raw) return [];
  const parsed = JSON.parse(raw) as unknown;
  if (!Array.isArray(parsed) || !parsed.every((value) => typeof value === "string")) {
    throw new Error("MALACLAW_STAGE_OUTPUTS must be a JSON string array");
  }
  return parsed;
}

export async function runDraftSection(workspaceDir: string): Promise<void> {
  const written = await draftSectionWorkspace(path.resolve(workspaceDir), declaredOutputs());
  console.log(`Drafted section in ${path.resolve(workspaceDir)}`);
  for (const file of written) console.log(`  + ${file}`);
}

export async function runDraftNovel(workspaceDir: string): Promise<void> {
  const written = await writeNovelStage(path.resolve(workspaceDir), declaredOutputs());
  console.log(`Updated novel artifacts in ${path.resolve(workspaceDir)}`);
  for (const file of written) console.log(`  + ${file}`);
}

export async function runDraftTechnicalBook(workspaceDir: string): Promise<void> {
  const written = await writeTechnicalBookStage(path.resolve(workspaceDir), declaredOutputs());
  console.log(`Updated technical-book artifacts in ${path.resolve(workspaceDir)}`);
  for (const file of written) console.log(`  + ${file}`);
}

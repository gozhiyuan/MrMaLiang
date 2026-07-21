import path from "node:path";
import { writeReviewPacket } from "../lib/ops/packet.js";
import { writeScheduleReport } from "../lib/ops/schedule.js";
import { writeDailyDigest } from "../lib/ops/status.js";

export async function runReportDaily(workspaceDir: string): Promise<void> {
  const written = await writeDailyDigest(workspaceDir);
  console.log(`Wrote daily digest for ${path.resolve(workspaceDir)}`);
  console.log(`  + ${written}`);
}

export async function runReportSchedule(workspaceDir: string): Promise<void> {
  const written = await writeScheduleReport(workspaceDir);
  console.log(`Wrote schedule helper for ${path.resolve(workspaceDir)}`);
  console.log(`  + ${written}`);
}

export async function runReportPacket(workspaceDir: string): Promise<void> {
  const written = await writeReviewPacket(workspaceDir);
  console.log(`Wrote human review packet for ${path.resolve(workspaceDir)}`);
  console.log(`  + ${written}`);
}

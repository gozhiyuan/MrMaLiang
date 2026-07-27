import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { z } from "zod";

/** The portable scientific parent/child record. Git owns code; this owns decisions. */
export const LineageNode = z.object({
  id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/),
  parent_id: z.string().nullable(),
  round_id: z.string().min(1),
  kind: z.enum(["baseline", "candidate", "champion", "dead_end"]),
  hypothesis_id: z.string().min(1).optional(),
  branch: z.string().min(1),
  commit_sha: z.string().regex(/^[a-f0-9]{7,64}$/),
  status: z.enum(["planned", "materialized", "submitted", "running", "completed", "failed", "cancelled", "promoted", "discarded"]),
  primary_metric: z.number().finite().optional(),
  confidence: z.object({
    lower: z.number().finite(), upper: z.number().finite(), level: z.number().gt(0).lte(1),
  }).strict().optional(),
  decision: z.enum(["keep", "discard", "crash", "promote", "stop"]).optional(),
  decision_reason: z.string().min(1).optional(),
  complexity_score: z.number().nonnegative().optional(),
  result_artifact: z.string().min(1).optional(),
}).strict();
export type LineageNode = z.infer<typeof LineageNode>;

export const LineageRound = z.object({
  id: z.string().min(1),
  parent_node_id: z.string().min(1),
  proposal_ids: z.array(z.string().min(1)),
  candidate_node_ids: z.array(z.string().min(1)),
  winner_node_id: z.string().min(1).nullable(),
  started_at: z.string().datetime(),
  completed_at: z.string().datetime().optional(),
}).strict();
export type LineageRound = z.infer<typeof LineageRound>;

export const LineageGraph = z.object({
  version: z.literal(1),
  baseline_node_id: z.string().min(1),
  champion_node_id: z.string().min(1),
  nodes: z.array(LineageNode).min(1),
  rounds: z.array(LineageRound),
}).strict().superRefine((graph, ctx) => {
  const ids = new Set<string>();
  for (const [index, node] of graph.nodes.entries()) {
    if (ids.has(node.id)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["nodes", index, "id"], message: `duplicate lineage node ${node.id}` });
    ids.add(node.id);
  }
  for (const [index, node] of graph.nodes.entries()) {
    if (node.parent_id && !ids.has(node.parent_id)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["nodes", index, "parent_id"], message: `unknown parent ${node.parent_id}` });
  }
  if (!ids.has(graph.baseline_node_id)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["baseline_node_id"], message: "baseline node is missing" });
  if (!ids.has(graph.champion_node_id)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["champion_node_id"], message: "champion node is missing" });
  for (const [index, round] of graph.rounds.entries()) {
    if (!ids.has(round.parent_node_id)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["rounds", index, "parent_node_id"], message: "round parent is missing" });
    if (round.winner_node_id && !round.candidate_node_ids.includes(round.winner_node_id)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["rounds", index, "winner_node_id"], message: "winner must be a candidate in this round" });
  }
});
export type LineageGraph = z.infer<typeof LineageGraph>;

export const LINEAGE_PATH = path.join("runs", "lineage.json");

function lineagePath(workspaceDir: string): string { return path.join(workspaceDir, LINEAGE_PATH); }
function now(): string { return new Date().toISOString(); }

async function writeAtomic(target: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(target), { recursive: true });
  const temp = path.join(path.dirname(target), `.${path.basename(target)}.${process.pid}.${crypto.randomUUID()}.tmp`);
  try {
    await fs.writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, "utf-8");
    await fs.rename(temp, target);
  } finally {
    await fs.rm(temp, { force: true }).catch(() => undefined);
  }
}

export async function readLineage(workspaceDir: string): Promise<LineageGraph> {
  return LineageGraph.parse(JSON.parse(await fs.readFile(lineagePath(workspaceDir), "utf-8")));
}

async function updateLineage(workspaceDir: string, update: (graph: LineageGraph) => LineageGraph): Promise<LineageGraph> {
  const graph = update(await readLineage(workspaceDir));
  const checked = LineageGraph.parse(graph);
  await writeAtomic(lineagePath(workspaceDir), checked);
  return checked;
}

export async function initializeLineage(workspaceDir: string, baseline: Omit<LineageNode, "parent_id" | "kind">): Promise<LineageGraph> {
  const target = lineagePath(workspaceDir);
  try { return await readLineage(workspaceDir); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const node = LineageNode.parse({ ...baseline, parent_id: null, kind: "baseline" });
  const graph = LineageGraph.parse({ version: 1, baseline_node_id: node.id, champion_node_id: node.id, nodes: [node], rounds: [] });
  await writeAtomic(target, graph);
  return graph;
}

export async function addCandidateNode(workspaceDir: string, node: Omit<LineageNode, "kind"> & { kind?: "candidate" }): Promise<LineageGraph> {
  return updateLineage(workspaceDir, (graph) => {
    if (graph.nodes.some((existing) => existing.id === node.id)) throw new Error(`lineage node already exists: ${node.id}`);
    if (!node.parent_id || !graph.nodes.some((existing) => existing.id === node.parent_id)) throw new Error(`candidate ${node.id} must name an existing parent`);
    if (!graph.rounds.some((round) => round.id === node.round_id)) throw new Error(`candidate ${node.id} names unknown round ${node.round_id}`);
    return {
      ...graph,
      nodes: [...graph.nodes, LineageNode.parse({ ...node, kind: "candidate" })],
      rounds: graph.rounds.map((round) => round.id === node.round_id
        ? { ...round, candidate_node_ids: [...round.candidate_node_ids, node.id] }
        : round),
    };
  });
}

export async function recordRunStatus(workspaceDir: string, nodeId: string, status: LineageNode["status"]): Promise<LineageGraph> {
  return updateLineage(workspaceDir, (graph) => ({ ...graph, nodes: graph.nodes.map((node) => node.id === nodeId ? { ...node, status } : node) }));
}

export async function recordCandidateResult(workspaceDir: string, nodeId: string, result: Pick<LineageNode, "primary_metric" | "confidence" | "complexity_score" | "result_artifact">): Promise<LineageGraph> {
  return updateLineage(workspaceDir, (graph) => ({ ...graph, nodes: graph.nodes.map((node) => node.id === nodeId ? { ...node, ...result, status: "completed" } : node) }));
}

/** Bind a candidate to the immutable commit its implementation produced.
 *  A candidate is only evidence once its code is a real commit. */
export async function recordCandidateCommit(workspaceDir: string, nodeId: string, commitSha: string): Promise<LineageGraph> {
  return updateLineage(workspaceDir, (graph) => {
    if (!graph.nodes.some((node) => node.id === nodeId)) throw new Error(`unknown lineage node ${nodeId}`);
    return { ...graph, nodes: graph.nodes.map((node) => node.id === nodeId ? { ...node, commit_sha: commitSha } : node) };
  });
}

export async function promoteChampion(workspaceDir: string, nodeId: string, reason: string): Promise<LineageGraph> {
  return updateLineage(workspaceDir, (graph) => {
    const node = graph.nodes.find((candidate) => candidate.id === nodeId);
    if (!node) throw new Error(`unknown lineage node ${nodeId}`);
    if (node.status !== "completed" && node.status !== "promoted") throw new Error(`only completed candidates can be promoted (${nodeId} is ${node.status})`);
    return {
      ...graph,
      champion_node_id: nodeId,
      nodes: graph.nodes.map((candidate) => candidate.id === nodeId
        ? { ...candidate, kind: "champion", status: "promoted", decision: "promote", decision_reason: reason }
        : candidate),
    };
  });
}

export async function markDeadEnd(workspaceDir: string, nodeId: string, decision: Extract<LineageNode["decision"], "discard" | "crash" | "stop">, reason: string): Promise<LineageGraph> {
  return updateLineage(workspaceDir, (graph) => {
    if (!graph.nodes.some((node) => node.id === nodeId)) throw new Error(`unknown lineage node ${nodeId}`);
    return {
      ...graph,
      nodes: graph.nodes.map((node) => node.id === nodeId ? {
        ...node, kind: "dead_end", status: decision === "crash" ? "failed" : "discarded", decision, decision_reason: reason,
      } : node),
    };
  });
}

export async function startRound(workspaceDir: string, round: Omit<LineageRound, "candidate_node_ids" | "winner_node_id" | "started_at" | "completed_at"> & Partial<Pick<LineageRound, "started_at">>): Promise<LineageGraph> {
  return updateLineage(workspaceDir, (graph) => {
    if (graph.rounds.some((existing) => existing.id === round.id)) throw new Error(`lineage round already exists: ${round.id}`);
    if (graph.champion_node_id !== round.parent_node_id) throw new Error("a new round must start from the current champion");
    return { ...graph, rounds: [...graph.rounds, LineageRound.parse({ ...round, candidate_node_ids: [], winner_node_id: null, started_at: round.started_at ?? now() })] };
  });
}

export async function completeRound(workspaceDir: string, roundId: string, winnerNodeId: string | null): Promise<LineageGraph> {
  return updateLineage(workspaceDir, (graph) => ({
    ...graph,
    rounds: graph.rounds.map((round) => round.id === roundId
      ? { ...round, winner_node_id: winnerNodeId, completed_at: now() }
      : round),
  }));
}

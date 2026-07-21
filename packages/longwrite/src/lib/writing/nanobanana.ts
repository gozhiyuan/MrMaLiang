import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { loadProjectConfigIfExists } from "../project-config.js";

/** Nano Banana (Gemini image generation) figure backend — the only PAID
 *  backend, therefore optional, budget-gated, and approval-gated:
 *
 *  - runs only when longwrite.yaml sets figures.backends.nanobanana.enabled
 *  - requires_approval (default true): the operator must create
 *    figures/nanobanana.approved or set LONGWRITE_NANOBANANA_APPROVED=1
 *  - budget_usd caps the number of generated images
 *  - a missing API key is a clear skip message, never a crash
 *  - generated images enter the manifest only when actually produced,
 *    each with a provenance record (model, prompt hash, timestamp)
 */

export type NanobananaStatus = {
  backend: "nanobanana";
  enabled: boolean;
  ran: boolean;
  detail: string;
  rendered: string[];
  image?: { path: string; provenancePath: string; mimeType: string; model: string; promptHash: string };
};

const EST_COST_PER_IMAGE_USD = 0.05;
const DEFAULT_MODEL = "gemini-2.5-flash-image";
const RENDER_TIMEOUT_MS = 120_000;

function apiKey(): string | undefined {
  return process.env.LONGWRITE_NANOBANANA_API_KEY
    ?? process.env.MALACLAW_GEMINI_API_KEY
    ?? process.env.GEMINI_API_KEY
    ?? process.env.GOOGLE_API_KEY;
}

function baseUrl(): string {
  return (process.env.LONGWRITE_NANOBANANA_BASE_URL ?? "https://generativelanguage.googleapis.com").replace(/\/+$/, "");
}

async function readIfExists(absPath: string): Promise<string | null> {
  try {
    return await fs.readFile(absPath, "utf-8");
  } catch {
    return null;
  }
}

async function approvalGranted(workspaceDir: string): Promise<boolean> {
  if (process.env.LONGWRITE_NANOBANANA_APPROVED === "1") return true;
  return (await readIfExists(path.join(workspaceDir, "figures", "nanobanana.approved"))) !== null;
}

/** Concept-figure prompt grounded in workspace context, per the contract:
 *  figure plan + brief; deterministic given the workspace. */
export async function conceptFigurePrompt(workspaceDir: string): Promise<string> {
  const plan = (await readIfExists(path.join(workspaceDir, "figures", "figure-plan.md")) ?? "").slice(0, 2_000);
  const brief = (await readIfExists(path.join(workspaceDir, "project_brief.md")) ?? "").slice(0, 1_500);
  const placement = (await readIfExists(path.join(workspaceDir, "figures", "placement-plan.json")) ?? "").slice(0, 2_000);
  const actionPlan = (await readIfExists(path.join(workspaceDir, "reviews", "action-plan.json")) ?? "").slice(0, 1_500);
  return [
    "Create a single clean conceptual illustration for a long-form research manuscript.",
    "Style: flat editorial systems illustration, restrained palette, no text, labels, logos, data marks, citations, or decorative stock-art motifs.",
    "It is a conceptual aid, not empirical evidence: do not imply measurements, results, or claims not present in the manuscript context.",
    "",
    "Manuscript brief:",
    brief,
    "",
    "Figure plan context:",
    plan,
    "",
    "Current visual-placement contract:",
    placement,
    ...(actionPlan ? ["", "Current remediation context (follow only visual intent):", actionPlan] : []),
  ].join("\n");
}

type GeminiImageResponse = {
  candidates?: Array<{ content?: { parts?: Array<{ inlineData?: { mimeType?: string; data?: string }; inline_data?: { mime_type?: string; data?: string } }> } }>;
};

function imageExtension(mimeType: string | undefined): string | null {
  if (mimeType === "image/png") return "png";
  if (mimeType === "image/jpeg") return "jpg";
  if (mimeType === "image/webp") return "webp";
  return null;
}

export async function runNanobanana(workspaceDir: string): Promise<NanobananaStatus> {
  const config = await loadProjectConfigIfExists(workspaceDir);
  const settings = config?.figures?.backends?.nanobanana;
  if (!settings?.enabled) {
    return { backend: "nanobanana", enabled: false, ran: false, rendered: [], detail: "disabled (figures.backends.nanobanana.enabled: false)" };
  }
  if (settings.budget_usd < EST_COST_PER_IMAGE_USD) {
    return {
      backend: "nanobanana", enabled: true, ran: false, rendered: [],
      detail: `budget_usd ${settings.budget_usd} is below the estimated per-image cost (${EST_COST_PER_IMAGE_USD}); skipping`,
    };
  }
  if (settings.requires_approval && !(await approvalGranted(workspaceDir))) {
    return {
      backend: "nanobanana", enabled: true, ran: false, rendered: [],
      detail: "awaiting approval: create figures/nanobanana.approved (or set LONGWRITE_NANOBANANA_APPROVED=1) to authorize paid image generation",
    };
  }
  const key = apiKey();
  if (!key) {
    return {
      backend: "nanobanana", enabled: true, ran: false, rendered: [],
      detail: "no API key: set GEMINI_API_KEY (or GOOGLE_API_KEY / LONGWRITE_NANOBANANA_API_KEY); skipping without failing the build",
    };
  }

  const model = settings.model ?? DEFAULT_MODEL;
  const prompt = await conceptFigurePrompt(workspaceDir);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), RENDER_TIMEOUT_MS);
  try {
    const response = await fetch(`${baseUrl()}/v1beta/models/${model}:generateContent`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-goog-api-key": key },
      signal: controller.signal,
      body: JSON.stringify({ contents: [{ role: "user", parts: [{ text: prompt }] }] }),
    });
    const text = await response.text();
    if (!response.ok) {
      return {
        backend: "nanobanana", enabled: true, ran: true, rendered: [],
        detail: `generation failed: HTTP ${response.status} ${text.slice(0, 300)}`,
      };
    }
    const parsed = JSON.parse(text) as GeminiImageResponse;
    const part = parsed.candidates?.[0]?.content?.parts?.find((p) => p.inlineData?.data || p.inline_data?.data);
    const data = part?.inlineData?.data ?? part?.inline_data?.data;
    const mimeType = part?.inlineData?.mimeType ?? part?.inline_data?.mime_type;
    if (!data) {
      return { backend: "nanobanana", enabled: true, ran: true, rendered: [], detail: "response contained no image data" };
    }
    const extension = imageExtension(mimeType);
    if (!extension) {
      return { backend: "nanobanana", enabled: true, ran: true, rendered: [], detail: `response used unsupported image MIME type ${mimeType ?? "unknown"}` };
    }

    await fs.mkdir(path.join(workspaceDir, "figures"), { recursive: true });
    const imageRel = `figures/concept.${extension}`;
    await fs.writeFile(path.join(workspaceDir, imageRel), Buffer.from(data, "base64"));
    const provenanceRel = "figures/concept-provenance.json";
    const promptHash = crypto.createHash("sha256").update(prompt).digest("hex");
    await fs.writeFile(
      path.join(workspaceDir, provenanceRel),
      JSON.stringify({
        backend: "nanobanana",
        model,
        prompt_sha256: promptHash,
        estimated_cost_usd: EST_COST_PER_IMAGE_USD,
        created_at: new Date().toISOString(),
      }, null, 2),
      "utf-8",
    );
    return {
      backend: "nanobanana", enabled: true, ran: true,
      rendered: [imageRel, provenanceRel],
      detail: `rendered ${imageRel} with ${model}`,
      image: { path: imageRel, provenancePath: provenanceRel, mimeType: mimeType!, model, promptHash },
    };
  } catch (err) {
    return {
      backend: "nanobanana", enabled: true, ran: true, rendered: [],
      detail: `generation error: ${err instanceof Error ? err.message : String(err)}`,
    };
  } finally {
    clearTimeout(timeout);
  }
}

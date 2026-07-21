import * as clack from "@clack/prompts";
import { loadAllModes } from "../lib/modes.js";
import { loadAllRuntimeProfiles } from "../lib/runtime-profiles.js";
import type { InitCommandOptions } from "./init.js";

/** True when the wizard should run: an interactive terminal and the user
 *  didn't already say what they want to write about (or forced it with -i). */
export function shouldRunWizard(opts: InitCommandOptions & { interactive?: boolean }): boolean {
  if (opts.interactive) return true;
  if (!process.stdin.isTTY || !process.stdout.isTTY) return false;
  return opts.topic === undefined;
}

function bail(value: unknown): asserts value is string | boolean {
  if (clack.isCancel(value)) {
    clack.cancel("Init cancelled — nothing was written.");
    process.exit(0);
  }
}

/** Interactive prompts. Flags the user already passed become defaults, so
 *  `longwrite init dir --mode novel` still asks only the open questions. */
export async function runInitWizard(
  targetDir: string,
  opts: InitCommandOptions,
): Promise<InitCommandOptions> {
  clack.intro(`longwrite init ${targetDir}`);

  const modes = await loadAllModes();
  const runtimeProfiles = await loadAllRuntimeProfiles();
  const mode = await clack.select({
    message: "Writing mode",
    initialValue: opts.mode ?? "auto_research_agentic",
    options: modes.map((m) => ({
      value: m.id,
      label: m.name,
      hint: m.artifact_type,
    })),
  });
  bail(mode);

  const topic = await clack.text({
    message: "Topic (what should this project write about?)",
    placeholder: "Long-horizon memory and planning in LLM agents",
    initialValue: opts.topic ?? "",
    validate: (v) => ((v ?? "").trim().length === 0 ? "A topic is required" : undefined),
  });
  bail(topic);

  const selected = modes.find((m) => m.id === mode);
  const targetLengthWords = await clack.text({
    message: "Target length in words",
    placeholder: selected?.artifact_type === "novel" ? "60000" : selected?.artifact_type === "book" ? "40000" : selected?.id === "auto_research_agentic" ? "24000" : "8000",
    initialValue: opts.targetLengthWords ?? "",
    validate: (v) => ((v ?? "").trim().length === 0 || (/^\d+$/.test(v ?? "") && Number(v) > 0) ? undefined : "Positive integer"),
  });
  bail(targetLengthWords);

  const audience = await clack.text({
    message: "Audience / reader profile (optional: who the writing is for)",
    placeholder: selected?.artifact_type === "novel"
      ? "Adult readers who like character-driven speculative fiction"
      : selected?.artifact_type === "research_paper"
        ? "LLM agent researchers and senior AI engineers"
        : "Engineers adopting the system",
    initialValue: opts.audience ?? "",
  });
  bail(audience);

  const genre = await clack.text({
    message: selected?.artifact_type === "novel"
      ? "Genre / subgenre (optional)"
      : "Category / writing type (optional)",
    placeholder: selected?.artifact_type === "novel"
      ? "speculative mystery"
      : selected?.artifact_type === "research_paper"
        ? "technical survey"
        : "implementation guide",
    initialValue: opts.genre ?? "",
  });
  bail(genre);

  const style = await clack.text({
    message: "Style instructions",
    placeholder: "Concise, rigorous, practical; avoid hype.",
    initialValue: opts.style ?? "",
  });
  bail(style);

  const runtimeProfile = await clack.select({
    message: "Runtime strategy",
    initialValue: opts.runtimeProfile ?? "default",
    options: [
      { value: "default", label: "Default", hint: "safest first choice; use the runtime you pass to longwrite run" },
      ...runtimeProfiles.map((profile) => ({
        value: profile.id,
        label: profile.name,
        hint: profile.description ?? profile.id,
      })),
    ],
  });
  bail(runtimeProfile);

  let researchProvider = opts.researchProvider;
  let researchPaperKind = opts.researchPaperKind;
  let researchWorkflowProfile = opts.researchWorkflowProfile;
  if (selected?.artifact_type === "research_paper") {
    const provider = await clack.select({
      message: "Research provider",
      initialValue: opts.researchProvider ?? "arxiv",
      options: [
        { value: "multi", label: "Multi (arXiv + DBLP + Crossref)", hint: "keyless fanout, deduped downstream" },
        { value: "arxiv", label: "arXiv", hint: "keyless API, real papers" },
        { value: "semantic_scholar", label: "Semantic Scholar", hint: "broader index, rate-limited without key" },
        { value: "dblp", label: "DBLP", hint: "keyless CS bibliography metadata" },
        { value: "crossref", label: "Crossref", hint: "keyless DOI and publisher metadata" },
        { value: "seed", label: "Seed file", hint: "you provide sources/seed_sources.jsonl" },
      ],
    });
    bail(provider);
    researchProvider = provider as string;
    const paperKind = await clack.select({
      message: "Research paper kind (sets the review rubric)",
      initialValue: opts.researchPaperKind ?? "survey",
      options: [
        { value: "survey", label: "Survey", hint: "coverage, evidence fidelity, synthesis, and clarity" },
        { value: "empirical", label: "Empirical", hint: "novelty, technical depth, and experimental validation" },
      ],
    });
    bail(paperKind);
    researchPaperKind = paperKind as string;
    const workflowProfile = await clack.select({
      message: "Research workflow breadth",
      initialValue: opts.researchWorkflowProfile ?? "standard",
      options: [
        { value: "fast", label: "Fast", hint: "smaller corpus; skips optional snowballing and venue upgrades" },
        { value: "standard", label: "Standard", hint: "evidence-backed default with publication gates" },
        { value: "deep", label: "Deep", hint: "flagship corpus expansion, venue upgrades, and structure audit" },
      ],
    });
    bail(workflowProfile);
    researchWorkflowProfile = workflowProfile as string;
  }

  const reviewCadence = await clack.select({
    message: "Review cadence (when should pending approvals surface?)",
    initialValue: opts.reviewCadence ?? "manual",
    options: [
      { value: "manual", label: "Manual", hint: "the run pauses; you inspect and approve when ready" },
      { value: "daily", label: "Daily", hint: "print a review agenda at a fixed time; never auto-approves" },
      { value: "interval", label: "Interval", hint: "print a review agenda every N hours; never auto-approves" },
    ],
  });
  bail(reviewCadence);

  let reviewTime = opts.reviewTime;
  let reviewIntervalHours = opts.reviewIntervalHours;
  if (reviewCadence === "daily") {
    const time = await clack.text({
      message: "Daily review time (HH:MM)",
      initialValue: opts.reviewTime ?? "08:00",
      validate: (v) => (/^\d{2}:\d{2}$/.test(v ?? "") ? undefined : "Use HH:MM, e.g. 08:00"),
    });
    bail(time);
    reviewTime = time as string;
  } else if (reviewCadence === "interval") {
    const hours = await clack.text({
      message: "Review interval in hours",
      initialValue: opts.reviewIntervalHours ?? "4",
      validate: (v) => (/^\d+$/.test(v ?? "") && Number(v) > 0 ? undefined : "Positive integer"),
    });
    bail(hours);
    reviewIntervalHours = hours as string;
  }

  const batchApprovals = await clack.confirm({
    message: "Batch approvals? (approve all pending gates at once during review)",
    initialValue: opts.batchApprovals ?? true,
  });
  bail(batchApprovals);

  clack.outro("Scaffolding workspace…");

  return {
    ...opts,
    mode: mode as string,
    topic: (topic as string).trim(),
    researchProvider,
    researchPaperKind,
    researchWorkflowProfile,
    targetLengthWords: (targetLengthWords as string).trim() || undefined,
    audience: (audience as string).trim() || undefined,
    genre: (genre as string).trim() || undefined,
    style: (style as string).trim() || undefined,
    runtimeProfile: runtimeProfile === "default" ? undefined : runtimeProfile as string,
    reviewCadence: reviewCadence as string,
    reviewTime,
    reviewIntervalHours,
    batchApprovals: batchApprovals as boolean,
  };
}

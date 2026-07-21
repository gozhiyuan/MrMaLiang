# Paper Profiles

LongWrite has one agentic research-paper workflow:
`auto_research_agentic`. A paper profile is a small, declarative policy layer
inside that shared workflow. It does not create a separate mode, copy the
MalaClaw stage graph, or bypass evidence and release validation.

`research.paper_kind` and `research.paper_profile` solve different problems:

| Setting | Decides |
| --- | --- |
| `paper_kind: survey | empirical` | The review rubric and whether audited experiment results are required. |
| `paper_profile` | The artifact that organizes the paper and the corresponding defaults/contracts. |

The registered profiles are:

| Profile | Organizing artifact | Default scope |
| --- | --- | --- |
| `literature_survey` | Scholarly literature | Deep, 24,000 words, 60-page release target. |
| `repository_study` | A pinned local/Git repository plus scholarly context | Standard, 10,000 words, codebase evidence and an architecture diagram. |

## What a profile owns

The registry in [`src/lib/paper-profiles.ts`](../src/lib/paper-profiles.ts)
owns the values that should change together when the paper's organizing
artifact changes:

- workflow breadth and target length;
- publication/corpus/bibliography and figure/table defaults;
- whether a pinned codebase is required;
- required visual IDs and architecture-diagram source/title rules; and
- short prompt overlays for outlining, drafting, visual planning, and artifact
  planning.

The compiler reads this contract to add profile-specific instructions to the
same outline, evidence, artifact-plan, drafting, rendering, review, and
release stages. Validators read it again to verify the generated output. The
LLM chooses the intellectual artifacts; the profile only defines the bounded
evidence contract that makes those choices releasable.

## What remains shared

All profiles retain the agentic research pipeline: LLM search planning,
scripted recall/deduplication/metadata enrichment, semantic abstract screening,
source-evidence packets, outline review, drafting from the evidence ledger,
declarative figure specifications, multi-persona review, and release gates.

Codebase inputs and optional GitHub discovery are capability modules, not
profiles. A literature survey may cite a pinned repository as supplementary
evidence; a repository study makes that evidence central. An empirical paper
can use either profile, but it still needs a separately audited LongExperiment
result artifact before it may claim empirical findings.

## Adding a profile

Add one entry to `PAPER_PROFILE_IDS` and its `PaperProfile` contract. Do not
fork `auto_research_agentic.yaml` unless the new artifact needs genuinely new
execution stages. If it does, add a bounded capability module with explicit
inputs, outputs, and validators, then compose it from the compiler. This keeps
future profiles—such as a benchmark or dataset study—from duplicating the
trusted research pipeline.

For concrete repository configuration, read the [Repository Study Paper
Flagship Guide](../../../docs/flagships/repository-survey.md).

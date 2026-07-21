# Templates

`maliang template list` is the authoritative catalog. Its definitions live in
[`apps/maliang/templates/catalog.yaml`](../apps/maliang/templates/catalog.yaml).
Paper templates are parameterized: a repository is an optional evidence input,
not a separate mode and never an implicit request to execute code.

## Public paper templates

| Template | Required input | Optional input | Components | Result |
| --- | --- | --- | --- | --- |
| `paper.survey` | Topic | Explicit repository, bounded GitHub discovery, original-paper/reference links | LongWrite | Literature or repository survey; no experiment |
| `paper.empirical` | Topic and hypothesis | Repository; `--experiment-authoring agentic|prescribed` | LongExperiment + LongWrite | Newly executed and audited experiment paper |
| `paper.empirical-import` | Topic and audited manifest handoff | Repository | LongWrite | Empirical paper from verified existing results |

The initializer resolves `--repository` or `--discover-repositories` to
repository evidence internally. Discovery-only surveys must select at least one
eligible candidate before the evidence pipeline can continue. For
an empirical run it also pins the same immutable revision into LongExperiment;
LongWrite rejects the handoff if the trials and manuscript analyze different
commits. Without `--repository`, the survey uses literature evidence and the
experiment uses a from-scratch profile.

`paper.empirical` defaults to agentic authoring. Pass
`--experiment-authoring prescribed` when a human supplies the protocol and
runner. `paper.empirical-import` accepts no authoring mode because it executes
nothing.

## Other product templates

| Template | LongWrite | LongExperiment | Result |
| --- | --- | --- | --- |
| `writing.novel` | yes | no | Novel workspace |
| `writing.technical-book` | yes | no | Technical-book workspace |
| `experiment.standalone` | no | yes | Audited experiment suite without a manuscript |
| `experiment.nanogpt-ablation` | no | yes | Incubating prescribed nanoGPT protocol |
| `experiment.self-play-small-model` | no | yes | Incubating prescribed self-play protocol |
| `experiment.proteingym-autoscientists` | no | yes | Incubating external-runner protocol |

MrMaLiang still records four resolved axes in `maliang.yaml`: paper kind,
evidence profile, experiment source, and—for new runs—experiment authoring.
Workspace validation rejects impossible or tampered combinations. See the root
[three public paper modes](../README.md#three-public-paper-modes).

Figures, README claims, aggregate scores, or an upstream experimental paper do
not constitute an importable experiment bundle. Use `paper.survey`, cite the
original paper, and attribute its reported results. Import requires the strict
manifest, per-trial, comparison, provenance, revision, checksum, and artifact
contract produced by LongExperiment or a compatible audited adapter.

The [flagship hub](./flagships/README.md) contains two validated survey
flagships and two agentic empirical release candidates. The three standalone
prescribed experiment protocols remain incubating examples: they are useful
contract fixtures, but they are not promoted as scientific flagship runs.
Remote prescribed execution must follow [Remote GPU with Modal](./remote-gpu-modal.md).

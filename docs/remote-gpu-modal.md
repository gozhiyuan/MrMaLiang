# Remote GPU with Modal

Modal is optional. Literature and repository surveys do not need it, and every
LongExperiment suite may instead use a reviewed local or other-provider
executor. Use Modal when the approved runner genuinely needs a remote GPU.

The Nanochat and self-play **agentic empirical-paper** blueprints use the
generalized remote-job contract for candidate tests, smoke comparisons, and
full studies. Their scaffold includes the reviewed, workspace-owned Modal
Sandbox adapter at `experiment/templates/adapters/modal/`. It preserves the
same immutable candidate and handles `candidate_test`, `candidate_smoke`, and
`study` phases through submit/status/collect/cancel. It never falls back to a
local generated-code command.

## Account and authentication

1. Create a Modal account and verify a current client without modifying the
   global Python environment:

   ```bash
   uvx --python 3.12 modal setup
   uvx --python 3.12 modal token info
   ```

2. For unattended execution, create a service-user token and provide
   `MODAL_TOKEN_ID` and `MODAL_TOKEN_SECRET` only through the launcher
   environment or a secrets manager. Never put either value in a workspace,
   YAML config, paper, archive, or Git history.

3. Start with a separate Modal development environment/profile. Do not put a
   token, secret, `.env` file, or credentials in a generated experiment
   workspace. The adapter uses Modal's normal authenticated client and never
   serializes credentials into a MalaClaw state file or result artifact.

Modal's current onboarding and token instructions are authoritative:
[getting started](https://modal.com/docs/guide),
[token commands](https://modal.com/docs/cli/latest/token), and
[service users](https://modal.com/docs/guide/service-users).

## MrMaLiang adapter contract

LongExperiment does not invoke `modal run --detach` directly. A workspace-owned
adapter uses a Modal Sandbox plus a per-job Volume so MalaClaw can durably
submit, poll, collect, and cancel the same remote job after restart. The Volume
contains an isolated snapshot of the experiment workspace and the runner copies
only the declared artifacts back after a successful job:

```yaml
runner:
  kind: modal
  app_path: templates/adapters/modal/agentic_adapter.py
  function_ref: modal_sandbox.run_phase
  gpu: A10G
  max_gpu_hours: 12
  adapter_command: uv run --project templates/adapters/modal python templates/adapters/modal/agentic_adapter.py
```

The adapter receives the JSON lifecycle request on standard input and implements
`submit`, `status`, `logs`, `collect`, and `cancel`. `collect` may write a
study's `raw-results.json` only after every declared artifact is present. The
adapter creates an isolated Sandbox per stage; Modal selects the requested GPU
for that job rather than reserving hardware ahead of time.

Before issuing an unattended lease, verify the copied adapter in the new
workspace:

```bash
cd <workspace>/experiment
uv sync --project templates/adapters/modal --python 3.12
uv run --project templates/adapters/modal python -m unittest discover \
  -s templates/adapters/modal/tests -v
```

The unit test is intentionally provider-fake and spends no Modal compute. The
first live action must be one bounded single-seed GPU smoke, not a full study.

### Shared runtime catalog and Nanochat overlay

Normal contributors do **not** build or publish images. The workspace includes
a versioned `templates/adapters/modal/runtime-catalog.yaml`; its `gpu-base-v1`
profile pins a shared CUDA/PyTorch image and `nanochat-gpu-v1` adds a trusted,
cached overlay that checks out the pinned Nanochat source and runs
`uv sync --extra gpu --frozen`. The template selects the profile, so the first
Modal run builds the cached overlay and later runs reuse it automatically.

The adapter records the catalog profile, recipe SHA-256, base image digest,
Nanochat commit, GPU model, CUDA/PyTorch versions, and declared tokenizer/data
snapshots in each remote study result and the audited experiment manifest.
The snapshot fields default to `undeclared`; a real pilot must replace them
with the actual tokenizer and dataset/shard-manifest identifiers during design
review. They are provenance, never provider credentials.

Platform maintainers may optionally prebuild the same recipe into a registry
image to reduce cold-start time. The checked-in [Dockerfile](../packages/longexperiment/templates/adapters/modal/images/nanochat-gpu/Dockerfile)
and [build script](../packages/longexperiment/templates/adapters/modal/images/nanochat-gpu/build-image.sh)
exist only for that maintenance operation. If a maintainer exports
`MALIANG_MODAL_BASE_IMAGE` with the resulting immutable `@sha256` digest, the
adapter uses it directly; ordinary users do not set it.

Do not put provider tokens, registry credentials, or a workspace `.env` in
Git. The agent may drive approved research stages after Modal authentication,
but cannot authenticate Modal, publish a runtime, bypass a lease, or alter a
pinned profile/recipe.

After a run's artifacts have been copied and audited locally, inspect the
per-job `maliang-*` Modal Volume and remove it according to your retention
policy. Successful `collect` now deletes the transient Volume only after every
declared artifact is copied; a failed collection retains it for retry and the
adapter's `cleanup` operation deletes it after cancellation. Volumes are not an
archival source of truth.

## Cost controls

`max_gpu_hours` is an authorization cap, not a forecast. Keep it consistent
with `execution.max_parallel_trials` and `execution.max_active_run_minutes`.
The adapter caps each Sandbox at the smaller of those wall-time and GPU-hour
limits (and Modal's 24-hour Sandbox maximum). Stop on the first failed smoke,
inspect the job and collected logs, then resume only with approval.

Check [Modal's live pricing](https://modal.com/pricing) immediately before an
authorization. GPU, storage, CPU, egress, model/API, and external-runner costs
are separate; no static price table in this repository is an approval source.

For the first Nanochat live validation, approve only a single explicitly
configured Sandbox with a short timeout and a concrete maximum cost in the
lease. A full study needs a separate authorization after its smoke artifacts
and actual provider charges have been reviewed.

The repository includes a disposable five-minute Nanochat GPU kernel smoke. It
pins Nanochat, performs a tiny CUDA forward/backward pass, creates no model
checkpoint or dataset, and deletes its temporary Volume after collection:

```bash
cd <workspace>/experiment
uv run --project templates/adapters/modal \
  python templates/adapters/modal/nanochat_modal_smoke.py --execute
```

It is a provider-and-runtime check, not a training result. Use a separate,
explicit approval and lease for any empirical Nanochat training run.

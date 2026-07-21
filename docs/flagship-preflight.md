# Flagship Preflight

MrMaLiang never fabricates experiment results and does not launch remote GPU work merely because an empirical template exists. Before a real flagship, configure the runner, pin every input, review cost limits, then run:

```bash
maliang preflight <workspace>
```

For a real experiment-backed paper, the required sequence is:

1. Initialize an empirical template and choose the target repository or public benchmark.
2. For `prescribed` authoring, configure a reviewed local, AutoScientists, or remote-job adapter. For `agentic` authoring, retain the schema-validated Python candidate contract and local worker environment.
3. Pin code, model, and benchmark revisions; for repository studies, ensure the candidate revision matches the LongWrite repository snapshot.
4. Set trial, parallelism, runtime, candidate-revision, and (when applicable) remote-GPU limits in `experiment/experiment.yaml`.
5. Pass `maliang preflight`, review the literature-grounded design, and release its explicit approval gate.
6. Review every generated candidate file before releasing its tests/smoke stage. Use a dedicated worker or container; path validation is not an OS sandbox.
7. Review candidate tests and one-seed smoke output, then separately approve full trials.
8. Inspect the result audit, then rerun `maliang run` to perform the verified handoff and start manuscript work.

The nanoGPT and self-play empirical-paper blueprints are executable agentic
release candidates, not precomputed demonstrations. Their real results require
the documented inputs, local executor environment, approvals, and compute. The
older prescribed nanoGPT, self-play, and ProteinGym protocols remain incubating
contract examples. A successful dry-run, fake-runner test, or scaffold is never
presented as a scientific result.

## Environment matrix

| Run type | Required operator setup | Optional / conditional setup |
| --- | --- | --- |
| Long survey | Node 22, MalaClaw, selected writing/research runtime, LaTeX/PDF tools | `GITHUB_TOKEN` for higher GitHub discovery limits |
| Repository survey | Survey requirements, Git, reachable pinned repository, license/attribution review | `GITHUB_TOKEN` for discovery or private repository access |
| nanoGPT agentic paper | Python/PyTorch, pinned nanoGPT/data inputs, design, code-execution, and full-trial approvals | Dedicated local CUDA worker/container; agentic remote execution is not automatic |
| Self-play agentic paper | Python/model access, fixed prompts/evaluator/heldout split, design, code-execution, and full-trial approvals | Dedicated local CUDA worker/container; model/API costs must be separately budgeted |
| Prescribed ProteinGym/AutoScientists | Pinned inputs, reviewed launcher, assay/data access | Reviewed Modal adapter and upstream AutoScientists credentials |

Run `maliang preflight <workspace>` after every runner or pin change. For a
Modal-backed experiment, complete [Remote GPU with Modal](./remote-gpu-modal.md)
and set a concrete `max_gpu_hours` before the design approval.

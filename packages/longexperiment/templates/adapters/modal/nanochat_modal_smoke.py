#!/usr/bin/env python3
"""Run one bounded Nanochat GPU kernel smoke through the Modal job adapter.

This is an operator rehearsal, not a training run or an empirical result.  It
checks the real provider lifecycle (submit/status/collect/cancel), the pinned
Nanochat source, CUDA availability, and a tiny Nanochat GPT forward/backward
pass.  The transient Volume is deleted after verified collection; failures
request cancellation and explicit cleanup.
"""
from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import tempfile
import time
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parent
ADAPTER = ROOT / "agentic_adapter.py"
NANOCHAT_REVISION = "92d63d4e8bb4df75c3b71618f31ddde2378b2bcd"
DEFAULT_IMAGE = ""
OUTPUTS = [
    "agent/smoke-results.json",
    "reports/metrics.json",
    "reports/agentic-readiness.md",
    "logs/agent-candidate-smoke.log",
    "artifacts/smoke/smoke/pinned-baseline/7/nanochat-kernel-smoke.json",
    "artifacts/smoke/smoke/agent-candidate/7/nanochat-kernel-smoke.json",
]


def response_for(workspace: Path, operation: str, job_id: str | None = None) -> dict[str, Any]:
    value: dict[str, Any] = {"version": 1, "operation": operation, "workspace": str(workspace), "unit_key": "nanochat-kernel-smoke", "outputs": OUTPUTS}
    if job_id:
        value["job"] = {"jobId": job_id}
    return value


def adapter_call(workspace: Path, operation: str, environment: dict[str, str], job_id: str | None = None) -> dict[str, Any]:
    completed = subprocess.run(
        [sys.executable, str(ADAPTER)], input=json.dumps(response_for(workspace, operation, job_id)),
        text=True, capture_output=True, env=environment, check=False,
    )
    if completed.returncode:
        raise RuntimeError(f"adapter {operation} crashed: {completed.stderr[-2000:]}")
    row: dict[str, Any] | None = None
    # Modal may emit image-build progress before the adapter's final protocol
    # line.  The adapter response remains the last JSON object with a status.
    for line in reversed(completed.stdout.splitlines()):
        try:
            candidate = json.loads(line)
        except json.JSONDecodeError:
            continue
        if isinstance(candidate, dict) and isinstance(candidate.get("status"), str):
            row = candidate
            break
    if row is None:
        raise RuntimeError(f"adapter {operation} returned no structured response: {completed.stdout[-2000:]}")
    if row.get("status") == "failed":
        provider_error = str(row.get("provider_stderr") or row.get("provider_stdout") or "")[-2000:]
        raise RuntimeError(f"adapter {operation} failed: {row.get('message')}\n{provider_error}")
    return row


def write_workspace(workspace: Path) -> None:
    (workspace / "agent" / "candidate" / "project").mkdir(parents=True)
    (workspace / "inputs").mkdir()
    (workspace / "experiment.yaml").write_text("""\
version: 1
project: {id: nanochat-modal-kernel-smoke}
profile: existing_code
authoring: {mode: agentic, entrypoint: maliang_runner.py, require_tests: false}
inputs:
  code:
    - {id: nanochat, source: https://github.com/karpathy/nanochat.git, revision: 92d63d4e8bb4df75c3b71618f31ddde2378b2bcd, license: MIT}
evaluation: {primary_metric: validation_bits_per_byte, direction: minimize, baseline_id: pinned-baseline, control: "provider kernel smoke only; no training result", seeds: [7], statistical_test: not-applicable}
suite: {id: smoke, studies: [{id: smoke, kind: training_ablation, conditions: [pinned-baseline, agent-candidate], acceptance_criteria: ["verify CUDA and a tiny pinned Nanochat kernel"]}]}
runner: {kind: modal, app_path: templates/adapters/modal/agentic_adapter.py, function_ref: modal_sandbox.run_phase, gpu: A10G, runtime_profile: nanochat-gpu-v1, max_gpu_hours: 1, adapter_command: "uv run --project templates/adapters/modal python templates/adapters/modal/agentic_adapter.py"}
execution: {max_trials: 2, max_active_run_minutes: 5, max_parallel_trials: 1, requires_design_approval: false, requires_revision_approval: false}
""", encoding="utf-8")
    (workspace / "inputs" / "locks.json").write_text(json.dumps({"version": 1, "inputs": [{"id": "nanochat", "revision": NANOCHAT_REVISION}]}), encoding="utf-8")
    (workspace / "agent" / "candidate-test.json").write_text(json.dumps({"version": 1, "pass": True}), encoding="utf-8")
    (workspace / "agent" / "validated-proposal.json").write_text(json.dumps({"baseline_condition": "pinned-baseline", "treatment_conditions": ["agent-candidate"], "seeds": [7]}), encoding="utf-8")
    (workspace / "agent" / "candidate" / "manifest.json").write_text(json.dumps({"status": "materialized", "files": [{"path": "maliang_runner.py"}]}), encoding="utf-8")
    (workspace / "agent" / "candidate" / "project" / "maliang_runner.py").write_text(f'''\
import json
import os
import subprocess
import sys
from pathlib import Path

REVISION = "{NANOCHAT_REVISION}"
checkout = Path("/opt/nanochat")
if not checkout.exists():
    checkout = Path("/tmp/nanochat")
    subprocess.run(["git", "clone", "https://github.com/karpathy/nanochat.git", str(checkout)], check=True)
subprocess.run(["git", "-C", str(checkout), "checkout", "--detach", REVISION], check=True)
sys.path.insert(0, str(checkout))
import torch
from nanochat.gpt import GPT, GPTConfig

if not torch.cuda.is_available():
    raise RuntimeError("CUDA is unavailable in the requested Modal GPU Sandbox")
device = torch.device("cuda")
config = GPTConfig(sequence_len=16, vocab_size=256, n_layer=2, n_head=1, n_kv_head=1, n_embd=64, window_pattern="L")
with torch.device("meta"):
    model = GPT(config)
model.to_empty(device=device)
model.init_weights()
tokens = torch.randint(0, config.vocab_size, (1, 16), device=device)
_logits = model(tokens)
loss = model(tokens, targets=tokens)
loss.backward()
torch.cuda.synchronize()
artifact = Path(os.environ["LONGEXPERIMENT_ARTIFACT_DIR"]) / "nanochat-kernel-smoke.json"
artifact = Path(os.environ["LONGEXPERIMENT_WORKSPACE"]) / artifact
artifact.parent.mkdir(parents=True, exist_ok=True)
artifact.write_text(json.dumps({{"nanochat_revision": REVISION, "gpu": torch.cuda.get_device_name(0), "cuda": torch.version.cuda, "loss": float(loss.detach().cpu()), "shape": list(_logits.shape)}}) + "\\n")
print(json.dumps({{"protocol": 1, "status": "completed", "metrics": {{"validation_bits_per_byte": 0.0}}, "artifacts": [str(artifact.relative_to(Path(os.environ["LONGEXPERIMENT_WORKSPACE"]))) ]}}))
''', encoding="utf-8")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--execute", action="store_true", help="Confirm the real paid Modal GPU action")
    parser.add_argument("--image", default=DEFAULT_IMAGE, help="Optional immutable maintainer-prebuilt image override")
    parser.add_argument("--poll-seconds", type=int, default=10)
    options = parser.parse_args()
    if not options.execute:
        raise SystemExit("Refusing to launch a paid Sandbox without --execute")
    if options.poll_seconds < 2 or options.poll_seconds > 30:
        raise SystemExit("--poll-seconds must be between 2 and 30")
    environment = {
        **os.environ,
        "LONGEXPERIMENT_REMOTE_PHASE": "candidate_smoke",
        **({"MALIANG_MODAL_BASE_IMAGE": options.image} if options.image else {}),
        "MALIANG_NANOCHAT_TOKENIZER_SNAPSHOT": "kernel-smoke-not-used",
        "MALIANG_NANOCHAT_DATA_SNAPSHOT": "kernel-smoke-not-used",
    }
    job_id: str | None = None
    with tempfile.TemporaryDirectory(prefix="maliang-nanochat-modal-smoke-") as temporary:
        workspace = Path(temporary)
        write_workspace(workspace)
        try:
            submitted = adapter_call(workspace, "submit", environment)
            job_id = str(submitted["job_id"])
            print(f"submitted disposable Modal job {job_id}", flush=True)
            deadline = time.monotonic() + 300
            while True:
                state = adapter_call(workspace, "status", environment, job_id)
                if state["status"] != "running":
                    break
                if time.monotonic() >= deadline:
                    raise TimeoutError("smoke exceeded the five-minute provider timeout")
                time.sleep(options.poll_seconds)
            if state["status"] != "succeeded":
                raise RuntimeError(f"Modal smoke did not succeed: {state.get('message')}")
            collected = adapter_call(workspace, "collect", environment, job_id)
            if collected["status"] != "succeeded":
                raise RuntimeError(f"Modal smoke collection did not succeed: {collected.get('message')}")
            artifacts = [json.loads((workspace / output).read_text(encoding="utf-8")) for output in OUTPUTS if output.endswith("nanochat-kernel-smoke.json")]
            print(json.dumps({"status": "succeeded", "message": "Nanochat GPU kernel smoke completed; transient Sandbox finished and Volume was deleted.", "artifacts": artifacts}, indent=2))
        except Exception as error:
            if job_id:
                try:
                    adapter_call(workspace, "cancel", environment, job_id)
                finally:
                    adapter_call(workspace, "cleanup", environment, job_id)
            print(json.dumps({"status": "failed", "message": str(error), "job_id": job_id}), file=sys.stderr, flush=True)
            raise


if __name__ == "__main__":
    main()

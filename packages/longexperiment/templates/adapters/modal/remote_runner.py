#!/usr/bin/env python3
"""Execute one bounded LongExperiment phase inside a Modal Sandbox.

This file deliberately contains the execution semantics rather than accepting a
shell string from the control plane.  The only executable entrypoint is the
schema-validated candidate, and phase determines the finite operation allowed.
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path
from typing import Any

import yaml


ROOT = Path("/workspace")


def runtime_provenance() -> dict[str, str]:
    """Collect only declared, non-secret runtime identifiers for the manifest."""
    record = {
        "provider": "modal-sandbox",
        "runtime_profile": os.environ.get("MALIANG_RUNTIME_PROFILE", "unconfigured"),
        "runtime_recipe_sha256": os.environ.get("MALIANG_RUNTIME_RECIPE_SHA256", "unconfigured"),
        "modal_image_digest": os.environ.get("MALIANG_MODAL_IMAGE_DIGEST", "unconfigured"),
        "nanochat_revision": os.environ.get("MALIANG_NANOCHAT_REVISION", "not-applicable"),
        "nanochat_tokenizer_snapshot": os.environ.get("MALIANG_NANOCHAT_TOKENIZER_SNAPSHOT", "not-applicable"),
        "nanochat_data_snapshot": os.environ.get("MALIANG_NANOCHAT_DATA_SNAPSHOT", "not-applicable"),
    }
    try:
        import torch
        record.update({
            "pytorch_version": str(torch.__version__),
            "cuda_version": str(torch.version.cuda or "none"),
            "gpu_model": str(torch.cuda.get_device_name(0)) if torch.cuda.is_available() else "none",
        })
    except Exception:
        record.update({"pytorch_version": "unavailable", "cuda_version": "unavailable", "gpu_model": "unavailable"})
    return record


def write_json(relative: str, value: object) -> None:
    target = ROOT / relative
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(json.dumps(value, indent=2) + "\n", encoding="utf-8")


def safe_artifact(value: object) -> str:
    if not isinstance(value, str) or not value or value.startswith("/") or ".." in Path(value).parts:
        raise ValueError(f"unsafe artifact path: {value!r}")
    return value


def last_response(stdout: str, primary_metric: str) -> tuple[float, list[str]]:
    lines = [line.strip() for line in stdout.splitlines() if line.strip()]
    if not lines:
        raise ValueError("candidate produced no JSON result")
    row = json.loads(lines[-1])
    metrics = row.get("metrics", {}) if isinstance(row, dict) else {}
    metric = metrics.get(primary_metric) if isinstance(metrics, dict) else None
    if not isinstance(metric, (int, float)):
        metric = row.get("metric") if isinstance(row, dict) else None
    if not isinstance(metric, (int, float)):
        raise ValueError(f"candidate response omits finite {primary_metric}")
    artifacts = row.get("artifacts", []) if isinstance(row, dict) else []
    if not isinstance(artifacts, list):
        raise ValueError("candidate artifacts must be an array")
    checked = [safe_artifact(item) for item in artifacts]
    for artifact in checked:
        if not (ROOT / artifact).is_file():
            raise ValueError(f"candidate declared missing artifact: {artifact}")
    return float(metric), checked


def candidate_env(request: dict[str, Any], smoke: bool) -> dict[str, str]:
    env = {"PATH": os.environ.get("PATH", ""), "HOME": str(ROOT / "agent" / "runtime-home")}
    env.update({key: value for key, value in os.environ.items() if key.startswith(("CUDA_", "OMP_", "MKL_", "OPENBLAS_"))})
    env.update({
        "LONGEXPERIMENT_WORKSPACE": str(ROOT),
        "LONGEXPERIMENT_STUDY_ID": request["study_id"],
        "LONGEXPERIMENT_CONDITION": request["condition"],
        "LONGEXPERIMENT_SEED": str(request["seed"]),
        "LONGEXPERIMENT_SMOKE": "1" if smoke else "0",
        "LONGEXPERIMENT_ARTIFACT_DIR": request["artifact_dir"],
        "LONGEXPERIMENT_PRIMARY_METRIC": request["primary_metric"],
        "LONGEXPERIMENT_PROTOCOL_REQUEST": json.dumps(request, separators=(",", ":")),
    })
    return env


def run_candidate(config: dict[str, Any], study_id: str, condition: str, seed: int, smoke: bool) -> tuple[float, list[str], str]:
    authoring = config["authoring"]
    evaluation = config["evaluation"]
    project = ROOT / "agent" / "candidate" / "project"
    artifact_dir = f"artifacts/{'smoke' if smoke else 'trials'}/{study_id}/{condition}/{seed}"
    (ROOT / artifact_dir).mkdir(parents=True, exist_ok=True)
    request = {
        "protocol": 1,
        "operation": "run_trial",
        "study_id": study_id,
        "condition": condition,
        "seed": seed,
        "primary_metric": evaluation["primary_metric"],
        "artifact_dir": artifact_dir,
    }
    process = subprocess.run(
        [sys.executable, authoring["entrypoint"]], cwd=project,
        env=candidate_env(request, smoke), text=True, capture_output=True, check=False,
    )
    transcript = f"$ {sys.executable} {authoring['entrypoint']}\n{process.stdout}{process.stderr}"
    if process.returncode:
        raise RuntimeError(f"candidate exited {process.returncode}: {transcript[-4000:]}")
    metric, artifacts = last_response(process.stdout, evaluation["primary_metric"])
    return metric, artifacts, transcript


def load_config() -> dict[str, Any]:
    config = yaml.safe_load((ROOT / "experiment.yaml").read_text(encoding="utf-8"))
    if not isinstance(config, dict) or config.get("authoring", {}).get("mode") != "agentic":
        raise ValueError("Modal adapter requires an agentic experiment.yaml")
    if not isinstance(config.get("evaluation"), dict):
        raise ValueError("Modal adapter requires an evaluation contract")
    return config


def run_candidate_tests(config: dict[str, Any]) -> None:
    project = ROOT / "agent" / "candidate" / "project"
    manifest = json.loads((ROOT / "agent" / "candidate" / "manifest.json").read_text(encoding="utf-8"))
    passed = manifest.get("status") == "materialized"
    transcript: list[str] = []
    if passed:
        python_files = [entry["path"] for entry in manifest.get("files", []) if str(entry.get("path", "")).endswith(".py")]
        for command in ([sys.executable, "-m", "py_compile", *python_files], [sys.executable, "-m", "unittest", "discover", "-s", ".", "-p", "test_*.py"]):
            if len(command) == 4 and not config["authoring"].get("require_tests", True):
                continue
            process = subprocess.run(command, cwd=project, env=candidate_env({"study_id": "candidate-test", "condition": "candidate", "seed": 0, "artifact_dir": "artifacts/tests", "primary_metric": config["evaluation"]["primary_metric"]}, False), text=True, capture_output=True, check=False)
            transcript.append("$ " + " ".join(command) + "\n" + process.stdout + process.stderr)
            if process.returncode:
                passed = False
                break
    else:
        transcript.append("candidate bundle did not pass materialization validation")
    (ROOT / "logs").mkdir(parents=True, exist_ok=True)
    (ROOT / "logs" / "agent-candidate-tests.log").write_text("\n".join(transcript) + "\n", encoding="utf-8")
    write_json("agent/candidate-test.json", {"version": 1, "pass": passed, "log": "logs/agent-candidate-tests.log"})
    if not passed:
        raise RuntimeError("candidate tests failed")


def run_smoke(config: dict[str, Any]) -> None:
    test = json.loads((ROOT / "agent" / "candidate-test.json").read_text(encoding="utf-8"))
    proposal = json.loads((ROOT / "agent" / "validated-proposal.json").read_text(encoding="utf-8"))
    rows: list[dict[str, Any]] = []
    transcripts: list[str] = []
    if test.get("pass"):
        for condition in [proposal["baseline_condition"], proposal["treatment_conditions"][0]]:
            try:
                metric, _artifacts, log = run_candidate(config, "smoke", condition, proposal["seeds"][0], True)
                rows.append({"condition": condition, "seed": proposal["seeds"][0], "metric": metric})
                transcripts.append(log)
            except Exception as error:  # retain a scientific failure as evidence
                rows.append({"condition": condition, "seed": proposal["seeds"][0], "error": str(error)})
                transcripts.append(f"{condition}: {error}")
    passed = bool(test.get("pass")) and len(rows) == 2 and all("metric" in row for row in rows)
    (ROOT / "logs").mkdir(parents=True, exist_ok=True)
    (ROOT / "logs" / "agent-candidate-smoke.log").write_text("\n".join(transcripts) + "\n", encoding="utf-8")
    write_json("agent/smoke-results.json", {"version": 1, "pass": passed, "rows": rows, "runtime": runtime_provenance()})
    write_json("reports/metrics.json", {"experiment_readiness": 1 if passed else 0})
    (ROOT / "reports" / "agentic-readiness.md").write_text("# Agentic Experiment Readiness\n\nStatus: " + ("ready for approved trials" if passed else "candidate revision required") + "\n", encoding="utf-8")
    if not passed:
        failures = "; ".join(str(row["error"]) for row in rows if "error" in row)
        raise RuntimeError(f"candidate smoke failed: {failures or 'missing baseline or treatment result'}")


def run_study(config: dict[str, Any], study_id: str) -> None:
    study = next((item for item in config.get("suite", {}).get("studies", []) if item.get("id") == study_id), None)
    if not isinstance(study, dict):
        raise ValueError(f"unknown study {study_id}")
    trials: list[dict[str, Any]] = []
    logs: list[str] = []
    for condition in study["conditions"]:
        for seed in config["evaluation"]["seeds"]:
            metric, artifacts, transcript = run_candidate(config, study_id, condition, seed, False)
            log_path = f"logs/studies/{study_id}/{condition}-{seed}.log"
            target = ROOT / log_path
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text(transcript, encoding="utf-8")
            logs.append(log_path)
            trials.append({"id": f"{study_id}-{condition}-{seed}", "seed": seed, "condition": condition, "status": "completed", "metrics": {config["evaluation"]["primary_metric"]: metric}, "artifacts": artifacts})
    locks = json.loads((ROOT / "inputs" / "locks.json").read_text(encoding="utf-8"))
    raw = {
        "version": 1, "study_id": study_id, "status": "completed", "trials": trials,
        "runner_version": "modal-sandbox-agentic-v1",
        "input_revisions": {item["id"]: item["revision"] for item in locks.get("inputs", [])},
        "environment": {"authoring": "agentic", "entrypoint": config["authoring"]["entrypoint"], **runtime_provenance()},
        "artifacts": {"tables": [], "figures": [], "logs": logs},
    }
    write_json(f"results/studies/{study_id}/raw-results.json", raw)
    combined = ROOT / "logs" / "studies" / study_id / "runner.log"
    combined.parent.mkdir(parents=True, exist_ok=True)
    combined.write_text("\n".join((ROOT / item).read_text(encoding="utf-8") for item in logs), encoding="utf-8")


def main() -> None:
    phase = os.environ.get("LONGEXPERIMENT_REMOTE_PHASE")
    if phase not in {"candidate_test", "candidate_smoke", "study"}:
        raise ValueError("LONGEXPERIMENT_REMOTE_PHASE must be candidate_test, candidate_smoke, or study")
    config = load_config()
    if phase == "candidate_test":
        run_candidate_tests(config)
    elif phase == "candidate_smoke":
        run_smoke(config)
    else:
        study_id = os.environ.get("LONGEXPERIMENT_STUDY_ID")
        if not study_id:
            raise ValueError("LONGEXPERIMENT_STUDY_ID is required for a study")
        run_study(config, study_id)


if __name__ == "__main__":
    main()

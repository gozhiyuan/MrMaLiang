#!/usr/bin/env python3
"""MalaClaw remote-job adapter backed by a Modal Sandbox and Volume.

The control plane sends one JSON request on stdin.  This adapter creates one
isolated Sandbox per unit, persists a combined Sandbox/Volume handle, and only
reports success after declared outputs are copied back into the local workspace.
Credentials remain entirely inside Modal's normal local profile or environment.
"""
from __future__ import annotations

import asyncio
import hashlib
import inspect
import json
import os
import shutil
import sys
import tempfile
import time
import re
from pathlib import Path
from typing import Any

import yaml

from models import ModalJob, PHASES, RemoteRequest, safe_relative


ADAPTER_ID = "modal-sandbox-v1"
ROOT = Path(__file__).resolve().parent
EXCLUDED = {".git", ".venv", "node_modules", "dist", "build", "__pycache__", ".malaclaw", ".env"}
OCI_DIGEST = re.compile(r"^.+@sha256:[0-9a-f]{64}$")
RUNTIME_CATALOG = ROOT / "runtime-catalog.yaml"


def response(status: str, job_id: str, message: str, **extra: Any) -> None:
    print(json.dumps({"version": 1, "status": status, "job_id": job_id, "adapter": ADAPTER_ID, "message": message, **extra}, sort_keys=True))


def fail(error: Exception) -> None:
    response("failed", "modal-adapter-error", str(error))


def load_config(workspace: Path) -> dict[str, Any]:
    config = yaml.safe_load((workspace / "experiment.yaml").read_text(encoding="utf-8"))
    runner = config.get("runner", {}) if isinstance(config, dict) else {}
    if not isinstance(config, dict) or runner.get("kind") != "modal":
        raise ValueError("experiment.yaml must select the modal runner")
    return config


def modal_module() -> Any:
    try:
        import modal
        return modal
    except ImportError as error:
        raise RuntimeError("Modal SDK is missing; run `uv sync` in templates/adapters/modal") from error


def phase() -> str:
    value = os.environ.get("LONGEXPERIMENT_REMOTE_PHASE")
    if value not in PHASES:
        raise ValueError("LONGEXPERIMENT_REMOTE_PHASE must be candidate_test, candidate_smoke, or study")
    return value


def gpu_name(value: str) -> str:
    # LongExperiment's historical config spelling is A10G; Modal's current
    # Sandbox API calls that accelerator A10.
    return {"A10G": "A10"}.get(value, value)


def snapshot_workspace(source: Path) -> tempfile.TemporaryDirectory[str]:
    temporary = tempfile.TemporaryDirectory(prefix="maliang-modal-upload-")
    destination = Path(temporary.name) / "workspace"

    def ignore(directory: str, names: list[str]) -> set[str]:
        ignored = {name for name in names if name in EXCLUDED or name.endswith(".pyc")}
        # Never upload provider credentials or local dotenv material, even if
        # an operator accidentally places it under the workspace.
        ignored.update(name for name in names if name.startswith(".env"))
        return ignored

    shutil.copytree(source, destination, ignore=ignore, symlinks=False)
    return temporary


def app_and_volume(modal: Any, workspace: Path, config: dict[str, Any], unit_key: str) -> tuple[Any, Any, str]:
    runner = config["runner"]
    project_id = str(config.get("project", {}).get("id", "experiment"))
    digest = hashlib.sha256(f"{workspace.resolve()}:{unit_key}:{time.time_ns()}".encode()).hexdigest()[:16]
    label = f"maliang-{project_id}-{digest}"[:63]
    environment = runner.get("environment")
    app = modal.App.lookup(f"maliang-{project_id}", environment_name=environment, create_if_missing=True)
    volume = modal.Volume.from_name(label, environment_name=environment, create_if_missing=True)
    return app, volume, label


def upload(volume: Any, workspace: Path) -> None:
    with snapshot_workspace(workspace) as temporary:
        staged = Path(temporary) / "workspace"
        with volume.batch_upload() as batch:
            # The Volume is mounted at /workspace, so upload the snapshot's
            # contents to the Volume root rather than nesting it one level
            # deeper as /workspace/workspace.
            batch.put_directory(staged, "/")
            batch.put_file(ROOT / "remote_runner.py", "/.maliang-modal/remote_runner.py")


def nanochat_revision(config: dict[str, Any]) -> str | None:
    code = config.get("inputs", {}).get("code", []) if isinstance(config.get("inputs"), dict) else []
    for item in code:
        if isinstance(item, dict) and item.get("id") == "nanochat":
            revision = item.get("revision")
            if isinstance(revision, str) and revision:
                return revision
    return None


def resolve_runtime(config: dict[str, Any]) -> tuple[Any, dict[str, str]]:
    """Resolve a maintained shared profile, then build its cached Modal overlay.

    An optional immutable OCI override is for platform maintainers that have
    prebuilt the exact catalog recipe. Normal contributors need no registry.
    """
    catalog = yaml.safe_load(RUNTIME_CATALOG.read_text(encoding="utf-8"))
    profiles = catalog.get("profiles", {}) if isinstance(catalog, dict) else {}
    runner = config["runner"]
    profile_id = runner.get("runtime_profile", "gpu-base-v1")
    profile = profiles.get(profile_id) if isinstance(profiles, dict) else None
    if not isinstance(profile, dict):
        raise ValueError(f"unknown Modal runtime profile: {profile_id}")
    merged: dict[str, Any] = dict(profile)
    parent_id = profile.get("extends")
    if parent_id:
        parent = profiles.get(parent_id) if isinstance(profiles, dict) else None
        if not isinstance(parent, dict):
            raise ValueError(f"runtime profile {profile_id} has unknown parent {parent_id}")
        merged = {**parent, **profile}
        merged["python_packages"] = [*(parent.get("python_packages", [])), *(profile.get("python_packages", []))]
        merged["system_packages"] = [*(parent.get("system_packages", [])), *(profile.get("system_packages", []))]
    base = os.environ.get("MALIANG_MODAL_BASE_IMAGE", merged.get("base_image"))
    if not isinstance(base, str) or not OCI_DIGEST.fullmatch(base):
        raise ValueError("Modal runtime catalog and overrides must use immutable OCI @sha256 image digests")
    revision = nanochat_revision(config)
    source = merged.get("source")
    if source and revision and source.get("revision") != revision:
        raise ValueError(f"runtime profile {profile_id} is pinned to a different Nanochat revision")
    recipe = json.dumps({"profile": profile_id, "base": base, "overlay": merged}, sort_keys=True, separators=(",", ":"))
    provenance = {
        "MALIANG_RUNTIME_PROFILE": str(profile_id),
        "MALIANG_RUNTIME_RECIPE_SHA256": hashlib.sha256(recipe.encode()).hexdigest(),
        "MALIANG_MODAL_IMAGE_DIGEST": base,
        "MALIANG_NANOCHAT_REVISION": revision or "not-applicable",
        "MALIANG_NANOCHAT_TOKENIZER_SNAPSHOT": os.environ.get("MALIANG_NANOCHAT_TOKENIZER_SNAPSHOT", "undeclared"),
        "MALIANG_NANOCHAT_DATA_SNAPSHOT": os.environ.get("MALIANG_NANOCHAT_DATA_SNAPSHOT", "undeclared"),
    }
    return merged, provenance


def make_image(modal: Any, runtime: dict[str, Any], provenance: dict[str, str]) -> Any:
    image = modal.Image.from_registry(provenance["MALIANG_MODAL_IMAGE_DIGEST"])
    if os.environ.get("MALIANG_MODAL_BASE_IMAGE"):
        return image
    packages = runtime.get("system_packages", [])
    if packages:
        image = image.apt_install(*packages)
    python_packages = runtime.get("python_packages", [])
    if python_packages:
        image = image.pip_install(*python_packages)
    commands = runtime.get("commands", [])
    if commands:
        image = image.run_commands(*commands)
    environment = runtime.get("environment", {})
    if environment:
        image = image.env(environment)
    return image


def submit(request: RemoteRequest) -> None:
    workspace = Path(request.workspace).resolve()
    config = load_config(workspace)
    modal = modal_module()
    app, volume, label = app_and_volume(modal, workspace, config, request.unit_key)
    upload(volume, workspace)
    runner = config["runner"]
    runtime, provenance = resolve_runtime(config)
    maximum = min(int(config.get("execution", {}).get("max_active_run_minutes", 480) * 60), int(runner["max_gpu_hours"] * 3600), 24 * 3600)
    sandbox_env = {"LONGEXPERIMENT_REMOTE_PHASE": phase(), **provenance}
    # Study work is selected by the compiled workflow. Forward only that
    # bounded identifier; never copy the operator's whole environment into the
    # Sandbox, where it could carry credentials or unrelated configuration.
    if os.environ.get("LONGEXPERIMENT_STUDY_ID"):
        sandbox_env["LONGEXPERIMENT_STUDY_ID"] = os.environ["LONGEXPERIMENT_STUDY_ID"]
    sandbox = modal.Sandbox.create(
        "python", "/workspace/.maliang-modal/remote_runner.py",
        app=app,
        image=make_image(modal, runtime, provenance),
        environment_name=runner.get("environment"),
        gpu=gpu_name(str(runner["gpu"])),
        env=sandbox_env,
        timeout=maximum,
        workdir="/workspace",
        volumes={"/workspace": volume},
    )
    job = ModalJob(sandbox_id=sandbox.object_id, volume_id=volume.object_id)
    sandbox.detach()
    response("queued", job.serialize(), f"submitted {phase()} Sandbox {label}", retry_after_seconds=15)


def existing_job(request: RemoteRequest) -> tuple[Any, ModalJob, Any]:
    modal = modal_module()
    job = ModalJob.parse(request.job_id or "")
    return modal, job, modal.Sandbox.from_id(job.sandbox_id)


def status(request: RemoteRequest) -> None:
    _modal, job, sandbox = existing_job(request)
    returncode = sandbox.poll()
    if returncode is None:
        response("running", job.serialize(), "Sandbox is still running", retry_after_seconds=20)
    elif returncode == 0:
        response("succeeded", job.serialize(), "Sandbox completed; collecting declared artifacts")
    elif returncode == 137:
        response("cancelled", job.serialize(), "Sandbox was terminated")
    else:
        response(
            "failed", job.serialize(), f"Sandbox exited {returncode}",
            provider_stdout=stream_tail(sandbox.stdout), provider_stderr=stream_tail(sandbox.stderr),
        )
    sandbox.detach()


def copy_from_volume(volume: Any, source: str, destination: Path) -> None:
    safe_relative(source, "output")
    destination.parent.mkdir(parents=True, exist_ok=True)
    temporary = destination.with_name(f".{destination.name}.modal-partial")
    with temporary.open("wb") as handle:
        for chunk in volume.read_file(f"/{source}"):
            handle.write(chunk)
    temporary.replace(destination)


def delete_volume(volume: Any) -> None:
    """Delete a transient job Volume after its outputs are safely collected.

    Modal 1.x exposes deletion on the hydrated instance as an async method but
    does not yet publish a stable class-level delete API.  Keep the isolated
    compatibility boundary here so we fail closed instead of silently retaining
    paid storage indefinitely.
    """
    deletion = getattr(volume, "_instance_delete", None)
    if not callable(deletion):
        raise RuntimeError("installed Modal SDK cannot delete a transient Volume; upgrade Modal before a cleanup-required run")
    result = deletion()
    if inspect.isawaitable(result):
        asyncio.run(result)


def stream_tail(stream: Any, limit: int = 4000) -> str:
    """Read a completed Sandbox stream without leaking unbounded provider logs."""
    value = stream.read()
    if inspect.isawaitable(value):
        value = asyncio.run(value)
    return str(value)[-limit:]


def collect(request: RemoteRequest) -> None:
    modal, job, sandbox = existing_job(request)
    returncode = sandbox.poll()
    sandbox.detach()
    if returncode is None:
        response("running", job.serialize(), "Sandbox is still running", retry_after_seconds=20)
        return
    if returncode != 0:
        response("cancelled" if returncode == 137 else "failed", job.serialize(), f"Sandbox exited {returncode}; outputs were not collected")
        return
    volume = modal.Volume.from_id(job.volume_id)
    workspace = Path(request.workspace).resolve()
    for output in request.outputs:
        copy_from_volume(volume, output, workspace / output)
    delete_volume(volume)
    response("succeeded", job.serialize(), f"collected {len(request.outputs)} declared artifact(s) and deleted the transient Volume")


def cancel(request: RemoteRequest) -> None:
    _modal, job, sandbox = existing_job(request)
    sandbox.terminate()
    sandbox.detach()
    response("cancelled", job.serialize(), "Sandbox termination requested")


def cleanup(request: RemoteRequest) -> None:
    modal = modal_module()
    job = ModalJob.parse(request.job_id or "")
    volume = modal.Volume.from_id(job.volume_id)
    delete_volume(volume)
    response("cancelled", job.serialize(), "deleted the transient Volume after cancellation or failed collection")


def logs(request: RemoteRequest) -> None:
    # MalaClaw currently persists its adapter stdout in its normal stage log.
    # The phase runner also writes declared log artifacts that `collect` copies
    # back. Keep the operation available for direct diagnostics without leaking
    # unbounded provider output through a workflow-state field.
    _modal, job, sandbox = existing_job(request)
    returncode = sandbox.poll()
    details: dict[str, Any] = {}
    if returncode is not None:
        details = {"provider_stdout": stream_tail(sandbox.stdout), "provider_stderr": stream_tail(sandbox.stderr)}
    sandbox.detach()
    response("running" if returncode is None else "succeeded" if returncode == 0 else "failed", job.serialize(), "Use declared collected log artifacts for full provider output", **details)


def main() -> None:
    try:
        raw = json.loads(sys.stdin.read())
        request = RemoteRequest.parse(raw)
        operations = {"submit": submit, "status": status, "logs": logs, "collect": collect, "cancel": cancel, "cleanup": cleanup}
        operations[request.operation](request)
    except Exception as error:
        fail(error)


if __name__ == "__main__":
    main()

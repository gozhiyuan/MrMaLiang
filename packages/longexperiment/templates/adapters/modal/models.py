"""Small, dependency-free validation models for the Modal adapter protocol."""
from __future__ import annotations

from dataclasses import dataclass
from pathlib import PurePosixPath
from typing import Any, Mapping


OPERATIONS = frozenset({"submit", "status", "logs", "collect", "cancel", "cleanup"})
PHASES = frozenset({"candidate_test", "candidate_smoke", "study"})


def safe_relative(value: object, label: str) -> str:
    if not isinstance(value, str) or not value or "\x00" in value:
        raise ValueError(f"{label} must be a non-empty path")
    path = PurePosixPath(value.replace("\\", "/"))
    if path.is_absolute() or ".." in path.parts:
        raise ValueError(f"{label} must be workspace-relative")
    return path.as_posix()


@dataclass(frozen=True)
class RemoteRequest:
    operation: str
    workspace: str
    unit_key: str
    outputs: tuple[str, ...]
    job_id: str | None

    @classmethod
    def parse(cls, raw: Mapping[str, Any]) -> "RemoteRequest":
        if raw.get("version") != 1:
            raise ValueError("adapter request version must be 1")
        operation = raw.get("operation")
        if operation not in OPERATIONS:
            raise ValueError(f"unsupported adapter operation: {operation!r}")
        workspace = raw.get("workspace")
        unit_key = raw.get("unit_key")
        outputs = raw.get("outputs", [])
        if not isinstance(workspace, str) or not workspace:
            raise ValueError("workspace is required")
        if not isinstance(unit_key, str) or not unit_key:
            raise ValueError("unit_key is required")
        if not isinstance(outputs, list):
            raise ValueError("outputs must be an array")
        job = raw.get("job") or {}
        job_id = job.get("jobId") if isinstance(job, Mapping) else None
        if job_id is not None and (not isinstance(job_id, str) or not job_id):
            raise ValueError("job.jobId must be a non-empty string")
        if operation != "submit" and not job_id:
            raise ValueError(f"{operation} requires a persisted job id")
        return cls(operation, workspace, unit_key, tuple(safe_relative(item, "output") for item in outputs), job_id)


@dataclass(frozen=True)
class ModalJob:
    sandbox_id: str
    volume_id: str

    def serialize(self) -> str:
        return f"{self.sandbox_id}|{self.volume_id}"

    @classmethod
    def parse(cls, value: str) -> "ModalJob":
        sandbox_id, separator, volume_id = value.partition("|")
        if not separator or not sandbox_id or not volume_id:
            raise ValueError("invalid Modal job id; expected sandbox-id|volume-id")
        return cls(sandbox_id=sandbox_id, volume_id=volume_id)

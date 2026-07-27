"""Versioned runner request/response contract with legacy env compatibility."""
from __future__ import annotations

import json
import os
from dataclasses import asdict, dataclass, field
from typing import Any, Mapping


def _relative(value: str) -> str:
    if not value or value.startswith(("/", "\\")) or ".." in value.replace("\\", "/").split("/"):
        raise ValueError("artifact_dir and artifacts must be workspace-relative")
    return value


@dataclass(frozen=True)
class RunTrialRequest:
    protocol: int
    operation: str
    study_id: str
    condition: str
    seed: int
    primary_metric: str
    artifact_dir: str

    @classmethod
    def from_mapping(cls, value: Mapping[str, Any]) -> "RunTrialRequest":
        if value.get("protocol") != 1 or value.get("operation") != "run_trial":
            raise ValueError("expected protocol: 1 and operation: run_trial")
        request = cls(1, "run_trial", str(value["study_id"]), str(value["condition"]), int(value["seed"]), str(value["primary_metric"]), _relative(str(value["artifact_dir"])))
        if not request.study_id or not request.condition or not request.primary_metric or request.seed < 0:
            raise ValueError("invalid run_trial request")
        return request


@dataclass(frozen=True)
class CompletedResponse:
    metrics: Mapping[str, float]
    artifacts: list[str] = field(default_factory=list)

    def to_mapping(self) -> dict[str, Any]:
        if not self.metrics or not all(isinstance(value, (int, float)) for value in self.metrics.values()):
            raise ValueError("metrics must contain finite numeric values")
        return {"protocol": 1, "status": "completed", "metrics": dict(self.metrics), "artifacts": [_relative(item) for item in self.artifacts]}


def read_request(environ: Mapping[str, str] | None = None) -> RunTrialRequest:
    env = os.environ if environ is None else environ
    raw = env.get("LONGEXPERIMENT_PROTOCOL_REQUEST")
    if raw:
        return RunTrialRequest.from_mapping(json.loads(raw))
    # One-minor-release fallback for existing Python runner templates.
    return RunTrialRequest.from_mapping({"protocol": 1, "operation": "run_trial", "study_id": env.get("LONGEXPERIMENT_STUDY_ID", ""), "condition": env.get("LONGEXPERIMENT_CONDITION", ""), "seed": env.get("LONGEXPERIMENT_SEED", ""), "primary_metric": env.get("LONGEXPERIMENT_PRIMARY_METRIC", ""), "artifact_dir": env.get("LONGEXPERIMENT_ARTIFACT_DIR", "")})


def emit_completed(metrics: Mapping[str, float], artifacts: list[str] | None = None) -> None:
    print(json.dumps(CompletedResponse(metrics, artifacts or []).to_mapping(), sort_keys=True))

"""Bounded API-evaluation helper.

Network transport is injected by the caller so this module never holds provider
credentials. Every completed record preserves provider/model identity, prompt
and raw-response hashes, retries, seed, and token usage.
"""

from __future__ import annotations

from dataclasses import asdict, dataclass
from datetime import datetime, timezone
from hashlib import sha256
from typing import Any, Callable, Mapping


def _hash(value: str) -> str:
    return "sha256:" + sha256(value.encode("utf-8")).hexdigest()


@dataclass(frozen=True)
class ApiEvaluationRecord:
    version: int
    provider: str
    model: str
    model_version: str | None
    observed_at: str
    prompt_template_hash: str
    raw_response_hash: str
    retries: int
    seed: int
    token_usage: Mapping[str, int]
    output: str

    def json(self) -> dict[str, Any]:
        return asdict(self)


def evaluate_api_call(
    *,
    provider: str,
    model: str,
    prompt_template: str,
    seed: int,
    invoke: Callable[[str, int], Mapping[str, Any]],
    max_retries: int = 2,
) -> ApiEvaluationRecord:
    """Execute one bounded call using an injected transport.

    The injected transport receives the prompt and seed and returns output plus
    optional model_version and token_usage. It may raise transient failures;
    no more than max_retries retries are attempted.
    """
    if not provider or not model:
        raise ValueError("provider and model are required")
    if max_retries < 0:
        raise ValueError("max_retries must be nonnegative")
    retries = 0
    while True:
        try:
            response = invoke(prompt_template, seed)
            output = response.get("output")
            if not isinstance(output, str):
                raise ValueError("transport response must contain string output")
            usage = response.get("token_usage", {})
            if not isinstance(usage, Mapping) or any(not isinstance(value, int) or value < 0 for value in usage.values()):
                raise ValueError("token_usage must map names to nonnegative integers")
            model_version = response.get("model_version")
            if model_version is not None and not isinstance(model_version, str):
                raise ValueError("model_version must be a string when supplied")
            return ApiEvaluationRecord(
                version=1,
                provider=provider,
                model=model,
                model_version=model_version,
                observed_at=datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
                prompt_template_hash=_hash(prompt_template),
                raw_response_hash=_hash(output),
                retries=retries,
                seed=seed,
                token_usage=dict(usage),
                output=output,
            )
        except Exception:
            if retries >= max_retries:
                raise
            retries += 1

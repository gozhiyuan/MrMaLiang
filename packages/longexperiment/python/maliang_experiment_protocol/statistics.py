"""Deterministic scientific helpers mirrored by the TypeScript auditor.

The explicit xorshift seed intentionally makes every bootstrap interval
reproducible across a runner, notebook, and the final TypeScript audit.
"""
from __future__ import annotations

import json
import sys
from typing import Iterable


def _mean(values: list[float]) -> float:
    # Accumulate naively, one addition at a time, to mirror the TypeScript
    # auditor's `Array.prototype.reduce` bit-for-bit.
    #
    # Do NOT replace this with `sum()`. CPython 3.12+ gives `sum()` a Neumaier
    # compensated-summation fast path for floats, so `sum([0.3, 0.3, 0.3, 0.2])`
    # returns 1.1 where a naive loop returns 1.0999999999999999. That one-ULP
    # difference propagates through the bootstrap percentile and makes a
    # published confidence bound depend on the interpreter version: identical
    # inputs produce 0.275 on Python >=3.12 and 0.27499999999999997 on <=3.11.
    # TypeScript owns the final audit boundary, so Python mirrors TypeScript.
    total = 0.0
    for value in values:
        total += value
    return total / len(values)


def _percentile(values: list[float], q: float) -> float:
    ordered = sorted(values)
    return ordered[max(0, min(len(ordered) - 1, int(q * (len(ordered) - 1))))]


def deterministic_paired_bootstrap(deltas: Iterable[float], repeats: int = 2000) -> dict[str, float]:
    values = [float(value) for value in deltas]
    if not values or repeats < 1:
        raise ValueError("deltas and repeats must be non-empty")
    state = 0x9E3779B9
    samples: list[float] = []
    for _ in range(repeats):
        sample: list[float] = []
        for _ in values:
            state ^= (state << 13) & 0xFFFFFFFF
            state ^= state >> 17
            state ^= (state << 5) & 0xFFFFFFFF
            state &= 0xFFFFFFFF
            random = (state % 1_000_000) / 1_000_000
            sample.append(values[int(random * len(values))])
        samples.append(_mean(sample))
    return {"lower": _percentile(samples, 0.025), "upper": _percentile(samples, 0.975)}


if __name__ == "__main__":
    payload = json.load(sys.stdin)
    print(json.dumps(deterministic_paired_bootstrap(payload["deltas"], int(payload.get("repeats", 2000))), sort_keys=True))

#!/usr/bin/env python3
"""Plot LongWrite's deterministic sources-per-publication-year CSV.

This module is copied verbatim into a generated workspace as
scripts/plot_source_years.py. It deliberately has no LongWrite runtime
dependency: only the workspace-relative CSV and matplotlib are required.
"""

import csv
import pathlib

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt


def main() -> None:
    """Render the source-year plot beside the figure source data."""
    root = pathlib.Path(__file__).resolve().parent.parent
    with (root / "data" / "source-years.csv").open(newline="", encoding="utf-8") as source_file:
        rows = list(csv.DictReader(source_file))
    years = [int(row["year"]) for row in rows]
    counts = [int(row["count"]) for row in rows]
    positions = list(range(len(years)))
    tick_step = max(1, (len(years) + 9) // 10)
    tick_positions = sorted(set(positions[::tick_step] + ([positions[-1]] if positions else [])))

    fig, axis = plt.subplots(figsize=(8, 4.5))
    axis.bar(positions, counts, color="#2563eb")
    axis.set_xticks(tick_positions, [str(years[index]) for index in tick_positions], rotation=45, ha="right")
    axis.tick_params(axis="x", labelsize=8)
    axis.set_title("Sources by publication year")
    axis.set_xlabel("Year")
    axis.set_ylabel("Sources")
    fig.tight_layout(pad=1.2)
    fig.savefig(root / "figures" / "source-years-plot.png", dpi=150)


if __name__ == "__main__":
    main()

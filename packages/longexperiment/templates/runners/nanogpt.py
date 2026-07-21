#!/usr/bin/env python3
"""Run one declared nanoGPT study and normalize per-seed measurements.

The command is intentionally real rather than synthetic. Set
LONGEXPERIMENT_NANOGPT_MAX_ITERS for a small smoke run (the default is 5000);
candidate studies use the first configured candidate worktree when supplied.
"""
import json, os, pathlib, re, subprocess, sys

root = pathlib.Path(os.environ["LONGEXPERIMENT_WORKSPACE"])
study = os.environ["LONGEXPERIMENT_STUDY_ID"]
seeds = [int(s) for s in os.environ["LONGEXPERIMENT_SEEDS"].split(",") if s]
conditions = [s for s in os.environ["LONGEXPERIMENT_CONDITIONS"].split(",") if s]
result_path = root / os.environ["LONGEXPERIMENT_RESULT_PATH"]
locks = json.loads((root / "inputs/locks.json").read_text())
revisions = {entry["id"]: entry["revision"] for entry in locks["inputs"]}
worktrees = json.loads(os.environ.get("LONGEXPERIMENT_WORKTREES", "[]"))
candidate = next((item for item in worktrees if item.get("role") == "candidate"), None)
repo = root / (candidate["path"] if candidate and study == "candidate" else "inputs/nanogpt/repo")
if not (repo / "train.py").exists(): raise SystemExit(f"nanoGPT checkout is missing at {repo}; inspect inputs/locks.json")
subprocess.run([sys.executable, "data/shakespeare_char/prepare.py"], cwd=repo, check=True)
max_iters = os.environ.get("LONGEXPERIMENT_NANOGPT_MAX_ITERS", "5000")
trials, logs = [], []
for condition in conditions:
  for seed in seeds:
    log_rel = f"artifacts/trials/{study}-{condition}-{seed}.log"; log = root / log_rel; log.parent.mkdir(parents=True, exist_ok=True)
    out_dir = root / "runs" / "nanogpt" / study / condition / str(seed)
    cmd = [sys.executable, "train.py", "config/train_shakespeare_char.py", f"--seed={seed}", f"--out_dir={out_dir}", f"--max_iters={max_iters}"]
    completed = subprocess.run(cmd, cwd=repo, text=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
    log.write_text(completed.stdout)
    if completed.returncode: raise SystemExit(f"nanoGPT failed for {study}/{condition}/{seed}; see {log_rel}")
    losses = re.findall(r"val loss ([0-9.]+)", completed.stdout)
    if not losses: raise SystemExit(f"could not parse validation loss from {log_rel}")
    trials.append({"id": f"{study}-{condition}-{seed}", "seed": seed, "condition": condition, "status": "completed", "metrics": {"validation_loss": float(losses[-1])}, "artifacts": [log_rel]}); logs.append(log_rel)
result_path.parent.mkdir(parents=True, exist_ok=True)
result_path.write_text(json.dumps({"version": 1, "study_id": study, "status": "completed", "trials": trials, "runner_version": "nanogpt-train.py", "input_revisions": revisions, "environment": {"max_iters": max_iters}, "artifacts": {"tables": [], "figures": [], "logs": logs}}, indent=2) + "\n")

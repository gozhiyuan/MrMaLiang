#!/usr/bin/env python3
"""Run an explicitly configured Nanochat study and normalize its measurements.

This incubating runner deliberately does not guess a Nanochat training command:
the image, pinned checkout, tokenizer/data snapshots, and exact training command
must be reviewed together.  The command must emit one final JSON object with a
finite ``validation_bits_per_byte`` value (or ``metric``) for each invocation.
"""
import json, math, os, pathlib, subprocess

root = pathlib.Path(os.environ["LONGEXPERIMENT_WORKSPACE"])
study = os.environ["LONGEXPERIMENT_STUDY_ID"]
seeds = [int(s) for s in os.environ["LONGEXPERIMENT_SEEDS"].split(",") if s]
conditions = [s for s in os.environ["LONGEXPERIMENT_CONDITIONS"].split(",") if s]
result_path = root / os.environ["LONGEXPERIMENT_RESULT_PATH"]
locks = json.loads((root / "inputs/locks.json").read_text())
revisions = {entry["id"]: entry["revision"] for entry in locks["inputs"]}
command = os.environ.get("LONGEXPERIMENT_NANOCHAT_COMMAND")
if not command:
  raise SystemExit("Set LONGEXPERIMENT_NANOCHAT_COMMAND to a reviewed, pinned Nanochat launcher; this runner will not invent one.")
max_iters = os.environ.get("LONGEXPERIMENT_NANOCHAT_MAX_ITERS", "")
trials, logs = [], []
for condition in conditions:
  for seed in seeds:
    log_rel = f"artifacts/trials/{study}-{condition}-{seed}.log"; log = root / log_rel; log.parent.mkdir(parents=True, exist_ok=True)
    environment = {**os.environ, "LONGEXPERIMENT_NANOCHAT_SEED": str(seed), "LONGEXPERIMENT_NANOCHAT_CONDITION": condition, "LONGEXPERIMENT_NANOCHAT_STUDY": study, "LONGEXPERIMENT_NANOCHAT_RUN_DIR": str(root / "runs" / "nanochat" / study / condition / str(seed)), "LONGEXPERIMENT_NANOCHAT_MAX_ITERS": max_iters}
    completed = subprocess.run(command, cwd=root, env=environment, shell=True, text=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
    log.write_text(completed.stdout)
    if completed.returncode: raise SystemExit(f"Nanochat failed for {study}/{condition}/{seed}; see {log_rel}")
    try: payload = json.loads(next(line for line in reversed(completed.stdout.splitlines()) if line.strip().startswith("{")))
    except (StopIteration, json.JSONDecodeError) as error: raise SystemExit(f"Nanochat launcher must end with a JSON metric record; see {log_rel}") from error
    metric = payload.get("validation_bits_per_byte", payload.get("metric", (payload.get("metrics") or {}).get("validation_bits_per_byte")))
    if not isinstance(metric, (int, float)) or not math.isfinite(metric): raise SystemExit(f"Nanochat launcher returned no finite validation_bits_per_byte; see {log_rel}")
    trials.append({"id": f"{study}-{condition}-{seed}", "seed": seed, "condition": condition, "status": "completed", "metrics": {"validation_bits_per_byte": metric}, "artifacts": [log_rel]}); logs.append(log_rel)
result_path.parent.mkdir(parents=True, exist_ok=True)
result_path.write_text(json.dumps({"version": 1, "study_id": study, "status": "completed", "trials": trials, "runner_version": "nanochat-train.py", "input_revisions": revisions, "environment": {"max_iters": max_iters}, "artifacts": {"tables": [], "figures": [], "logs": logs}}, indent=2) + "\n")

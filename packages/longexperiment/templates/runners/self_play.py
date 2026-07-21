#!/usr/bin/env python3
"""Normalize a real self-play executor's per-seed JSON output.

Set LONGEXPERIMENT_SELF_PLAY_COMMAND to a command that writes one JSON object
per trial to stdout: {"metric": <finite number>, "artifacts": [<relative paths>]}.
The wrapper supplies study/seed/condition environment variables and refuses to
invent model results when the executor has not been configured.
"""
import json, os, pathlib, shlex, subprocess, sys
root = pathlib.Path(os.environ["LONGEXPERIMENT_WORKSPACE"]); study = os.environ["LONGEXPERIMENT_STUDY_ID"]
executor = os.environ.get("LONGEXPERIMENT_SELF_PLAY_COMMAND")
if not executor: raise SystemExit("Set LONGEXPERIMENT_SELF_PLAY_COMMAND to the reviewed self-play executor; LongExperiment will not synthesize results.")
locks = json.loads((root / "inputs/locks.json").read_text()); revisions = {e["id"]: e["revision"] for e in locks["inputs"]}
trials, logs = [], []
for condition in filter(None, os.environ["LONGEXPERIMENT_CONDITIONS"].split(",")):
  for seed_text in filter(None, os.environ["LONGEXPERIMENT_SEEDS"].split(",")):
    seed = int(seed_text); log_rel = f"artifacts/trials/{study}-{condition}-{seed}.log"; log = root / log_rel; log.parent.mkdir(parents=True, exist_ok=True)
    env = {**os.environ, "LONGEXPERIMENT_SEED": str(seed), "LONGEXPERIMENT_CONDITION": condition}; run = subprocess.run(executor, shell=True, text=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, env=env); log.write_text(run.stdout)
    if run.returncode: raise SystemExit(f"executor failed; see {log_rel}")
    try: row = json.loads(run.stdout.strip().splitlines()[-1]); metric = float(row["metric"])
    except Exception as exc: raise SystemExit(f"executor must end with JSON metric; see {log_rel}: {exc}")
    trials.append({"id": f"{study}-{condition}-{seed}", "seed": seed, "condition": condition, "status": "completed", "metrics": {"exact_match": metric}, "artifacts": [log_rel, *row.get("artifacts", [])]}); logs.append(log_rel)
result = root / os.environ["LONGEXPERIMENT_RESULT_PATH"]; result.parent.mkdir(parents=True, exist_ok=True); result.write_text(json.dumps({"version": 1, "study_id": study, "status": "completed", "trials": trials, "runner_version": "configured-self-play-executor", "input_revisions": revisions, "environment": {}, "artifacts": {"tables": [], "figures": [], "logs": logs}}, indent=2) + "\n")

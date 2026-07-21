#!/usr/bin/env python3
"""Normalize a reviewed AutoScientists/ProteinGym executor without controlling
AutoScientists' internal agent graph. Set LONGEXPERIMENT_AUTOSCIENTISTS_COMMAND
to emit the same terminal JSON contract as self_play.py, with a `metric`.
"""
import os, pathlib, runpy
os.environ["LONGEXPERIMENT_SELF_PLAY_COMMAND"] = os.environ.get("LONGEXPERIMENT_AUTOSCIENTISTS_COMMAND", "")
if not os.environ["LONGEXPERIMENT_SELF_PLAY_COMMAND"]: raise SystemExit("Set LONGEXPERIMENT_AUTOSCIENTISTS_COMMAND to the reviewed upstream launch command; results are never fabricated.")
source = pathlib.Path(__file__).with_name("self_play.py")
runpy.run_path(str(source), run_name="__main__")

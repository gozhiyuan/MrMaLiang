from __future__ import annotations

import importlib.util
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path

ADAPTER_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ADAPTER_DIR))
from models import ModalJob, RemoteRequest  # noqa: E402

spec = importlib.util.spec_from_file_location("agentic_adapter", ADAPTER_DIR / "agentic_adapter.py")
assert spec and spec.loader
adapter = importlib.util.module_from_spec(spec)
spec.loader.exec_module(adapter)
runner_spec = importlib.util.spec_from_file_location("remote_runner", ADAPTER_DIR / "remote_runner.py")
assert runner_spec and runner_spec.loader
remote_runner = importlib.util.module_from_spec(runner_spec)
runner_spec.loader.exec_module(remote_runner)


class FakeBatch:
    def __init__(self) -> None:
        self.directories: list[tuple[Path, str]] = []
        self.files: list[tuple[Path, str]] = []

    def __enter__(self): return self
    def __exit__(self, *_args): return False
    def put_directory(self, source, target): self.directories.append((Path(source), target))
    def put_file(self, source, target): self.files.append((Path(source), target))


class FakeVolume:
    object_id = "vo-test"
    def __init__(self) -> None:
        self.batch = FakeBatch()
        self.files = {"/reports/result.json": b'{"ok":true}\n'}
        self.deleted = False
    def batch_upload(self): return self.batch
    def read_file(self, path): return [self.files[path]]
    async def _instance_delete(self): self.deleted = True


class FakeSandbox:
    object_id = "sb-test"
    def __init__(self, returncode=None) -> None:
        self.returncode = returncode
        self.detached = False
        self.terminated = False
    def poll(self): return self.returncode
    def detach(self): self.detached = True
    def terminate(self): self.terminated = True; self.returncode = 137


class FakeModal:
    def __init__(self) -> None:
        self.volume = FakeVolume()
        self.sandbox = FakeSandbox()
        self.created: dict[str, object] | None = None
        outer = self
        class App:
            @staticmethod
            def lookup(*_args, **_kwargs): return object()
        class Volume:
            @staticmethod
            def from_name(*_args, **_kwargs): return outer.volume
            @staticmethod
            def from_id(value):
                assert value == "vo-test"
                return outer.volume
        class Sandbox:
            @staticmethod
            def create(*args, **kwargs): outer.created = {"args": args, **kwargs}; return outer.sandbox
            @staticmethod
            def from_id(value):
                assert value == "sb-test"
                return outer.sandbox
        class Image:
            @staticmethod
            def from_registry(_value): return Image()
            def apt_install(self, *_values): return self
            def pip_install(self, *_values): return self
            def run_commands(self, *_values): return self
            def env(self, _values): return self
        self.App, self.Volume, self.Sandbox, self.Image = App, Volume, Sandbox, Image


class AdapterTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory()
        self.workspace = Path(self.temp.name)
        (self.workspace / "experiment.yaml").write_text("""
project: {id: demo}
runner: {kind: modal, gpu: A10G, max_gpu_hours: 1, environment: development}
execution: {max_active_run_minutes: 10}
""", encoding="utf-8")
        self.fake = FakeModal()
        self.previous_modal = adapter.modal_module
        adapter.modal_module = lambda: self.fake
        self.previous_phase = os.environ.get("LONGEXPERIMENT_REMOTE_PHASE")
        os.environ["LONGEXPERIMENT_REMOTE_PHASE"] = "candidate_test"

    def tearDown(self) -> None:
        adapter.modal_module = self.previous_modal
        if self.previous_phase is None: os.environ.pop("LONGEXPERIMENT_REMOTE_PHASE", None)
        else: os.environ["LONGEXPERIMENT_REMOTE_PHASE"] = self.previous_phase
        self.temp.cleanup()

    def request(self, operation: str, job_id: str | None = None) -> RemoteRequest:
        row = {"version": 1, "operation": operation, "workspace": str(self.workspace), "unit_key": "unit", "outputs": ["reports/result.json"]}
        if job_id: row["job"] = {"jobId": job_id}
        return RemoteRequest.parse(row)

    def test_request_rejects_traversal_and_missing_persisted_handle(self) -> None:
        with self.assertRaisesRegex(ValueError, "workspace-relative"):
            RemoteRequest.parse({"version": 1, "operation": "submit", "workspace": "/tmp", "unit_key": "x", "outputs": ["../secret"]})
        with self.assertRaisesRegex(ValueError, "persisted job"):
            self.request("collect")
        self.assertEqual(ModalJob.parse("sb-test|vo-test").serialize(), "sb-test|vo-test")

    def test_submit_uses_a10_alias_and_volume_backed_sandbox(self) -> None:
        lines: list[str] = []
        previous = adapter.response
        adapter.response = lambda *args, **kwargs: lines.append(json.dumps({"args": args, "kwargs": kwargs}))
        try:
            adapter.submit(self.request("submit"))
        finally:
            adapter.response = previous
        self.assertIn("queued", lines[0])
        assert self.fake.created is not None
        self.assertEqual(self.fake.created["gpu"], "A10")
        self.assertEqual(self.fake.created["env"]["LONGEXPERIMENT_REMOTE_PHASE"], "candidate_test")
        self.assertEqual(self.fake.created["env"]["MALIANG_RUNTIME_PROFILE"], "gpu-base-v1")
        self.assertRegex(self.fake.created["env"]["MALIANG_RUNTIME_RECIPE_SHA256"], r"^[a-f0-9]{64}$")
        self.assertEqual(self.fake.created["volumes"], {"/workspace": self.fake.volume})
        self.assertEqual(self.fake.volume.batch.directories[0][1], "/")
        self.assertTrue(self.fake.sandbox.detached)

    def test_nanochat_resolves_the_shared_profile_and_rejects_revision_drift(self) -> None:
        config = {
            "inputs": {"code": [{"id": "nanochat", "revision": "a" * 40}]},
            "runner": {"runtime_profile": "nanochat-gpu-v1"},
        }
        # The catalog's Nanochat pin is deliberately different from this fake
        # revision, proving a template cannot silently run a mismatched source.
        with self.assertRaisesRegex(ValueError, "different Nanochat revision"):
            adapter.resolve_runtime(config)
        config["inputs"]["code"][0]["revision"] = "92d63d4e8bb4df75c3b71618f31ddde2378b2bcd"
        previous = os.environ.get("MALIANG_MODAL_BASE_IMAGE")
        try:
            os.environ.pop("MALIANG_MODAL_BASE_IMAGE", None)
            runtime, provenance = adapter.resolve_runtime(config)
            self.assertEqual(runtime["extends"], "gpu-base-v1")
            self.assertEqual(provenance["MALIANG_RUNTIME_PROFILE"], "nanochat-gpu-v1")
            self.assertEqual(provenance["MALIANG_NANOCHAT_REVISION"], "92d63d4e8bb4df75c3b71618f31ddde2378b2bcd")
        finally:
            if previous is None: os.environ.pop("MALIANG_MODAL_BASE_IMAGE", None)
            else: os.environ["MALIANG_MODAL_BASE_IMAGE"] = previous

    def test_collect_copies_only_declared_output_after_success(self) -> None:
        self.fake.sandbox.returncode = 0
        lines: list[str] = []
        previous = adapter.response
        adapter.response = lambda *args, **kwargs: lines.append(json.dumps({"args": args, "kwargs": kwargs}))
        try:
            adapter.collect(self.request("collect", "sb-test|vo-test"))
        finally:
            adapter.response = previous
        self.assertEqual((self.workspace / "reports" / "result.json").read_bytes(), b'{"ok":true}\n')
        self.assertIn("succeeded", lines[0])
        self.assertTrue(self.fake.volume.deleted)

    def test_cancel_terminates_the_persisted_sandbox(self) -> None:
        lines: list[str] = []
        previous = adapter.response
        adapter.response = lambda *args, **kwargs: lines.append(json.dumps({"args": args, "kwargs": kwargs}))
        try:
            adapter.cancel(self.request("cancel", "sb-test|vo-test"))
        finally:
            adapter.response = previous
        self.assertTrue(self.fake.sandbox.terminated)
        self.assertIn("cancelled", lines[0])

    def test_cleanup_deletes_retained_volume_after_failed_collection(self) -> None:
        lines: list[str] = []
        previous = adapter.response
        adapter.response = lambda *args, **kwargs: lines.append(json.dumps({"args": args, "kwargs": kwargs}))
        try:
            adapter.cleanup(self.request("cleanup", "sb-test|vo-test"))
        finally:
            adapter.response = previous
        self.assertTrue(self.fake.volume.deleted)
        self.assertIn("cancelled", lines[0])


class RemoteRunnerTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.previous_root = remote_runner.ROOT
        remote_runner.ROOT = self.root
        (self.root / "agent" / "candidate" / "project").mkdir(parents=True)
        (self.root / "inputs").mkdir()
        (self.root / "inputs" / "locks.json").write_text(json.dumps({"inputs": [{"id": "source", "revision": "a" * 40}]}), encoding="utf-8")
        (self.root / "experiment.yaml").write_text("""
authoring: {mode: agentic, entrypoint: maliang_runner.py, require_tests: true}
evaluation: {primary_metric: score, seeds: [7]}
suite:
  studies:
    - id: primary
      conditions: [baseline, candidate]
""", encoding="utf-8")
        (self.root / "agent" / "candidate" / "manifest.json").write_text(json.dumps({"status": "materialized", "files": [{"path": "maliang_runner.py"}, {"path": "test_runner.py"}]}), encoding="utf-8")
        (self.root / "agent" / "validated-proposal.json").write_text(json.dumps({"baseline_condition": "baseline", "treatment_conditions": ["candidate"], "seeds": [7]}), encoding="utf-8")
        (self.root / "agent" / "candidate" / "project" / "maliang_runner.py").write_text("""
import json, os
condition = os.environ['LONGEXPERIMENT_CONDITION']
print(json.dumps({'protocol': 1, 'status': 'completed', 'metrics': {'score': 2.0 if condition == 'candidate' else 1.0}, 'artifacts': []}))
""", encoding="utf-8")
        (self.root / "agent" / "candidate" / "project" / "test_runner.py").write_text("import unittest\nclass T(unittest.TestCase):\n def test_ok(self): self.assertTrue(True)\n", encoding="utf-8")

    def tearDown(self) -> None:
        remote_runner.ROOT = self.previous_root
        self.temp.cleanup()

    def test_candidate_test_smoke_and_study_materialize_the_declared_contracts(self) -> None:
        config = remote_runner.load_config()
        remote_runner.run_candidate_tests(config)
        remote_runner.run_smoke(config)
        remote_runner.run_study(config, "primary")
        self.assertTrue(json.loads((self.root / "agent" / "candidate-test.json").read_text())["pass"])
        self.assertTrue(json.loads((self.root / "agent" / "smoke-results.json").read_text())["pass"])
        raw = json.loads((self.root / "results" / "studies" / "primary" / "raw-results.json").read_text())
        self.assertEqual(len(raw["trials"]), 2)
        self.assertEqual(raw["environment"]["modal_image_digest"], "unconfigured")
        self.assertIn("pytorch_version", raw["environment"])
        self.assertTrue((self.root / "logs" / "studies" / "primary" / "runner.log").is_file())


if __name__ == "__main__":
    unittest.main()

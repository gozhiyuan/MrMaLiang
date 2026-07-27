import io
import json
import unittest
from contextlib import redirect_stdout

from maliang_experiment_protocol import emit_completed, read_request
from maliang_experiment_protocol.statistics import deterministic_paired_bootstrap


class ProtocolTest(unittest.TestCase):
    def test_reads_protocol_and_emits_final_response(self) -> None:
        request = read_request({"LONGEXPERIMENT_PROTOCOL_REQUEST": json.dumps({"protocol": 1, "operation": "run_trial", "study_id": "primary", "condition": "candidate", "seed": 23, "primary_metric": "validation_loss", "artifact_dir": "artifacts/trials/primary/candidate/23"})})
        self.assertEqual(request.seed, 23)
        stream = io.StringIO()
        with redirect_stdout(stream):
            emit_completed({"validation_loss": 1.234}, ["artifacts/trials/primary/candidate/23/metrics.json"])
        self.assertEqual(json.loads(stream.getvalue())["status"], "completed")

    def test_bootstrap_is_deterministic(self) -> None:
        self.assertEqual(deterministic_paired_bootstrap([0.2, 0.1], 20), deterministic_paired_bootstrap([0.2, 0.1], 20))
